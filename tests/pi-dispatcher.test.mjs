import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BLOCKED_LABELS,
  GitHub,
  READY_LABEL,
  classifyDispatch,
  compareCandidates,
  loadTaskMetadata,
  parseDispatchResult,
  parseTaskMetadata,
  runApply,
  runPrepare,
  selectCandidates,
  validateSelection,
} from '../scripts/pi-dispatcher.mjs';

const repo = 'owner/social-mcp';
const noop = () => {};

/** Open issue carrying the given label names, e.g. issue(5, READY_LABEL). */
const issue = (number, ...names) => ({ number, title: `Issue ${number}`, labels: names.map(name => ({ name })) });
const taskFile = (number, { priority = 'P1', dependsOn = null } = {}) =>
  `---\nissue: ${number}\npriority: ${priority}\ndepends_on: ${dependsOn === null ? '[]' : `[${dependsOn.join(', ')}]`}\n---\n\n# Task\n`;

/**
 * Run a callback with task files on disk. Task metadata is data from `dev`, so
 * the pure layer is pointed at a real temporary directory rather than a mock.
 */
const withTasks = (files, run) => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dispatcher-'));
  const remove = () => fs.rmSync(taskDir, { recursive: true, force: true });
  try {
    for (const [number, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(taskDir, `${number}.md`), typeof contents === 'string' ? contents : taskFile(number, contents));
    }
  } catch (error) {
    remove();
    throw error;
  }
  let result;
  try {
    result = run(taskDir);
  } catch (error) {
    remove();
    throw error;
  }
  // An async callback must finish reading the files before they are removed.
  if (result instanceof Promise) return result.finally(remove);
  remove();
  return result;
};

const snapshotOf = (candidates, active = []) => ({
  active: [...active],
  candidates: candidates.map(number => ({ issue: number })),
});

// ---------------------------------------------------------------------------
// parseTaskMetadata / loadTaskMetadata
// ---------------------------------------------------------------------------

test('task metadata is read from its front matter', () => {
  assert.deepEqual(parseTaskMetadata(taskFile(12, { priority: 'P0', dependsOn: [11, 7] }), 12), {
    priority: 'P0',
    dependencies: [11, 7],
  });
  assert.deepEqual(parseTaskMetadata(taskFile(12, { dependsOn: [] }), 12), { priority: 'P1', dependencies: [] });
  assert.deepEqual(parseTaskMetadata(taskFile(12).replace(/\n/g, '\r\n'), 12), { priority: 'P1', dependencies: [] });
});

test('only the leading front matter block is task metadata', () => {
  assert.throws(() => parseTaskMetadata(`# Task\n\n${taskFile(12)}`, 12), /missing YAML front matter/);
  assert.throws(() => parseTaskMetadata('---\nissue: 12\npriority: P1\ndepends_on: []\n', 12), /missing YAML front matter/);
});

test('invalid task metadata is rejected with its reason, never guessed', () => {
  const cases = [
    [taskFile(13), /does not match filename/, 'the issue number must match the filename'],
    ['---\npriority: P1\ndepends_on: []\n---\n', /does not match filename/, 'a missing issue number is invalid'],
    ['---\nissue: null\npriority: P1\ndepends_on: []\n---\n', /does not match filename/, 'an unparseable issue number is invalid'],
    [taskFile(12, { priority: 'P3' }), /invalid priority/, 'an unknown priority is invalid'],
    ['---\nissue: 12\npriority: P1\n---\n', /inline list of issue numbers/, 'a task without depends_on is invalid'],
    [taskFile(12, { priority: 'urgent' }), /invalid priority/, 'a non-priority string is invalid'],
    [taskFile(12, { dependsOn: [12] }), /depends on itself/, 'a task may not depend on itself'],
  ];
  for (const [contents, matcher, message] of cases) {
    assert.throws(() => parseTaskMetadata(contents, 12), matcher, message);
  }
});

test('malformed dependency lists are rejected', () => {
  for (const raw of ['', '[11, seven]', '[11 7]', '[1.5]', '[] extra', '[11,]']) {
    const contents = `---\nissue: 12\npriority: P1\ndepends_on: ${raw}\n---\n`;
    assert.throws(
      () => parseTaskMetadata(contents, 12),
      /inline list of issue numbers/,
      `depends_on: ${JSON.stringify(raw)} is not a list of issue numbers`,
    );
  }
});

test('task files are read from the checked out dev tree', () => {
  withTasks({ 12: taskFile(12, { priority: 'P0' }) }, taskDir => {
    assert.deepEqual(loadTaskMetadata(12, { taskDir }), { priority: 'P0', dependencies: [] });
    assert.throws(() => loadTaskMetadata(99, { taskDir }), /missing .*[/\\]99\.md/);
  });
  withTasks({ 12: taskFile(13) }, taskDir => {
    assert.throws(() => loadTaskMetadata(12, { taskDir }), /does not match filename/);
  });
});

// ---------------------------------------------------------------------------
// selectCandidates: the pure candidate gate
// ---------------------------------------------------------------------------

const gate = (taskDir, { issues = [], prs = [], repo: owner = repo, completed = [] } = {}) =>
  selectCandidates(issues, prs, {
    repo: owner,
    taskDir,
    completedDependencies: async (_number, dependencies) =>
      new Set(dependencies.filter(number => completed.includes(number))),
  });

test('only issues carrying the ready label are considered', async () => {
  await withTasks({ 1: {}, 3: {} }, async taskDir => {
    const result = await gate(taskDir, { issues: [issue(1, READY_LABEL), issue(2, 'bug'), issue(3, READY_LABEL)] });
    assert.deepEqual(result.candidates.map(candidate => candidate.issue), [1, 3]);
    assert.deepEqual(result.skipped, []);
  });
});

test('candidates are ordered by priority then ascending issue number', async () => {
  await withTasks(
    { 1: { priority: 'P2' }, 2: { priority: 'P0' }, 3: { priority: 'P0' }, 4: {} },
    async taskDir => {
      const result = await gate(taskDir, {
        issues: [issue(4, READY_LABEL), issue(1, READY_LABEL), issue(3, READY_LABEL), issue(2, READY_LABEL)],
      });
      assert.deepEqual(result.candidates.map(candidate => candidate.issue), [2, 3, 4, 1]);
    },
  );
  assert.deepEqual(
    [{ priority: 'P1', issue: 2 }, { priority: 'P0', issue: 3 }, { priority: 'P1', issue: 1 }]
      .sort(compareCandidates)
      .map(candidate => candidate.issue),
    [3, 1, 2],
  );
  assert.equal(compareCandidates({ priority: 'P0', issue: 2 }, { priority: 'P0', issue: 1 }), 1);
});

test('an issue claimed by a branch or an active Pi label is skipped', async () => {
  await withTasks({ 1: {}, 2: {}, 3: {} }, async taskDir => {
    const prs = [{ head: { ref: 'pi/issue-1', repo: { full_name: repo } }, base: { ref: 'dev' } }];
    const result = await gate(taskDir, {
      issues: [issue(1, READY_LABEL), issue(2, READY_LABEL, 'pi:running'), issue(3, READY_LABEL)],
      prs,
    });
    assert.deepEqual(result.candidates.map(candidate => candidate.issue), [3]);
    assert.deepEqual(result.active, [1, 2]);
    assert.deepEqual(result.skipped, [
      { issue: 1, reason: 'already active' },
      { issue: 2, reason: 'already active' },
    ]);
  });
});

test('an open PR only claims its issue when it targets dev in this repository', async () => {
  await withTasks({ 5: {} }, async taskDir => {
    const prs = [
      { head: { ref: 'pi/issue-5', repo: { full_name: 'attacker/fork' } }, base: { ref: 'dev' } },
      { head: { ref: 'pi/issue-5', repo: { full_name: repo } }, base: { ref: 'main' } },
      { head: { ref: 'feature/5', repo: { full_name: repo } }, base: { ref: 'dev' } },
    ];
    const result = await gate(taskDir, { issues: [issue(5, READY_LABEL)], prs });
    assert.deepEqual(result.active, []);
    assert.deepEqual(result.candidates.map(candidate => candidate.issue), [5]);
  });
});

test('every active Pi label makes the issue active', async () => {
  for (const label of ['pi:ready', 'pi:running', 'pi:mr-created']) {
    await withTasks({ 1: {} }, async taskDir => {
      const result = await gate(taskDir, { issues: [issue(1, READY_LABEL, label)] });
      assert.deepEqual(result.candidates, [], label);
      assert.deepEqual(result.active, [1], label);
    });
  }
});

test('a Pi failure label needs a human before the issue may run', async () => {
  for (const label of BLOCKED_LABELS) {
    await withTasks({ 1: {} }, async taskDir => {
      const result = await gate(taskDir, { issues: [issue(1, READY_LABEL, label)] });
      assert.deepEqual(result.candidates, [], label);
      assert.deepEqual(result.skipped, [{ issue: 1, reason: 'blocked by Pi failure label' }], label);
    });
  }
});

test('pending dependencies are skipped reporting the first one', async () => {
  await withTasks({ 12: taskFile(12, { dependsOn: [7, 11] }) }, async taskDir => {
    const result = await gate(taskDir, { issues: [issue(12, READY_LABEL)], completed: [11] });
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.skipped, [{ issue: 12, reason: 'dependency #7 is not completed' }]);
  });
  await withTasks({ 12: taskFile(12, { dependsOn: [7, 11] }) }, async taskDir => {
    const result = await gate(taskDir, { issues: [issue(12, READY_LABEL)], completed: [7, 11] });
    assert.deepEqual(result.candidates.map(candidate => candidate.issue), [12]);
  });
});

test('invalid task metadata skips an issue instead of guessing a priority', async () => {
  await withTasks({ 12: taskFile(12, { priority: 'BLOCKER' }) }, async taskDir => {
    const result = await gate(taskDir, { issues: [issue(12, READY_LABEL)] });
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.skipped, [{ issue: 12, reason: 'invalid priority' }]);
  });
  await withTasks({}, async taskDir => {
    const result = await gate(taskDir, { issues: [issue(12, READY_LABEL)] });
    assert.deepEqual(result.skipped, [{ issue: 12, reason: `missing ${path.join(taskDir, '12.md')}` }]);
  });
});

// ---------------------------------------------------------------------------
// validateSelection: DISPATCH_RESULT against a freshly read snapshot
// ---------------------------------------------------------------------------

test('a complete selection in priority order is accepted as-is', () => {
  assert.deepEqual(validateSelection([2, 3, 1], snapshotOf([2, 3, 1])), { accepted: [2, 3, 1], noOps: [], rejected: [] });
});

test('an out-of-order selection is rejected whole, never reordered', () => {
  const result = validateSelection([1, 2], snapshotOf([2, 1]));
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map(item => [item.issue, item.code]), [[1, 'out-of-order'], [2, 'out-of-order']]);
});

test('a partial selection is reported rather than partially applied', () => {
  const result = validateSelection([1], snapshotOf([1, 2]));
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected, [
    { issue: 2, code: 'missing', reason: 'eligible issue is missing from the dispatcher result' },
  ]);
});

test('issues that are no longer candidates are rejected as stale', () => {
  const result = validateSelection([99], snapshotOf([1]));
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map(item => [item.issue, item.code]), [[99, 'not-eligible'], [1, 'missing']]);
});

test('an already active issue is a no-op and never replaces a missing candidate', () => {
  assert.deepEqual(validateSelection([1], snapshotOf([], [1])), { accepted: [], noOps: [1], rejected: [] });
  const result = validateSelection([1], snapshotOf([2], [1]));
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.noOps, [1]);
  assert.deepEqual(result.rejected.map(item => [item.issue, item.code]), [[2, 'missing']]);
});

test('duplicates and non-integers in the result are rejected', () => {
  const result = validateSelection([1, 1, 2.5, '3', null], snapshotOf([1]));
  assert.deepEqual(result.accepted, [1]);
  assert.deepEqual(
    result.rejected.map(item => [item.issue, item.code]),
    [[1, 'duplicate'], [2.5, 'invalid'], ['3', 'invalid'], [null, 'invalid']],
  );
});

test('an empty result against an empty queue is a clean no-op', () => {
  assert.deepEqual(validateSelection([], snapshotOf([])), { accepted: [], noOps: [], rejected: [] });
});

// ---------------------------------------------------------------------------
// parseDispatchResult
// ---------------------------------------------------------------------------

const jobLog = text =>
  `${JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] })}\n`;

test('the DISPATCH_RESULT line yields issue numbers in dispatcher order', () => {
  const jsonl = `${jobLog('analysing the queue')}${jobLog('DISPATCH_RESULT: {"issues":[3,1],"skipped":[]}')}`;
  assert.deepEqual(parseDispatchResult(jsonl), [3, 1]);
  assert.deepEqual(parseDispatchResult(jobLog('DISPATCH_RESULT: {"issues":[]}')), []);
});

test('a missing or repeated DISPATCH_RESULT line is an error', () => {
  assert.throws(() => parseDispatchResult(jobLog('no result here')), /exactly one DISPATCH_RESULT/);
  const line = 'DISPATCH_RESULT: {"issues":[1]}';
  assert.throws(() => parseDispatchResult(jobLog(`${line}\n${line}`)), /exactly one DISPATCH_RESULT/);
});

test('unparseable or invalid dispatcher output is rejected', () => {
  assert.throws(() => parseDispatchResult(jobLog('DISPATCH_RESULT: {oops}')), /invalid DISPATCH_RESULT json/);
  for (const payload of ['{"issues":"1"}', '{"issues":[1.5]}', '{}']) {
    assert.throws(() => parseDispatchResult(jobLog(`DISPATCH_RESULT: ${payload}`)), /invalid dispatcher issue list/, payload);
  }
  assert.throws(() => parseDispatchResult(jobLog('DISPATCH_RESULT: {"issues":[3,3]}')), /duplicate issue/);
});

// ---------------------------------------------------------------------------
// classifyDispatch: the gate immediately before a write
// ---------------------------------------------------------------------------

test('only the next eligible candidate may be labelled', () => {
  assert.deepEqual(classifyDispatch(1, snapshotOf([1, 2])), { action: 'dispatch' });
  assert.match(classifyDispatch(2, snapshotOf([1, 2])).reason, /next eligible/);
  assert.equal(classifyDispatch(2, snapshotOf([1, 2])).action, 'skip');
  assert.match(classifyDispatch(1, snapshotOf([1], [1])).reason, /already assigned/);
  assert.match(classifyDispatch(7, snapshotOf([1])).reason, /no longer an eligible candidate/);
});

// ---------------------------------------------------------------------------
// The GitHub client: raw snapshot reads and label writes through an injected fetch
// ---------------------------------------------------------------------------

const json = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
  json: async () => value,
});

/**
 * Fetch double for the GitHub REST endpoints the client touches. It returns raw
 * API shapes only: it holds no dispatcher policy, exactly like the client.
 */
const fakeGitHub = ({ issues = [], prs = [], dependencies = new Map(), labelStatus = 201, taskDir = 'tasks' } = {}) => {
  const calls = [];
  const state = {
    issues: issues.map(item => ({ ...item, labels: item.labels.map(({ name }) => ({ name })) })),
    prs,
    dependencies,
    labels: new Map(),
    dispatches: [],
    writes: [],
  };

  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const { pathname, search } = new URL(url);
    const endpoint = pathname.slice(`/repos/${repo}`.length) + search;
    calls.push(`${method} ${endpoint}`);

    if (method === 'POST' && endpoint === '/labels') return json({ id: 1 }, labelStatus);
    if (method === 'GET' && endpoint.startsWith('/issues?')) return json(state.issues);
    if (method === 'GET' && endpoint.startsWith('/pulls?')) return json(state.prs);

    let match = endpoint.match(/^\/issues\/(\d+)\/labels$/);
    if (method === 'POST' && match) {
      const number = Number(match[1]);
      const labels = JSON.parse(options.body).labels;
      state.labels.set(number, [...(state.labels.get(number) ?? []), ...labels]);
      state.issues.find(item => item.number === number).labels.push(...labels.map(name => ({ name })));
      state.writes.push(['add', number, ...labels]);
      return json({}, 201);
    }
    match = endpoint.match(/^\/issues\/(\d+)\/labels\/(.+)$/);
    if (method === 'DELETE' && match) {
      const number = Number(match[1]);
      const label = decodeURIComponent(match[2]);
      const target = state.issues.find(item => item.number === number);
      target.labels = target.labels.filter(({ name }) => name !== label);
      state.writes.push(['remove', number, label]);
      return { ok: true, status: 204, text: async () => '', json: async () => null };
    }
    if (method === 'POST' && endpoint === '/dispatches') {
      const number = JSON.parse(options.body).client_payload.issue_number;
      state.dispatches.push(number);
      state.writes.push(['dispatch', number]);
      return json({}, 201);
    }

    match = endpoint.match(/^\/issues\/(\d+)$/);
    if (match && method === 'GET') {
      const number = Number(match[1]);
      // A copy, so nothing a caller does can mutate the recorded dependency.
      return json({ ...(state.dependencies.get(number) ?? { number, state: 'open' }) });
    }
    throw new Error(`unhandled ${method} ${endpoint}`);
  };

  const client = new GitHub({ repo, token: 'test-token-not-a-secret', fetchImpl, taskDir });
  return { client, state, calls };
};

test('a GitHub request reports the status, endpoint and response body', async () => {
  const client = new GitHub({
    repo,
    token: 'test-token-not-a-secret',
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'resource not accessible' }),
  });
  await assert.rejects(
    () => client.request('/issues?state=open'),
    /GitHub 403 \/issues\?state=open: resource not accessible/,
  );
});

test('authenticates every request and stops paginating on the last page', async () => {
  const seen = [];
  const client = new GitHub({
    repo,
    token: 'test-token-not-a-secret',
    fetchImpl: async (url, options) => {
      seen.push([url, options.headers.Authorization, options.headers['X-GitHub-Api-Version']]);
      const items = Array.from({ length: seen.length === 1 ? 100 : 12 }, (_, index) => index);
      return json(items);
    },
  });
  assert.equal((await client.pages('/issues?state=open')).length, 112);
  assert.equal(seen[0][1], 'Bearer test-token-not-a-secret');
  assert.equal(seen[0][2], '2022-11-28');
  assert.match(seen[0][0], /per_page=100&page=1$/);
  assert.match(seen[1][0], /page=2$/);
});

test('the ready label is ensured and an existing label is not an error', async () => {
  for (const labelStatus of [201, 422]) {
    const { client, calls } = fakeGitHub({ labelStatus });
    await client.ensureReadyLabel();
    assert.deepEqual(calls, ['POST /labels']);
  }
  const failing = fakeGitHub({ labelStatus: 403 });
  await assert.rejects(() => failing.client.ensureReadyLabel(), /Cannot ensure dispatcher:ready label: 403/);
});

test('a snapshot marks an open-PR issue active without dispatching it', async () => {
  await withTasks({ 12: taskFile(12, { dependsOn: [11] }), 13: taskFile(13) }, async taskDir => {
    const { client } = fakeGitHub({
      taskDir,
      issues: [issue(12, READY_LABEL), issue(13, READY_LABEL)],
      prs: [{ head: { ref: 'pi/issue-13', repo: { full_name: repo } }, base: { ref: 'dev' } }],
    });
    const snapshot = await client.snapshot();
    assert.deepEqual(snapshot.active, [13]);
    assert.deepEqual(snapshot.candidates, []);
    assert.deepEqual(snapshot.skipped, [
      { issue: 12, reason: 'dependency #11 is not completed' },
      { issue: 13, reason: 'already active' },
    ]);
  });
});

test('a dependency counts as completed only when closed as completed by a real issue', async () => {
  const cases = [
    [{ number: 11, state: 'closed', state_reason: 'completed' }, [12]],
    [{ number: 11, state: 'closed', state_reason: 'not_completed' }, []],
    [{ number: 11, state: 'open' }, []],
    [{ number: 11, state: 'closed', state_reason: 'completed', pull_request: {} }, []],
  ];
  for (const [dependency, expected] of cases) {
    await withTasks({ 12: taskFile(12, { dependsOn: [11] }) }, async taskDir => {
      const { client } = fakeGitHub({
        taskDir,
        issues: [issue(12, READY_LABEL)],
        dependencies: new Map([[11, dependency]]),
      });
      const snapshot = await client.snapshot();
      assert.deepEqual(snapshot.candidates.map(candidate => candidate.issue), expected, JSON.stringify(dependency));
    });
  }
});

test('issue and pull request listings are read from GitHub, not from the trigger event', async () => {
  await withTasks({ 1: {} }, async taskDir => {
    const { client, calls } = fakeGitHub({ taskDir, issues: [issue(1, READY_LABEL)] });
    await client.snapshot();
    assert.deepEqual(
      calls.filter(call => call.startsWith('GET')),
      ['GET /issues?state=open&per_page=100&page=1', 'GET /pulls?state=open&per_page=100&page=1'],
    );
  });
});

test('prepare ensures the ready label and reads the queue without writing', async () => {
  await withTasks({ 1: {} }, async taskDir => {
    const { client, state } = fakeGitHub({ taskDir, issues: [issue(1, READY_LABEL)] });
    const snapshot = await runPrepare(client);
    assert.deepEqual(snapshot.candidates.map(candidate => candidate.issue), [1]);
    assert.deepEqual(state.writes, []);
  });
});

// ---------------------------------------------------------------------------
// runApply: re-read state before every label write
// ---------------------------------------------------------------------------

/** Dispatcher client double: scripted snapshots plus recorded writes. */
const fakeClient = ({ snapshots, labelFailure = null, dispatchFailure = null }) => {
  const reads = [];
  const writes = [];
  let index = 0;
  return {
    reads,
    writes,
    snapshots,
    async snapshot() {
      reads.push(index);
      const snapshot = snapshots[Math.min(index++, snapshots.length - 1)];
      if (snapshot === undefined) throw new Error('ran out of scripted snapshots');
      return snapshot;
    },
    async addLabel(number, label) {
      if (labelFailure) throw new Error(labelFailure);
      writes.push(['add', number, label]);
    },
    async removeLabel(number, label) {
      writes.push(['remove', number, label]);
    },
    async dispatch(number) {
      if (dispatchFailure) throw new Error(dispatchFailure);
      writes.push(['dispatch', number]);
    },
  };
};

const result = issues => jobLog(`DISPATCH_RESULT: ${JSON.stringify({ issues })}`);

test('an accepted issue is labelled, dispatched, then released from the ready label', async () => {
  const client = fakeClient({ snapshots: [snapshotOf([1])] });
  assert.deepEqual(await runApply(client, result([1]), noop), { dispatched: [1], noOps: [], rejected: [] });
  assert.deepEqual(client.writes, [
    ['add', 1, 'pi:ready'],
    ['dispatch', 1],
    ['remove', 1, READY_LABEL],
  ]);
});

test('accepted issues are dispatched in priority order', async () => {
  // After #2 is assigned its dispatcher:ready label is gone, so #1 leads.
  const client = fakeClient({ snapshots: [snapshotOf([2, 1]), snapshotOf([2, 1]), snapshotOf([1])] });
  await runApply(client, result([2, 1]), noop);
  assert.deepEqual(client.writes.filter(([kind]) => kind === 'dispatch').map(([, number]) => number), [2, 1]);
});

test('a stale result is reported and nothing is labelled', async () => {
  const client = fakeClient({ snapshots: [snapshotOf([1, 2])] });
  const outcome = await runApply(client, result([1]), noop);
  assert.deepEqual(outcome.dispatched, []);
  assert.deepEqual(outcome.rejected.map(item => item.code), ['missing']);
  assert.deepEqual(client.writes, []);
});

test('a candidate taken by an earlier dispatcher is a no-op without a duplicate event', async () => {
  // The queue moved between validation and the write: #1 became active.
  const client = fakeClient({ snapshots: [snapshotOf([1]), snapshotOf([], [1])] });
  const outcome = await runApply(client, result([1]), noop);
  assert.deepEqual(outcome.dispatched, []);
  assert.deepEqual(client.writes, []);
  assert.equal(client.reads.length, 2); // validation, then the read before the write
});

test('a candidate that lost its ready label while apply ran is not labelled', async () => {
  const client = fakeClient({ snapshots: [snapshotOf([1]), snapshotOf([])] });
  const outcome = await runApply(client, result([1]), noop);
  assert.deepEqual(outcome.dispatched, []);
  assert.deepEqual(client.writes, []);
});

test('an already active issue from validation is never re-dispatched', async () => {
  const client = fakeClient({ snapshots: [snapshotOf([], [1])] });
  const outcome = await runApply(client, result([1]), noop);
  assert.deepEqual(outcome, { dispatched: [], noOps: [1], rejected: [] });
  assert.deepEqual(client.writes, []);
});

test('every accepted issue is re-read immediately before its label write', async () => {
  // Two candidates, but the second becomes ineligible on its own re-read.
  const client = fakeClient({ snapshots: [snapshotOf([1, 2]), snapshotOf([1, 2]), snapshotOf([1])] });
  const outcome = await runApply(client, result([1, 2]), noop);
  assert.deepEqual(outcome.dispatched, [1]);
  assert.deepEqual(client.writes, [
    ['add', 1, 'pi:ready'],
    ['dispatch', 1],
    ['remove', 1, READY_LABEL],
  ]);
  assert.equal(client.reads.length, 3); // validation, then one read per candidate
});

test('an issue taken over while apply ran must not block its remaining candidates', async () => {
  // Validation saw [1, 2]; before the writes an earlier dispatcher claimed #1,
  // so it drops out of the candidate list and becomes an active no-op.
  const client = fakeClient({ snapshots: [snapshotOf([1, 2]), snapshotOf([2], [1]), snapshotOf([2])] });
  const outcome = await runApply(client, result([1, 2]), noop);
  assert.deepEqual(outcome.dispatched, [2]);
  assert.deepEqual(outcome.rejected, []);
  // Only #2 may receive a repository_dispatch event.
  assert.deepEqual(client.writes, [
    ['add', 2, 'pi:ready'],
    ['dispatch', 2],
    ['remove', 2, READY_LABEL],
  ]);
});

test('a failed dispatch rolls pi:ready back and reports the failure', async () => {
  const client = fakeClient({ snapshots: [snapshotOf([1])], dispatchFailure: 'repository_dispatch rejected' });
  await assert.rejects(() => runApply(client, result([1]), noop), /repository_dispatch rejected/);
  // pi:ready must not linger on an issue that was never dispatched, and the
  // issue must keep dispatcher:ready.
  assert.deepEqual(client.writes, [
    ['add', 1, 'pi:ready'],
    ['remove', 1, 'pi:ready'],
  ]);
});

test('a failed label write dispatches nothing', async () => {
  const client = fakeClient({ snapshots: [snapshotOf([1])], labelFailure: 'issues: write denied' });
  await assert.rejects(() => runApply(client, result([1]), noop), /issues: write denied/);
  assert.deepEqual(client.writes, []);
});

test('an empty selection dispatches nothing and reports the skipped candidates', async () => {
  const client = fakeClient({ snapshots: [snapshotOf([1])] });
  const outcome = await runApply(client, result([]), noop);
  assert.deepEqual(outcome.dispatched, []);
  assert.deepEqual(outcome.rejected.map(item => item.code), ['missing']);
  assert.deepEqual(client.writes, []);
});

test('apply assigns an issue through the GitHub client and releases dispatcher:ready', async () => {
  await withTasks({ 1: {} }, async taskDir => {
    const { client, state } = fakeGitHub({ taskDir, issues: [issue(1, READY_LABEL)] });
    const outcome = await runApply(client, result([1]), noop);
    assert.deepEqual(outcome.dispatched, [1]);
    // pi:ready is applied, the issue is woken, and only then is dispatcher:ready removed.
    assert.deepEqual(state.writes, [
      ['add', 1, 'pi:ready'],
      ['dispatch', 1],
      ['remove', 1, READY_LABEL],
    ]);
    // The issue is left labelled pi:ready, no longer dispatcher:ready.
    assert.deepEqual(state.issues[0].labels, [{ name: 'pi:ready' }]);
  });
});

test('apply leaves GitHub untouched when the queue moved against the result', async () => {
  await withTasks({ 1: {}, 2: {} }, async taskDir => {
    const { client, state } = fakeGitHub({ taskDir, issues: [issue(1, READY_LABEL), issue(2, READY_LABEL)] });
    const outcome = await runApply(client, result([1]), noop);
    assert.deepEqual(outcome.dispatched, []);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.dispatches, []);
    assert.deepEqual(state.issues.map(item => item.labels.map(({ name }) => name)), [[READY_LABEL], [READY_LABEL]]);
  });
});
