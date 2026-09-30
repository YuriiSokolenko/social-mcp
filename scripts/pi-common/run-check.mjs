import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ruffArgs } from './ruff-spec.mjs';

/**
 * Backend-neutral focused verification for agents that have no unrestricted
 * shell. Requests are a closed, structured contract (never a command string);
 * results are bounded, machine-readable, and carry parsed diagnostics plus a
 * stdout/stderr tail so a failure is something the agent can debug from.
 *
 * This never replaces the authoritative validation in `product-checks.mjs`;
 * both use the repository-owned Ruff spec.
 */

export const CHECK_KINDS = Object.freeze(['python_compile', 'ruff', 'pytest', 'profile']);

const MAX_PATHS = 20;
const MAX_DIAGNOSTICS = 20;
const MAX_MESSAGE_CHARS = 400;
const TAIL_CHARS = 3000;
const CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;

// Only these variables reach a check subprocess: never the caller's token/secret environment.
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL'];

// Compiles in memory so a focused check never writes __pycache__ into the worktree.
const PYTHON_COMPILE_SCRIPT = [
  'import json, sys',
  'bad = 0',
  'for name in sys.argv[1:]:',
  '    try:',
  '        compile(open(name, "rb").read(), name, "exec")',
  '    except SyntaxError as e:',
  '        bad += 1',
  '        print(json.dumps({"file": name, "line": e.lineno, "column": e.offset, "message": e.msg}))',
  'sys.exit(1 if bad else 0)',
].join('\n');

/** Named repository profiles. Fixed argv only; no model-supplied text reaches a shell. */
export const PROFILES = Object.freeze({
  node_tests: (root) => ({
    command: 'node',
    args: ['--test', ...listFiles(path.join(root, 'tests'), /\.test\.mjs$/).map(f => path.relative(root, f))],
  }),
  pytest_all: () => ({ command: 'pytest', args: ['-q', '--tb=short', '-rfE', '--no-header', '-p', 'no:cacheprovider'] }),
});

function listFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => pattern.test(name)).sort().map(name => path.join(dir, name));
}

class InvalidCheck extends Error {}

function invalid(kind, message) {
  return {
    status: 'invalid',
    kind: typeof kind === 'string' ? kind : null,
    exit_code: null,
    duration_ms: 0,
    summary: message,
    diagnostics: [],
    stdout_tail: '',
    stderr_tail: '',
    truncated: false,
  };
}

function rejectUnknownFields(params, allowed) {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new InvalidCheck(`unsupported field "${key}"; allowed: ${allowed.join(', ')}`);
  }
}

function containedRelativePath(root, requested, { mustBeFile = false } = {}) {
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) {
    throw new InvalidCheck('path entries must be non-empty strings');
  }
  if (requested.startsWith('-')) throw new InvalidCheck(`path must not start with "-": ${requested}`);
  const worktree = fs.realpathSync(root);
  const absolute = path.resolve(worktree, requested);
  if (absolute !== worktree && !absolute.startsWith(`${worktree}${path.sep}`)) {
    throw new InvalidCheck(`path escapes the current worktree: ${requested}`);
  }
  if (!fs.existsSync(absolute)) throw new InvalidCheck(`path does not exist: ${requested}`);
  const real = fs.realpathSync(absolute);
  if (real !== worktree && !real.startsWith(`${worktree}${path.sep}`)) {
    throw new InvalidCheck(`path resolves outside the current worktree: ${requested}`);
  }
  if (mustBeFile && !fs.statSync(real).isFile()) throw new InvalidCheck(`path is not a file: ${requested}`);
  return path.relative(worktree, absolute) || '.';
}

function pathList(root, value, field, options) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PATHS) {
    throw new InvalidCheck(`${field} must be an array of 1-${MAX_PATHS} strings`);
  }
  return value.map(item => containedRelativePath(root, item, options));
}

function commandFor(root, params, bins) {
  switch (params.kind) {
    case 'python_compile': {
      rejectUnknownFields(params, ['kind', 'paths']);
      const files = pathList(root, params.paths, 'paths', { mustBeFile: true });
      if (files.some(file => !file.endsWith('.py'))) throw new InvalidCheck('python_compile accepts .py files only');
      return { command: bins.python, args: ['-c', PYTHON_COMPILE_SCRIPT, ...files] };
    }
    case 'ruff': {
      rejectUnknownFields(params, ['kind', 'paths']);
      const files = pathList(root, params.paths, 'paths');
      return { command: bins.ruff, args: ruffArgs(root, files, { json: true }) };
    }
    case 'pytest': {
      rejectUnknownFields(params, ['kind', 'targets']);
      if (!Array.isArray(params.targets) || params.targets.length < 1 || params.targets.length > MAX_PATHS) {
        throw new InvalidCheck(`targets must be an array of 1-${MAX_PATHS} strings`);
      }
      const targets = params.targets.map(target => {
        if (typeof target !== 'string') throw new InvalidCheck('targets must be strings');
        const [file, ...rest] = target.split('::');
        return [containedRelativePath(root, file), ...rest].join('::');
      });
      return {
        command: bins.pytest,
        args: ['-q', '--tb=short', '-rfE', '--no-header', '-p', 'no:cacheprovider', ...targets],
      };
    }
    case 'profile': {
      rejectUnknownFields(params, ['kind', 'profile']);
      const build = Object.hasOwn(PROFILES, params.profile) ? PROFILES[params.profile] : null;
      if (!build) throw new InvalidCheck(`unknown profile; allowed: ${Object.keys(PROFILES).join(', ')}`);
      const spec = build(root);
      return { ...spec, command: spec.command === 'pytest' ? bins.pytest : spec.command };
    }
    default:
      throw new InvalidCheck(`unknown check kind; allowed: ${CHECK_KINDS.join(', ')}`);
  }
}

function checkEnv(env) {
  const clean = { PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', HOME: '/tmp', TMPDIR: '/tmp' };
  for (const name of ENV_ALLOWLIST) if (env[name] != null) clean[name] = env[name];
  return clean;
}

/** No focused check runs without OS-enforced network and filesystem isolation. */
function isolatedCommand(root, spec) {
  const worktree = fs.realpathSync(root);
  if (process.platform === 'linux') {
    const args = ['--die-with-parent', '--unshare-user', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session'];
    for (const dir of ['/usr', '/bin', '/lib', '/lib64', '/opt']) {
      if (fs.existsSync(dir)) args.push('--ro-bind', dir, dir);
    }
    args.push('--dir', '/etc');
    for (const file of ['/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/ld.so.cache', '/etc/localtime']) {
      if (fs.existsSync(file)) args.push('--ro-bind', file, file);
    }
    args.push('--dev', '/dev', '--tmpfs', '/tmp');
    const ancestors = [];
    for (let parent = path.dirname(worktree); parent !== '/'; parent = path.dirname(parent)) ancestors.unshift(parent);
    for (const ancestor of ancestors) {
      if (ancestor !== '/tmp' && !['/usr', '/bin', '/lib', '/lib64', '/opt', '/etc'].includes(ancestor)) args.push('--dir', ancestor);
    }
    args.push('--bind', worktree, worktree, '--chdir', worktree, '--', spec.command, ...spec.args);
    return { command: 'bwrap', args };
  }
  if (process.platform === 'darwin') {
    // Keep the interpreter/toolchain readable while denying home credentials
    // and every network socket. The worktree is the sole exception in HOME.
    const home = os.homedir().replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const allowed = worktree.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const profile = `(version 1) (allow default) (deny network*) (deny file-read* (subpath "${home}")) (allow file-read* (subpath "${allowed}"))`;
    return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, spec.command, ...spec.args] };
  }
  return null;
}

function cap(text, limit) {
  const value = String(text ?? '');
  return { text: value.length > limit ? value.slice(-limit) : value, truncated: value.length > limit };
}

function shorten(text) {
  const value = String(text ?? '').trim();
  return value.length > MAX_MESSAGE_CHARS ? `${value.slice(0, MAX_MESSAGE_CHARS)}…` : value;
}

/** Bounded, deterministic subprocess run. Kills the whole process tree on timeout. */
function execute({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let dropped = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (name) => (data) => {
      chunks[name].push(data);
      sizes[name] += data.length;
      while (sizes[name] > CAPTURE_LIMIT_BYTES) {
        dropped = true;
        const excess = sizes[name] - CAPTURE_LIMIT_BYTES;
        const first = chunks[name][0];
        if (first.length <= excess) chunks[name].shift();
        else chunks[name][0] = first.subarray(excess);
        sizes[name] -= Math.min(first.length, excess);
      }
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);

    const finish = (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(); // reap any grandchildren that outlived the direct child
      resolve({
        exitCode,
        timedOut,
        dropped,
        spawnError,
        durationMs: Date.now() - started,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      });
    };
    child.once('error', error => finish(null, error));
    child.once('close', code => finish(code, null));
  });
}

function parseRuff(stdout) {
  try {
    const items = JSON.parse(stdout);
    if (!Array.isArray(items)) return null;
    return items.map(item => ({
      file: item.filename ?? null,
      line: item.location?.row ?? null,
      column: item.location?.column ?? null,
      code: item.code ?? null,
      message: shorten(item.message),
    }));
  } catch {
    return null;
  }
}

function parseCompile(stdout) {
  const diagnostics = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      diagnostics.push({
        file: item.file ?? null,
        line: item.line ?? null,
        column: item.column ?? null,
        code: 'SyntaxError',
        message: shorten(item.message),
      });
    } catch { /* not a diagnostic line */ }
  }
  return diagnostics;
}

function parsePytest(text) {
  const diagnostics = [];
  for (const line of text.split('\n')) {
    const match = /^(FAILED|ERROR) (\S+?)(?:::(\S+))?(?: - (.*))?$/.exec(line.trim());
    if (!match) continue;
    const [, , file, testName, message = ''] = match;
    const lineHit = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+): `, 'm').exec(text);
    diagnostics.push({
      file,
      line: lineHit ? Number(lineHit[1]) : null,
      column: null,
      code: /^[A-Za-z_.]+(Error|Exception)\b/.exec(message)?.[0] ?? (message.startsWith('assert') ? 'AssertionError' : 'TestFailure'),
      message: shorten(testName ? `${testName}: ${message}` : message),
    });
  }
  return diagnostics;
}

function pytestSummary(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/\b\d+ (passed|failed|error|errors|skipped|deselected)\b/.test(lines[i]) || /^no tests ran/.test(lines[i])) {
      return lines[i].replace(/^=+\s*|\s*=+$/g, '');
    }
  }
  return null;
}

function analyze(request, run, root) {
  const combined = `${run.stdout}\n${run.stderr}`;
  let diagnostics = [];
  let summary = null;

  if (request.kind === 'ruff') {
    const parsed = parseRuff(run.stdout);
    if (parsed) {
      const real = fs.realpathSync(root);
      diagnostics = parsed.map(item => ({
        ...item,
        file: item.file && path.relative(real, item.file.startsWith(real) ? item.file : path.resolve(root, item.file)),
      }));
      summary = diagnostics.length ? `${diagnostics.length} Ruff violation(s)` : 'All checks passed';
    }
  } else if (request.kind === 'python_compile') {
    diagnostics = parseCompile(run.stdout);
    summary = diagnostics.length ? `${diagnostics.length} syntax error(s)` : 'Compiled cleanly';
  } else if (request.kind === 'pytest' || request.profile === 'pytest_all') {
    diagnostics = parsePytest(combined);
    summary = pytestSummary(combined);
  }
  return { diagnostics, summary };
}

/**
 * Run one allow-listed focused check inside `root`.
 * Never throws for bad requests or failing checks: both are returned as evidence.
 */
export async function runCheck(root, params, options = {}) {
  const env = options.env ?? process.env;
  const bins = {
    python: options.bins?.python ?? env.PI_PYTHON_BIN ?? 'python3',
    ruff: options.bins?.ruff ?? 'ruff',
    pytest: options.bins?.pytest ?? 'pytest',
  };

  let request;
  let spec;
  try {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new InvalidCheck('request must be an object');
    request = params;
    spec = commandFor(root, request, bins);
  } catch (error) {
    if (error instanceof InvalidCheck) return invalid(params?.kind, error.message);
    throw error;
  }

  const seconds = Math.min(
    Number(options.timeoutSeconds ?? env.PI_RUN_CHECK_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT_SECONDS),
    MAX_TIMEOUT_SECONDS,
  );
  const timeoutMs = options.timeoutMs ?? seconds * 1000;
  const sandboxFactory = options.sandboxFactory ?? isolatedCommand;
  const isolated = sandboxFactory(root, spec);
  if (!isolated) return invalid(request.kind, `No check sandbox is available on ${process.platform}`);
  if (path.isAbsolute(spec.command) && !fs.existsSync(spec.command)) {
    return { ...invalid(request.kind, `Could not start ${spec.command}: ENOENT`), status: 'fail' };
  }
  const run = await execute({
    command: isolated.command,
    args: isolated.args,
    cwd: path.resolve(root),
    env: checkEnv(env),
    timeoutMs,
  });

  const kind = request.kind;
  const stdoutTail = cap(run.stdout, TAIL_CHARS);
  const stderrTail = cap(run.stderr, TAIL_CHARS);
  const truncated = run.dropped || stdoutTail.truncated || stderrTail.truncated;
  const base = {
    kind,
    ...(kind === 'profile' ? { profile: request.profile } : {}),
    exit_code: run.exitCode,
    duration_ms: run.durationMs,
    stdout_tail: stdoutTail.text,
    stderr_tail: stderrTail.text,
    truncated,
  };

  if (run.timedOut) {
    return { status: 'timeout', ...base, summary: `Timed out after ${Math.round(timeoutMs / 1000)}s; process tree killed`, diagnostics: [] };
  }
  if (run.spawnError) {
    const failedTarget = isolated.command === spec.command ? spec.command : `check sandbox ${isolated.command}`;
    return { status: 'fail', ...base, summary: `Could not start ${failedTarget}: ${run.spawnError.code || run.spawnError.message}`, diagnostics: [] };
  }

  const { diagnostics, summary } = analyze(request, run, path.resolve(root));
  const passed = run.exitCode === 0;
  return {
    status: passed ? 'pass' : 'fail',
    ...base,
    summary: summary ?? (passed ? 'Check passed' : `Check failed with exit code ${run.exitCode}`),
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    ...(diagnostics.length > MAX_DIAGNOSTICS ? { truncated: true } : {}),
  };
}

/** Structured, bounded metric record (no raw output, no secrets). */
export function checkMetricRecord(result, { backend, stage }) {
  return {
    backend,
    stage,
    kind: result.kind,
    profile: result.profile ?? null,
    status: result.status,
    duration_ms: result.duration_ms,
    truncated: result.truncated,
    diagnostics: result.diagnostics.length,
  };
}
