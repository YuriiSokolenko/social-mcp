import path from 'node:path';
import fs from 'node:fs';

import { runProcess } from './process.mjs';

/**
 * Run the deterministic checks that validate PRODUCT CODE before a Pi stage
 * publishes or approves a result. Every subprocess has a real deadline so a
 * wedged test runner cannot consume the whole workflow timeout.
 */
function run(command, args, cwd, { allowFailure = false } = {}) {
  try {
    return runProcess(command, args, {
      cwd,
      allowFailure,
      timeoutSeconds: Number(process.env.PI_PRODUCT_CHECK_TIMEOUT_SECONDS ?? 900),
    });
  } catch (error) {
    throw new Error(`check: ${command} could not run: ${error.message}`, { cause: error });
  }
}

function summarizedOutput(result) {
  const output = [result.out, result.err].filter(Boolean).join('\n');
  if (output.length <= 16000) return output;
  return `${output.slice(0, 8000)}\n... output truncated ...\n${output.slice(-8000)}`;
}

function formatRuffDiagnostics(output, root) {
  let diagnostics;
  try {
    diagnostics = JSON.parse(output);
  } catch {
    return output.slice(-8000) || 'Ruff returned an unreadable diagnostic result';
  }
  if (!Array.isArray(diagnostics)) return output;
  const formatted = diagnostics.slice(0, 40).map(item => {
    const location = item.location
      ? `${item.location.row ?? '?'}:${item.location.column ?? '?'}`
      : '?:?';
    const filename = item.filename && path.isAbsolute(item.filename)
      ? path.relative(root, item.filename)
      : item.filename ?? '<unknown>';
    const repair = item.fix?.applicability === 'unsafe'
      ? 'unsafe fix available'
      : item.fix?.applicability === 'safe'
        ? 'safe fix available'
        : 'no automatic fix available';
    return `ruff: ${filename}:${location}: ${item.code ?? 'unknown'}: ${item.message ?? 'lint failure'} (${repair})`;
  });
  if (diagnostics.length > formatted.length) {
    formatted.push(`... ${diagnostics.length - formatted.length} additional Ruff diagnostic(s) omitted`);
  }
  return formatted.join('\n');
}

function changedPythonPaths(root) {
  const commands = [
    ['diff', '--name-only', '-z', '--diff-filter=ACMRT', 'origin/dev...HEAD'],
    ['diff', '--name-only', '-z', '--diff-filter=ACMRT'],
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ];
  const paths = new Set();
  for (const args of commands) {
    const result = run('git', args, root, { allowFailure: true });
    if (result.status !== 0) throw new Error(`check: git ${args[0]} failed: ${result.err || result.out}`);
    for (const filename of result.out.split('\0').filter(Boolean)) {
      if (/\.pyi?$/.test(filename) && fs.existsSync(path.join(root, filename))) paths.add(filename);
    }
  }
  return [...paths].sort();
}

export function runRuffCheck(cwd = process.cwd()) {
  const root = fs.realpathSync(path.resolve(cwd));
  const config = path.join(root, 'pyproject.toml');
  // Ruff's default --fix mode applies only safe fixes. Run it before the
  // authoritative check so mechanical style/metadata fixes do not consume an
  // LLM repair attempt. Both invocations pin the repository config explicitly.
  const fixPaths = changedPythonPaths(root);
  if (fixPaths.length) run('ruff', ['check', '--fix', '--config', config, ...fixPaths], root, { allowFailure: true });

  const check = run('ruff', ['check', '--output-format=json', '--config', config, '.'], root, { allowFailure: true });
  if (check.status !== 0) {
    throw new Error(`check: Ruff\n${formatRuffDiagnostics(check.out || check.err, root)}`);
  }
}

export function runProductChecks({ cwd } = {}) {
  runRuffCheck(cwd);

  for (const [name, command, args] of [
    ['git diff --check', 'git', ['diff', '--check']],
    ['pytest', 'pytest', []],
  ]) {
    const result = run(command, args, cwd, { allowFailure: true });
    if (result.status !== 0) {
      const output = summarizedOutput(result);
      throw new Error(`check: ${name}\n${output || `${command} exited with code ${result.status}`}`);
    }
    if (result.out) process.stdout.write(`${result.out}\n`);
    if (result.err) process.stderr.write(`${result.err}\n`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runProductChecks();
}
