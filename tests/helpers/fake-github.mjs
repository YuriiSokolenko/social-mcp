/**
 * Test-side handle for the stateful fake GitHub (fake-github-preload.mjs).
 *
 * `fakeGithub(t, seed)` creates an isolated store and returns helpers that run
 * production stage entrypoints as real child processes against it. Every
 * child gets a minimal allowlisted environment (no inherited GITHUB_* runner
 * state, no real token) so a test cannot publish, dispatch or read anything
 * outside the fake.
 *
 * `root` selects the checkout whose scripts are executed. Tests use the
 * repository itself; mutation checks pass a temporary copy with one
 * deliberately broken production line to prove a scenario detects it.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const REPO = 'test/repo';
const PRELOAD = pathToFileURL(fileURLToPath(new URL('./fake-github-preload.mjs', import.meta.url))).href;
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SYSTEMROOT', 'NODE_V8_COVERAGE'];

/** Old enough that every Reconciler recovery grace period has elapsed. */
export const LONG_AGO = '2020-01-01T00:00:00.000Z';

export const taskBody = ({ priority = 'P1', deps = [], criteria = true } = {}) => [
  '## Task metadata',
  `Priority: ${priority}`,
  `Depends on: [${deps.map(number => `#${number}`).join(', ')}]`,
  '',
  '## Goal',
  'Make the orchestration fixture observable end to end.',
  ...(criteria ? [
    '',
    '## Acceptance criteria',
    '- The handler returns the configured greeting for every request.',
    '- The handler rejects an empty greeting with a validation error.',
    '- The unit tests cover both the greeting and the validation error.',
  ] : []),
].join('\n');

export const issue = (number, { labels = [], state = 'open', body = taskBody(), title = `Task ${number}`, updated_at = LONG_AGO, ...rest } = {}) => ({
  number, title, body, state, state_reason: rest.state_reason ?? null,
  labels: labels.map(name => ({ name })), created_at: LONG_AGO, updated_at, ...rest,
});

export const pullRequest = (number, issueNumber, {
  labels = [], sha = `head-${number}-a`, state = 'open', draft = false, updated_at = LONG_AGO,
  files = [{ filename: 'src/app.py', status: 'modified' }], body = `Closes #${issueNumber}`, ...rest
} = {}) => ({
  number, title: `Implement #${issueNumber}`, body, state, draft, merged: false, merged_at: null, merge_commit_sha: null,
  labels: labels.map(name => ({ name })), changed_files: files.length, files,
  base: { ref: 'dev', repo: { full_name: REPO } },
  head: { ref: `pi/issue-${issueNumber}`, sha, repo: { full_name: REPO } },
  html_url: `https://github.invalid/${REPO}/pull/${number}`, created_at: LONG_AGO, updated_at, ...rest,
});

let runIds = 5000;
/** A CI workflow run for a PR head (event pull_request) or the dev branch (event push). */
export const ciRun = (headSha, { event = 'pull_request', status = 'completed', conclusion = 'success', jobs, ...rest } = {}) => ({
  id: rest.id ?? ++runIds, workflow: 'ci.yml', name: 'CI', display_title: 'CI', event, status, conclusion,
  head_sha: headSha, head_branch: event === 'push' ? 'dev' : rest.head_branch ?? null, run_attempt: 1,
  html_url: `https://github.invalid/${REPO}/actions/runs/${rest.id ?? runIds}`,
  jobs: jobs ?? (conclusion === 'success' ? [{ name: 'test', conclusion: 'success', steps: [{ name: 'Pytest', conclusion: 'success' }] }] : []),
  ...rest,
});

/** A live (or finished) Pi stage run as the Reconciler sees it in /actions/runs. */
export const stageRun = (displayTitle, { status = 'in_progress', ...rest } = {}) => ({
  id: rest.id ?? ++runIds, workflow: 'pi-stage.yml', name: displayTitle, display_title: displayTitle,
  event: 'workflow_dispatch', status, conclusion: null, head_sha: 'control', run_attempt: 1, ...rest,
});

/** A Pi JSONL transcript whose only result is a structured submit_result entry. */
export const submitResult = (customType, data) => JSON.stringify({
  type: 'entry_appended', entry: { type: 'custom', customType, data },
}) + '\n';

export function fakeGithub(t, seed = {}, { root = REPO_ROOT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-orchestration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storeFile = join(dir, 'github.json');
  const store = {
    repo: REPO,
    issues: {}, pulls: {}, comments: [], runs: [], dispatches: [], merges: [], reruns: [],
    refs: { 'heads/dev': 'dev-0' }, deletedRefs: [], labelsCreated: [], variables: {},
    faults: [], interleave: [], requests: [], nextNumber: 900, nextCommentId: 1,
    ...seed,
  };
  for (const list of ['issues', 'pulls']) {
    if (Array.isArray(store[list])) store[list] = Object.fromEntries(store[list].map(item => [item.number, item]));
  }
  writeFileSync(storeFile, JSON.stringify(store, null, 1));

  const read = () => JSON.parse(readFileSync(storeFile, 'utf8'));
  const update = fn => {
    const current = read();
    fn(current);
    writeFileSync(storeFile, JSON.stringify(current, null, 1));
    return current;
  };
  let files = 0;
  const file = (name, content) => {
    const target = join(dir, `${++files}-${name}`);
    writeFileSync(target, content);
    return target;
  };

  function run(script, args = [], { env = {}, cwd = root } = {}) {
    const childEnv = Object.fromEntries(INHERITED_ENV.filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]]));
    Object.assign(childEnv, {
      // Project config is data, not code under test: always the repository's own.
      AGENT_HARNESS_CONFIG: join(REPO_ROOT, '.agent-harness.json'),
      GITHUB_REPOSITORY: REPO,
      GITHUB_TOKEN: 'synthetic-test-token',
      PI_FAKE_GITHUB_STORE: storeFile,
      PI_GITHUB_HTTP_TIMEOUT_MS: '3000',
      ...env,
    });
    const result = spawnSync(process.execPath, ['--import', PRELOAD, join(root, script), ...args], {
      cwd, env: childEnv, encoding: 'utf8', timeout: 60000,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
  }

  const labelsOf = number => {
    const state = read();
    return (state.issues[number] ?? state.pulls[number])?.labels.map(label => label.name).sort() ?? null;
  };
  // A mutation is a write GitHub accepted; rejected or fault-injected writes changed nothing.
  const accepted = request => request.method !== 'GET' && !request.fault && request.status < 400;
  const mutations = () => read().requests.filter(accepted);
  const mark = () => read().requests.length;
  const mutationsSince = index => read().requests.slice(index).filter(accepted);

  return { dir, storeFile, read, update, file, run, labelsOf, mutations, mark, mutationsSince };
}

/**
 * Copy the control plane into a temporary root and apply one source mutation.
 * The replaced text must exist exactly once, so a refactor that removes the
 * mutated line fails loudly instead of silently testing nothing.
 */
export function mutatedRoot(t, file, from, to) {
  // Real path: stage scripts run main() only when argv[1] equals their own
  // resolved module URL, and macOS tmpdir() is a symlink (/var → /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-mutant-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  const target = join(root, file);
  const source = readFileSync(target, 'utf8');
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`mutation anchor must occur exactly once in ${file}; found ${count}: ${from}`);
  writeFileSync(target, source.replace(from, to));
  return root;
}
