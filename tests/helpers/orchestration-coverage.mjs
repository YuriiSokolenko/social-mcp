#!/usr/bin/env node
/**
 * Control-plane orchestration coverage report (#727).
 *
 *   node tests/helpers/orchestration-coverage.mjs [--out <dir>] [--compare <summary.json>] [--from-lcov <lcov.info>]
 *
 * Runs the Node test suite once with Node's built-in V8 coverage
 * (--experimental-test-coverage, lcov reporter), which also collects coverage
 * from the stage scripts the tests spawn as child processes, and reports line,
 * branch and function coverage for ORCHESTRATION_MODULES only.
 *
 * Writes <out>/lcov.info, <out>/summary.json and <out>/summary.md (default out:
 * coverage/orchestration), appends summary.md to $GITHUB_STEP_SUMMARY when set,
 * and exits with the test run's status. Coverage is reported, not gated.
 *
 * Caveat (V8 block coverage): a function that never ran reports no inner
 * blocks, so branch denominators grow as more code executes. Before/after
 * branch percentages are therefore conservative, and a module that no test
 * loads at all has no denominator; it is reported as "not loaded".
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Production orchestration modules: stage entrypoints and the shared state/recovery code they hand off through. */
export const ORCHESTRATION_MODULES = [
  'scripts/pi-triage.mjs',
  'scripts/pi-dispatcher.mjs',
  'scripts/pi-architect.mjs',
  'scripts/pi-transition.mjs',
  'scripts/pi-common/issue-publication.mjs',
  'scripts/pi-common/pr-guard.mjs',
  'scripts/pi-common/review-state.mjs',
  'scripts/pi-review-result.mjs',
  'scripts/pi-common/repair-publication.mjs',
  'scripts/pi-auto-merge.mjs',
  'scripts/pi-post-merge.mjs',
  'scripts/pi-reconcile.mjs',
  'scripts/pi-common/automation-control.mjs',
  'scripts/pi-common/workflow-dispatch.mjs',
  'scripts/pi-common/github-api.mjs',
  'scripts/pi-common/github-state.mjs',
  'scripts/pi-common/state-machine.mjs',
  'scripts/pi-common/recovery-policy.mjs',
];

/**
 * Test files left out of the coverage run (they still run, uninstrumented, in
 * the "Agent workflow checks" CI step). pi-run-stage.test.mjs hands spawn() a
 * frozen env object, so coverage mode cannot inject NODE_V8_COVERAGE into it.
 */
export const EXCLUDED_TESTS = ['tests/pi-run-stage.test.mjs'];

export function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const [key, ...rest] = line.split(':');
    const value = rest.join(':');
    if (key === 'SF') {
      current = { lines: new Map(), branches: new Map(), functions: new Map() };
      files.set(resolve(value), current);
    } else if (!current) {
      continue;
    } else if (key === 'DA') {
      const [number, hits] = value.split(',');
      current.lines.set(number, Math.max(current.lines.get(number) ?? 0, Number(hits)));
    } else if (key === 'BRDA') {
      const [lineNumber, block, branch, taken] = value.split(',');
      const id = `${lineNumber},${block},${branch}`;
      current.branches.set(id, Math.max(current.branches.get(id) ?? 0, taken === '-' ? 0 : Number(taken)));
    } else if (key === 'FNDA') {
      const [hits, name] = value.split(',');
      current.functions.set(name, Math.max(current.functions.get(name) ?? 0, Number(hits)));
    } else if (key === 'end_of_record') {
      current = null;
    }
  }
  return files;
}

const count = map => ({ found: map.size, hit: [...map.values()].filter(hits => hits > 0).length });
const pct = ({ found, hit }) => found ? Number((100 * hit / found).toFixed(2)) : null;

export function summarize(files, modules = ORCHESTRATION_MODULES, root = ROOT) {
  const rows = modules.map(module => {
    const data = files.get(resolve(root, module));
    if (!data) return { module, loaded: false };
    return { module, loaded: true, lines: count(data.lines), branches: count(data.branches), functions: count(data.functions) };
  });
  const total = kind => rows.filter(row => row.loaded).reduce(
    (sum, row) => ({ found: sum.found + row[kind].found, hit: sum.hit + row[kind].hit }), { found: 0, hit: 0 });
  const aggregate = { lines: total('lines'), branches: total('branches'), functions: total('functions') };
  return { modules: rows, aggregate };
}

const cell = value => value === null ? 'n/a' : value.toFixed(2);

export function renderMarkdown(summary, compare = null) {
  const before = new Map((compare?.modules ?? []).map(row => [row.module, row]));
  const delta = (row, kind) => {
    const old = before.get(row.module);
    if (!compare) return '';
    if (!old?.loaded) return row.loaded ? ' (new)' : '';
    const value = pct(row[kind]) - pct(old[kind]);
    return ` (${value >= 0 ? '+' : ''}${value.toFixed(2)})`;
  };
  const lines = [
    '## Orchestration control-plane coverage',
    '',
    '| Module | Lines % | Branches % | Functions % | Branches hit/found |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const row of summary.modules) {
    if (!row.loaded) {
      lines.push(`| \`${row.module}\` | not loaded | not loaded | not loaded | 0/? |`);
      continue;
    }
    lines.push(`| \`${row.module}\` | ${cell(pct(row.lines))}${delta(row, 'lines')} | ${cell(pct(row.branches))}${delta(row, 'branches')} | ${cell(pct(row.functions))}${delta(row, 'functions')} | ${row.branches.hit}/${row.branches.found} |`);
  }
  const { aggregate } = summary;
  const aggregateDelta = kind => compare ? ` (${(pct(aggregate[kind]) - pct(compare.aggregate[kind])) >= 0 ? '+' : ''}${(pct(aggregate[kind]) - pct(compare.aggregate[kind])).toFixed(2)})` : '';
  lines.push(`| **Aggregate (loaded modules)** | **${cell(pct(aggregate.lines))}${aggregateDelta('lines')}** | **${cell(pct(aggregate.branches))}${aggregateDelta('branches')}** | **${cell(pct(aggregate.functions))}${aggregateDelta('functions')}** | **${aggregate.branches.hit}/${aggregate.branches.found}** |`);
  lines.push('', `Excluded test files: ${EXCLUDED_TESTS.map(file => `\`${file}\``).join(', ')}. Branch counts are V8 block ranges; see docs/agent-harness/ORCHESTRATION_COVERAGE.md.`);
  return lines.join('\n') + '\n';
}

function testFiles() {
  return readdirSync(join(ROOT, 'tests'))
    .filter(name => name.endsWith('.test.mjs'))
    .map(name => `tests/${name}`)
    .filter(file => !EXCLUDED_TESTS.includes(file))
    .sort();
}

function main() {
  const args = process.argv.slice(2);
  const option = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const out = resolve(option('--out') ?? join(ROOT, 'coverage/orchestration'));
  const compareFile = option('--compare');
  const existing = option('--from-lcov');
  mkdirSync(out, { recursive: true });
  const lcov = existing ? resolve(existing) : join(out, 'lcov.info');

  // --from-lcov re-summarizes a saved run (e.g. the baseline) without re-running tests.
  const run = existing ? { status: 0 } : spawnSync(process.execPath, [
    '--test', '--experimental-test-coverage',
    '--test-reporter=dot', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', `--test-reporter-destination=${lcov}`,
    ...testFiles(),
  ], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (run.error) throw run.error;
  if (!existsSync(lcov)) throw new Error(`coverage run produced no ${relative(ROOT, lcov)}`);

  const summary = summarize(parseLcov(readFileSync(lcov, 'utf8')));
  const compare = compareFile ? JSON.parse(readFileSync(compareFile, 'utf8')) : null;
  const markdown = renderMarkdown(summary, compare);
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(out, 'summary.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(`\n${markdown}`);
  process.exitCode = run.status ?? 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) main();
