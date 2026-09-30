import path from 'node:path';

import { runProcess } from './process.mjs';

/**
 * Run the deterministic checks that validate PRODUCT CODE before a Pi stage
 * publishes or approves a result. Every subprocess has a real deadline so a
 * wedged test runner cannot consume the whole workflow timeout.
 */
function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = runProcess(command, args, {
    cwd,
    allowFailure,
    timeoutSeconds: Number(process.env.PI_PRODUCT_CHECK_TIMEOUT_SECONDS ?? 900),
  });
  return result;
}

function summarizedOutput(result) {
  const lines = `${result.err}\n${result.out}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const summary = lines.slice(-30).join('\n');
  return summary.length <= 8000 ? summary : `${summary.slice(0, 4000)}\n... output truncated ...\n${summary.slice(-4000)}`;
}

function formatRuffDiagnostics(output) {
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
    return `ruff: ${item.filename ?? '<unknown>'}:${location}: ${item.code ?? 'unknown'}: ${item.message ?? 'lint failure'} (mechanically fixable: no; safe Ruff fixes were already applied)`;
  });
  if (diagnostics.length > formatted.length) {
    formatted.push(`... ${diagnostics.length - formatted.length} additional Ruff diagnostic(s) omitted`);
  }
  return formatted.join('\n');
}

export function runRuffCheck(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const config = path.join(root, 'pyproject.toml');
  // Ruff's default --fix mode applies only safe fixes. Run it before the
  // authoritative check so mechanical style/metadata fixes do not consume an
  // LLM repair attempt. Both invocations pin the repository config explicitly.
  run('ruff', ['check', '--fix', '--config', config, '.'], root, { allowFailure: true });

  const check = run('ruff', ['check', '--output-format=json', '--config', config, '.'], root, { allowFailure: true });
  if (check.status !== 0) {
    throw new Error(`check: Ruff\n${formatRuffDiagnostics(check.out || check.err)}`);
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
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runProductChecks();
}
