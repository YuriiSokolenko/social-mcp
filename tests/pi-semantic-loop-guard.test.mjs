import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';

import { ProgressController } from '../scripts/pi-common/progress-controller.mjs';
import { safeEdit } from '../scripts/pi-common/safe-edit.mjs';
import {
  hasMeaningfulEvidence,
  loopGuardLimits,
  SemanticLoopGuard,
  repositoryStateFingerprint,
} from '../scripts/pi-common/semantic-loop-guard.mjs';

function observation(guard, overrides = {}) {
  return guard.observe({
    stage: 'implementer',
    tool: 'read',
    input: { path: 'src/a.js' },
    result: { content: [{ type: 'text', text: 'same source' }] },
    productiveState: 'evidence_allowed',
    ...overrides,
  });
}

test('hasMeaningfulEvidence handles empty and populated structured shell output', () => {
  assert.equal(hasMeaningfulEvidence({
    structuredContent: { stdout: '', stderr: '' },
  }, 'bash'), false);
  assert.equal(hasMeaningfulEvidence({
    structuredContent: { stdout: '', stderr: 'warning from tool' },
  }, 'bash'), true);
});

test('hasMeaningfulEvidence treats empty arrays and empty objects as no evidence', () => {
  assert.equal(hasMeaningfulEvidence([], 'repo_search'), false);
  assert.equal(hasMeaningfulEvidence({}, 'repo_search'), false);
});

test('useful text is not masked by an unrelated empty top-level collection', () => {
  assert.equal(hasMeaningfulEvidence({
    items: [],
    content: [{ type: 'text', text: 'useful repository evidence' }],
  }, 'repo_search'), true);
});

test('serialized top-level empty collection remains no evidence without structured payloads', () => {
  assert.equal(hasMeaningfulEvidence({
    matches: [],
    content: [{ type: 'text', text: '{"matches":[]}' }],
  }, 'repo_search'), false);
});

test('top-level empty collection does not mask distinct useful JSON text', () => {
  assert.equal(hasMeaningfulEvidence({
    matches: [],
    content: [{ type: 'text', text: '{"summary":"useful explanation"}' }],
  }, 'repo_search'), true);
});


test('authoritative structured empty collection remains no evidence despite serialized content', () => {
  assert.equal(hasMeaningfulEvidence({
    content: [{ type: 'text', text: '{"matches":[]}' }],
    details: { matches: [] },
  }, 'repo_search'), false);
});


function failedEditSteer(guard) {
  let failure;
  for (let index = 0; index < 3; index += 1) {
    failure = observation(guard, {
      tool: 'edit',
      input: { path: 'src/a.js', oldText: 'missing-' + index },
      result: { content: [{ type: 'text', text: 'oldText not found' }] },
      isError: true,
    });
  }
  assert.equal(failure.action, 'steer');
  return failure;
}

function emptyRepoSearch(guard, query = 'missing-symbol', overrides = {}) {
  return observation(guard, {
    tool: 'repo_search',
    input: { query },
    result: {
      content: [{ type: 'text', text: JSON.stringify({ kind: 'content', query, matches: [] }) }],
      details: { kind: 'content', query, matches: [], truncated: false },
    },
    ...overrides,
  });
}

test('semantic loop guard detects three identical read observations', () => {
  const guard = new SemanticLoopGuard();
  assert.equal(observation(guard).tripped, false);
  assert.equal(observation(guard).classification, 'success_same_observation');
  const third = observation(guard);
  assert.equal(third.action, 'steer');
  assert.equal(third.reason, 'repeated_observation');
  assert.equal(third.revisitCount, 3);
});

test('semantic loop guard detects repeated repo_search results across harmless actions', () => {
  const guard = new SemanticLoopGuard();
  const search = () => observation(guard, {
    tool: 'repo_search',
    input: { query: 'Foo' },
    result: { matches: [{ path: 'src/a.js', line: 7 }] },
  });
  assert.equal(search().tripped, false);
  observation(guard, {
    tool: 'read',
    input: { path: 'src/other.js' },
    result: { source: 'different useful evidence' },
  });
  assert.equal(search().tripped, false);
  observation(guard, { tool: 'set_response_budget', result: { budget: 'normal' } });
  assert.equal(search().action, 'steer');
});

test('healthy read LSP git-context edit progression is not treated as a loop', () => {
  const guard = new SemanticLoopGuard();
  const steps = [
    observation(guard, { tool: 'read', result: { text: 'target' } }),
    observation(guard, { tool: 'lsp_find_symbol', input: { symbol: 'Foo' }, result: { path: 'src/foo.js' } }),
    observation(guard, { tool: 'commit_story', input: { path: 'src/foo.js' }, result: { commits: ['abc'] } }),
    observation(guard, {
      tool: 'edit',
      input: { path: 'src/foo.js', oldText: 'a', newText: 'b' },
      repositoryStateBefore: 'state-a',
      repositoryStateAfter: 'state-b',
    }),
  ];
  assert.equal(steps.some(step => step.tripped), false);
  assert.equal(steps.at(-1).classification, 'success_changed');
});

test('safe_edit identical replacement is an explicit no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-safe-edit-noop-'));
  try {
    const file = path.join(dir, 'sample.txt');
    fs.writeFileSync(file, 'alpha\nbeta\n');
    const before = fs.statSync(file).mtimeMs;
    const result = safeEdit(dir, {
      path: 'sample.txt',
      operation: 'replace',
      start_line: 2,
      end_line: 2,
      text: 'beta',
    });
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'alpha\nbeta\n');
    assert.equal(fs.statSync(file).mtimeMs, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op mutation does not grant a new productive evidence epoch', () => {
  const controller = new ProgressController({
    maxTurns: 100,
    repeatThreshold: 3,
    requireComplexity: false,
    productiveProgress: {
      startState: 'action_required',
      blockerTool: 'need_more_evidence',
      actionTools: ['edit', 'write', 'rollback_last_mutation', 'submit_result'],
      controlTools: [],
      initialEvidenceBudget: 1,
    },
  }, {});
  controller.onTurnStart(0);
  assert.equal(controller.checkToolCall('need_more_evidence', { missing: 'x', reason: 'x' }), undefined);
  assert.equal(controller.checkToolCall('read', { path: 'src/a.js' }), undefined);
  assert.equal(controller.checkToolCall('edit', { path: 'src/a.js' }), undefined);
  controller.onToolExecutionEnd('edit', false, { madeProgress: false });
  assert.equal(controller.turnMadeProgress, false);
  assert.match(
    controller.checkToolCall('need_more_evidence', { missing: 'y', reason: 'y' }).reason,
    /already used since the last successful/,
  );
});

test('write no-op does not clear an outstanding loop steer', () => {
  const guard = new SemanticLoopGuard();
  for (let index = 0; index < 3; index += 1) {
    var failure = observation(guard, {
      tool: 'edit',
      input: { path: 'src/a.js', oldText: 'variant-' + index },
      result: { content: [{ type: 'text', text: 'oldText not found at line ' + (10 + index) }] },
      isError: true,
    });
  }
  assert.equal(failure.action, 'steer');
  const noOp = observation(guard, {
    tool: 'write',
    input: { path: 'src/a.js', content: 'same' },
    repositoryStateBefore: 'state-a',
    repositoryStateAfter: 'state-a',
  });
  assert.equal(noOp.classification, 'success_no_change');
  const nextFailure = observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js', oldText: 'variant-4' },
    result: { content: [{ type: 'text', text: 'oldText not found at line 99' }] },
    isError: true,
  });
  assert.equal(nextFailure.action, 'abort');
});

test('empty successful bash output does not clear an outstanding loop steer', () => {
  const guard = new SemanticLoopGuard();
  failedEditSteer(guard);

  const noOp = observation(guard, {
    tool: 'bash',
    input: { command: 'git status --short -- src/a.js' },
    // Pi 0.87.x built-in bash returns this exact successful empty-output shape:
    // details is undefined unless output is truncated.
    result: { content: [{ type: 'text', text: '(no output)' }] },
  });
  assert.equal(noOp.classification, 'success_no_evidence');
  assert.equal(noOp.noOp, true);

  const nextFailure = observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js', oldText: 'missing-4' },
    result: { content: [{ type: 'text', text: 'oldText not found' }] },
    isError: true,
  });
  assert.equal(nextFailure.action, 'abort');
});

test('modern structured bash output also identifies an empty successful call', () => {
  const guard = new SemanticLoopGuard();
  const noOp = observation(guard, {
    tool: 'bash',
    input: { command: 'git status --short -- src/a.js' },
    result: {
      content: [{ type: 'text', text: '(no output)' }],
      structuredContent: {
        output: '',
        truncated: false,
        exit_code: 0,
        wall_time_seconds: 0.1,
      },
    },
  });
  assert.equal(noOp.classification, 'success_no_evidence');
});

test('empty repository search does not clear an outstanding loop steer', () => {
  const guard = new SemanticLoopGuard();
  failedEditSteer(guard);

  const emptySearch = emptyRepoSearch(guard, 'definitely-missing-symbol');
  assert.equal(emptySearch.classification, 'success_no_evidence');

  const nextFailure = observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js', oldText: 'missing-4' },
    result: { content: [{ type: 'text', text: 'oldText not found' }] },
    isError: true,
  });
  assert.equal(nextFailure.action, 'abort');
});

test('repeated identical empty evidence trips then aborts', () => {
  const guard = new SemanticLoopGuard();
  assert.equal(emptyRepoSearch(guard, 'same-missing-symbol').tripped, false);
  assert.equal(emptyRepoSearch(guard, 'same-missing-symbol').tripped, false);
  const third = emptyRepoSearch(guard, 'same-missing-symbol');
  assert.equal(third.action, 'steer');
  assert.equal(third.reason, 'repeated_no_evidence');
  assert.equal(third.revisitCount, 3);

  const fourth = emptyRepoSearch(guard, 'same-missing-symbol');
  assert.equal(fourth.action, 'abort');
  assert.equal(fourth.reason, 'repeated_no_evidence');
});

test('different empty evidence requests do not collapse into one repeated family', () => {
  const guard = new SemanticLoopGuard();
  for (const query of ['missing-a', 'missing-b', 'missing-c', 'missing-d']) {
    const result = emptyRepoSearch(guard, query);
    assert.equal(result.classification, 'success_no_evidence');
    assert.equal(result.tripped, false);
  }
});

test('meaningful repository evidence clears an outstanding loop steer', () => {
  const guard = new SemanticLoopGuard();
  failedEditSteer(guard);

  const usefulSearch = observation(guard, {
    tool: 'repo_search',
    input: { query: 'ProgressController' },
    result: {
      content: [{ type: 'text', text: '{"matches":[{"path":"scripts/pi-common/progress-controller.mjs"}]}' }],
      details: {
        kind: 'content',
        query: 'ProgressController',
        matches: [{ path: 'scripts/pi-common/progress-controller.mjs', line: 1 }],
        truncated: false,
      },
    },
  });
  assert.equal(usefulSearch.classification, 'success_new_observation');

  const nextFailure = observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js', oldText: 'missing-4' },
    result: { content: [{ type: 'text', text: 'oldText not found' }] },
    isError: true,
  });
  assert.equal(nextFailure.action, 'steer');
});

test('meaningful evidence consumes a pending declaration without changing its normal classification', () => {
  const guard = new SemanticLoopGuard();
  observation(guard, {
    tool: 'need_more_evidence',
    input: { missing: 'where Foo is defined', reason: 'need the implementation target' },
    result: { ok: true },
  });

  const useful = observation(guard, {
    tool: 'repo_search',
    input: { query: 'Foo' },
    result: {
      details: { matches: [{ path: 'src/foo.js', line: 7 }] },
      content: [{ type: 'text', text: 'src/foo.js:7' }],
    },
  });
  assert.equal(useful.classification, 'success_new_observation');
  assert.equal(useful.declaredEvidence, true);

  const nextEmpty = observation(guard, {
    tool: 'repo_search',
    input: { query: 'Bar' },
    result: { details: { matches: [] } },
  });
  assert.equal(nextEmpty.classification, 'success_no_evidence');
});

test('declared missing fact grants exactly one empty evidence result', () => {
  const guard = new SemanticLoopGuard();
  failedEditSteer(guard);

  const declaration = observation(guard, {
    tool: 'need_more_evidence',
    input: { missing: 'whether Foo exists', reason: 'avoid editing the wrong target' },
    result: { ok: true },
  });
  assert.equal(declaration.classification, 'success_neutral');

  const firstEmpty = emptyRepoSearch(guard, 'Foo');
  assert.equal(firstEmpty.classification, 'success_declared_evidence');
  assert.equal(firstEmpty.declaredEvidence, true);

  const secondEmpty = emptyRepoSearch(guard, 'Bar');
  assert.equal(secondEmpty.classification, 'success_no_evidence');
  assert.equal(secondEmpty.declaredEvidence, undefined);
});

test('failed or blocked evidence call does not consume declared evidence credit', () => {
  const guard = new SemanticLoopGuard();
  const declaration = observation(guard, {
    tool: 'need_more_evidence',
    input: { missing: 'whether Foo exists', reason: 'avoid editing the wrong target' },
    result: { ok: true },
  });
  assert.equal(declaration.classification, 'success_neutral');

  const blocked = observation(guard, {
    tool: 'repo_search',
    input: { query: 'Foo' },
    result: { block: true, reason: 'temporarily unavailable' },
    blocked: true,
  });
  assert.equal(blocked.classification, 'blocked');

  const failed = observation(guard, {
    tool: 'repo_search',
    input: { query: 'Foo' },
    result: { content: [{ type: 'text', text: 'backend unavailable' }] },
    isError: true,
  });
  assert.equal(failed.classification, 'error');

  const successfulEmpty = emptyRepoSearch(guard, 'Foo');
  assert.equal(successfulEmpty.classification, 'success_declared_evidence');
  assert.equal(successfulEmpty.declaredEvidence, true);
});

test('successful validation still clears an outstanding loop steer', () => {
  const guard = new SemanticLoopGuard();
  failedEditSteer(guard);

  const validation = observation(guard, {
    tool: 'run_check',
    input: { kind: 'pytest', targets: ['tests/test_a.py'] },
    result: {
      content: [{ type: 'text', text: '{"status":"pass","summary":"1 passed"}' }],
      details: { status: 'pass', summary: '1 passed', diagnostics: [], stdout_tail: '1 passed', stderr_tail: '' },
    },
  });
  assert.equal(validation.classification, 'success_new_observation');

  const nextFailure = observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js', oldText: 'missing-4' },
    result: { content: [{ type: 'text', text: 'oldText not found' }] },
    isError: true,
  });
  assert.equal(nextFailure.action, 'steer');
});

test('real mutation resets repeated no-evidence state', () => {
  const guard = new SemanticLoopGuard();
  emptyRepoSearch(guard, 'same-missing-symbol');
  emptyRepoSearch(guard, 'same-missing-symbol');
  assert.equal(emptyRepoSearch(guard, 'same-missing-symbol').action, 'steer');

  const mutation = observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js', oldText: 'a', newText: 'b' },
    repositoryStateBefore: 'state-a',
    repositoryStateAfter: 'state-b',
    mutationChanged: true,
  });
  assert.equal(mutation.classification, 'success_changed');
  assert.equal(mutation.tripped, false);

  const afterMutation = emptyRepoSearch(guard, 'same-missing-symbol');
  assert.equal(afterMutation.classification, 'success_no_evidence');
  assert.equal(afterMutation.tripped, false);
});

test('target-local no-op stays a no-op when another call changed repository state', () => {
  const guard = new SemanticLoopGuard();
  const result = observation(guard, {
    tool: 'write',
    input: { path: 'src/a.js', content: 'same content' },
    repositoryStateBefore: 'repo-before',
    repositoryStateAfter: 'repo-after-because-of-sibling-call',
    mutationChanged: false,
  });
  assert.equal(result.classification, 'success_no_change');
  assert.equal(result.tripped, false);
});

test('A B A C A repository cycle trips revisit protection', () => {
  const guard = new SemanticLoopGuard();
  assert.equal(observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js' },
    repositoryStateBefore: 'A',
    repositoryStateAfter: 'B',
  }).tripped, false);
  assert.equal(observation(guard, {
    tool: 'rollback_last_mutation',
    input: { reason: 'undo B' },
    repositoryStateBefore: 'B',
    repositoryStateAfter: 'A',
  }).tripped, false);
  assert.equal(observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js', oldText: 'different' },
    repositoryStateBefore: 'A',
    repositoryStateAfter: 'C',
  }).tripped, false);
  const revisit = observation(guard, {
    tool: 'rollback_last_mutation',
    input: { reason: 'undo C' },
    repositoryStateBefore: 'C',
    repositoryStateAfter: 'A',
  });
  assert.equal(revisit.action, 'steer');
  assert.equal(revisit.reason, 'repository_state_revisit');
  assert.equal(revisit.revisitCount, 3);
});

test('a genuinely new repository state relaxes an outstanding stuck trip', () => {
  const guard = new SemanticLoopGuard();
  for (let index = 0; index < 3; index += 1) {
    var failure = observation(guard, {
      tool: 'edit',
      input: { path: 'src/a.js', oldText: 'variant-' + index },
      result: { content: [{ type: 'text', text: 'oldText not found at line ' + index }] },
      isError: true,
    });
  }
  assert.equal(failure.action, 'steer');
  const changed = observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js' },
    repositoryStateBefore: 'A',
    repositoryStateAfter: 'B',
  });
  assert.equal(changed.classification, 'success_changed');
  for (let index = 0; index < 3; index += 1) {
    failure = observation(guard, {
      tool: 'edit',
      input: { path: 'src/a.js', oldText: 'new-' + index },
      result: { content: [{ type: 'text', text: 'oldText not found at line ' + (20 + index) }] },
      isError: true,
    });
  }
  assert.equal(failure.action, 'steer');
});

test('new repository progress clears stale observation strikes after a steer', () => {
  const guard = new SemanticLoopGuard();
  assert.equal(observation(guard).tripped, false);
  assert.equal(observation(guard).tripped, false);
  assert.equal(observation(guard).action, 'steer');
  const changed = observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js' },
    repositoryStateBefore: 'A',
    repositoryStateAfter: 'B',
    mutationChanged: true,
  });
  assert.equal(changed.classification, 'success_changed');
  assert.equal(observation(guard).tripped, false);
});

test('one rollback to an earlier state is allowed', () => {
  const guard = new SemanticLoopGuard();
  observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js' },
    repositoryStateBefore: 'A',
    repositoryStateAfter: 'B',
  });
  const rollback = observation(guard, {
    tool: 'rollback_last_mutation',
    input: { reason: 'wrong approach' },
    repositoryStateBefore: 'B',
    repositoryStateAfter: 'A',
  });
  assert.equal(rollback.tripped, false);
  assert.equal(rollback.classification, 'returned_to_seen_state');
});

test('slightly different failed anchors share one failed-strategy family', () => {
  const guard = new SemanticLoopGuard();
  const calls = [1, 2, 3].map(index => observation(guard, {
    tool: 'edit',
    input: { path: 'src/a.js', oldText: 'anchor variant ' + index },
    result: { content: [{ type: 'text', text: 'oldText not found near line ' + (40 + index) }] },
    isError: true,
  }));
  assert.equal(calls[0].tripped, false);
  assert.equal(calls[1].tripped, false);
  assert.equal(calls[2].action, 'steer');
  assert.equal(calls[2].reason, 'repeated_failed_strategy');
});

test('new reads do not clear repeated failed-strategy strikes', () => {
  const guard = new SemanticLoopGuard();
  for (let index = 0; index < 12; index += 1) {
    const failed = observation(guard, {
      tool: 'edit',
      input: { path: 'src/a.js', oldText: `missing-${index}` },
      result: { content: [{ type: 'text', text: 'oldText not found' }] },
      isError: true,
    });
    if (index === 2) assert.equal(failed.action, 'steer');
    if (index > 2) assert.equal(failed.tripped, true);
    observation(guard, {
      tool: 'read',
      input: { path: 'src/a.js', offset: index * 20 },
      result: { text: `new slice ${index}` },
    });
  }
});

test('blocked tool calls are classified as repeated failed strategies', () => {
  const guard = new SemanticLoopGuard();
  const call = () => guard.observe({
    stage: 'implementer',
    tool: 'read',
    input: { path: 'src/a.js' },
    result: { block: true, reason: 'not allowed' },
    blocked: true,
    productiveState: 'action_required',
  });
  assert.equal(call().classification, 'blocked');
  assert.equal(call().classification, 'blocked');
  assert.equal(call().action, 'steer');
});

test('loop guard environment limits fall back and threshold is bounded by window', () => {
  assert.deepEqual(loopGuardLimits({ PI_LOOP_GUARD_WINDOW: 'abc', PI_LOOP_GUARD_THRESHOLD: '0' }), {
    windowSize: 8,
    revisitThreshold: 3,
  });
  assert.deepEqual(loopGuardLimits({ PI_LOOP_GUARD_WINDOW: '4', PI_LOOP_GUARD_THRESHOLD: '10' }), {
    windowSize: 4,
    revisitThreshold: 4,
  });
  assert.deepEqual(loopGuardLimits({ PI_LOOP_GUARD_WINDOW: '1000', PI_LOOP_GUARD_THRESHOLD: '1000' }), {
    windowSize: 64,
    revisitThreshold: 64,
  });
});

test('exact repeated-call protection remains active', () => {
  const controller = new ProgressController({
    maxTurns: 100,
    repeatThreshold: 3,
    requireComplexity: false,
  }, {});
  controller.onTurnStart(0);
  assert.equal(controller.checkToolCall('read', { path: 'src/a.js' }), undefined);
  assert.equal(controller.checkToolCall('read', { path: 'src/a.js' }), undefined);
  assert.equal(controller.checkToolCall('read', { path: 'src/a.js' }), undefined);
  assert.match(controller.checkToolCall('read', { path: 'src/a.js' }).reason, /exact read call/);
});

test('failed tool execution is never productive progress', () => {
  const controller = new ProgressController({
    maxTurns: 100,
    repeatThreshold: 3,
    requireComplexity: false,
  }, {});
  controller.onTurnStart(0);
  controller.onToolExecutionEnd('edit', true, { madeProgress: true });
  assert.equal(controller.turnMadeProgress, false);
});

test('repository fingerprint includes tracked file mode changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-mode-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['config', 'core.filemode', 'true'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o644 });
    execFileSync('git', ['add', 'run.sh'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
    const before = repositoryStateFingerprint(dir);
    fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
    const after = repositoryStateFingerprint(dir);
    assert.notEqual(after, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repository fingerprint includes untracked file content and mode changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-untracked-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
    const file = path.join(dir, 'new-file.txt');
    fs.writeFileSync(file, 'content one', { mode: 0o644 });
    const initial = repositoryStateFingerprint(dir);
    fs.writeFileSync(file, 'content two', { mode: 0o644 });
    const changedContent = repositoryStateFingerprint(dir);
    assert.notEqual(changedContent, initial);
    fs.chmodSync(file, 0o755);
    const changedMode = repositoryStateFingerprint(dir);
    assert.notEqual(changedMode, changedContent);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repository fingerprint failure returns null instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-no-head-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    assert.equal(repositoryStateFingerprint(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal submission is never flagged as a loop', () => {
  const guard = new SemanticLoopGuard();
  for (let index = 0; index < 3; index += 1) observation(guard);
  const terminal = observation(guard, {
    tool: 'submit_result',
    input: { summary: 'done' },
    result: { ok: true },
  });
  assert.equal(terminal.classification, 'terminal');
  assert.equal(terminal.tripped, false);
});

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Runs the real runtime extension against a mock `pi` in a child process.
// `typebox` is stubbed because only handler wiring is exercised here.
function runRuntimeScenario(body, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-runtime-'));
  const issueContext = path.join(dir, 'issue.json');
  const loader = path.join(dir, 'loader.mjs');
  try {
    fs.writeFileSync(issueContext, JSON.stringify({ title: 'test', body: 'test' }));
    fs.writeFileSync(loader, `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'typebox') {
          const source = 'export const Type = new Proxy({}, { get: () => (...args) => ({}) });';
          return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
    `);
    const runtimeUrl = new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href;
    const controllerUrl = new URL('../scripts/pi-common/progress-controller.mjs', import.meta.url).href;
    const journalUrl = new URL('../scripts/pi-common/mutation-journal.mjs', import.meta.url).href;
    const snapshotUrl = new URL('../scripts/pi-common/mutation-snapshot.mjs', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      const RUNTIME_URL = ${JSON.stringify(runtimeUrl)};
      const CONTROLLER_URL = ${JSON.stringify(controllerUrl)};
      const JOURNAL_URL = ${JSON.stringify(journalUrl)};
      const SNAPSHOT_URL = ${JSON.stringify(snapshotUrl)};
      const handlers = new Map();
      const messages = [];
      const registeredTools = new Map();
      // This mock exercises loop-guard behavior, not tool-surface policy. Mirror Pi's mutable
      // active surface so runtime setActiveTools() calls remain observable on later tool calls.
      let activeTools = ['read', 'write', 'safe_edit', 'rollback_last_mutation'];
      const pi = {
        on: (name, handler) => handlers.set(name, handler),
        registerTool: tool => registeredTools.set(tool.name, tool),
        getActiveTools: () => [...activeTools],
        setActiveTools: names => { activeTools = [...names]; },
        sendUserMessage: async (...args) => messages.push(args),
        setModel: async () => true,
      };
      ${body}
    `;
    const result = spawnSync(process.execPath, [
      '--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', script,
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PI_STAGE: 'implementer',
        PI_ISSUE: '1',
        PI_ISSUE_CONTEXT: issueContext,
        GITHUB_WORKSPACE: REPO_ROOT,
        ...env,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runtime mock uses the repeated-no-evidence steer message', () => {
  const result = runRuntimeScenario(`
    const { ProgressController } = await import(CONTROLLER_URL);
    ProgressController.prototype.checkToolCall = () => undefined;
    const { default: install } = await import(RUNTIME_URL);
    install(pi);
    const ctx = { cwd: "/tmp", abort: () => {} };
    await handlers.get('tool_call')(
      { toolCallId: 'empty-read', toolName: 'read', input: { path: 'empty.txt' } },
      ctx,
    );
    await handlers.get('tool_execution_end')(
      { toolCallId: 'empty-read', toolName: 'read', isError: false, result: { content: [] } },
      ctx,
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0][0], /repeated evidence calls completed successfully but returned no usable evidence/);
    console.log('NO_EVIDENCE_STEER_MESSAGE_OK');
  `, {
    PI_LOOP_GUARD_WINDOW: '4',
    PI_LOOP_GUARD_THRESHOLD: '1',
  });
  assert.match(result.stdout, /NO_EVIDENCE_STEER_MESSAGE_OK/);
});

test('runtime mock attributes interleaved mutations by toolCallId and aborts after a steer', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-runtime-repo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/dev', 'HEAD'], { cwd: repo });

    const result = runRuntimeScenario(`
      // Isolate handler wiring from the productive-progress gating rules.
      const { ProgressController } = await import(CONTROLLER_URL);
      ProgressController.prototype.checkToolCall = () => undefined;
      const { default: install } = await import(RUNTIME_URL);
      install(pi);
      const repo = ${JSON.stringify(repo)};
      let aborts = 0;
      const ctx = { cwd: repo, abort: () => { aborts += 1; } };
      const call = (toolCallId, toolName, input) =>
        handlers.get('tool_call')({ toolCallId, toolName, input }, ctx);
      const end = (toolCallId, toolName, isError = false) =>
        handlers.get('tool_execution_end')({ toolCallId, toolName, isError, result: { content: [] } }, ctx);

      // Two mutations start before either finishes. Only b.txt changes.
      assert.equal(await call('edit-a', 'safe_edit', { path: 'a.txt', operation: 'replace' }), undefined);
      assert.equal(await call('write-b', 'write', { path: 'b.txt' }), undefined);
      fs.writeFileSync(path.join(repo, 'b.txt'), 'b changed\\n');
      await end('write-b', 'write');
      assert.equal(messages.length, 0, 'real change on b.txt must not trip');
      await end('edit-a', 'safe_edit');
      assert.equal(messages.length, 1, 'a.txt no-op must be attributed to edit-a and steer');
      assert.match(messages[0][0], /RUNTIME LOOP GUARD/);
      assert.equal(aborts, 0);

      // Repeating the no-op after the steer aborts the stage.
      await call('edit-a-2', 'safe_edit', { path: 'a.txt', operation: 'replace' });
      await end('edit-a-2', 'safe_edit');
      assert.equal(aborts, 1);
      console.log('INTERLEAVED_LOOP_INTEGRATION_OK');
    `, {
      PI_LOOP_GUARD_WINDOW: '4',
      PI_LOOP_GUARD_THRESHOLD: '1',
      PI_ACCEPTED_MUTATION_SCOPE_STATE: "{\"schema_version\":1,\"accepted\":[{\"path\":\"a.txt\",\"rationale\":\"Loop-guard test mutates the known a.txt fixture.\"},{\"path\":\"b.txt\",\"rationale\":\"Loop-guard test mutates the known b.txt fixture.\"}],\"temporary\":[],\"baseline\":[]}",
    });
    assert.match(result.stdout, /INTERLEAVED_LOOP_INTEGRATION_OK/);
    assert.match(result.stdout, /PI_LOOP_GUARD .*"tool":"safe_edit".*"noOp":true/);
    assert.match(result.stderr, /PI_LOOP_GUARD_ABORT/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('#424 parent rollback follows shared fork journal order instead of stale process-local identity', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cross-process-rollback-'));
  const journalFile = path.join(os.tmpdir(), `pi-cross-process-journal-${process.pid}-${Date.now()}.json`);
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    for (const name of ['parent.txt', 'fork-one.txt', 'fork-two.txt']) {
      fs.writeFileSync(path.join(repo, name), name + ':base\n');
    }
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/dev', 'HEAD'], { cwd: repo });

    const result = runRuntimeScenario(`
      const { ProgressController } = await import(CONTROLLER_URL);
      ProgressController.prototype.checkToolCall = () => undefined;
      const { default: install } = await import(RUNTIME_URL);
      install(pi);
      const repo = ${JSON.stringify(repo)};
      const ctx = { cwd: repo, abort: () => {} };
      const call = (id, toolName, input) =>
        handlers.get('tool_call')({ toolCallId: id, toolName, input }, ctx);
      const end = (id, toolName) =>
        handlers.get('tool_execution_end')({ toolCallId: id, toolName, isError: false, result: { content: [] } }, ctx);

      // Parent records P1 in its own process state.
      assert.equal(await call('parent-p1', 'write', { path: 'parent.txt' }), undefined);
      fs.writeFileSync(path.join(repo, 'parent.txt'), 'parent:P1\\n');
      await end('parent-p1', 'write');

      // Separate process models the coding-session fork and appends F1 then F2 to the same sidecar.
      const { spawnSync } = await import('node:child_process');
      const childProgram = [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const journal = await import(" + JSON.stringify(JOURNAL_URL) + ");",
        "const snapshots = await import(" + JSON.stringify(SNAPSHOT_URL) + ");",
        "const root = process.argv[1];",
        "const mutate = (relative, content) => {",
        "  const before = snapshots.captureMutationSnapshot(root, relative);",
        "  fs.writeFileSync(path.join(root, relative), content);",
        "  const after = snapshots.captureMutationSnapshot(root, relative);",
        "  journal.recordSuccessfulMutation({ cwd: root, before, after, tool: 'write', disposition: 'publishable', env: process.env });",
        "};",
        "mutate('fork-one.txt', 'fork-one:F1\\n');",
        "mutate('fork-two.txt', 'fork-two:F2\\n');",
      ].join('\\n');
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', childProgram, repo], {
        encoding: 'utf8',
        env: process.env,
      });
      assert.equal(child.status, 0, child.stderr);

      const rollback = registeredTools.get('rollback_last_mutation');
      const rolled = await rollback.execute('parent-rollback', { reason: 'undo shared latest mutation' }, null, null, ctx);
      assert.match(rolled.content[0].text, /shared latest recorded mutation/);
      assert.equal(fs.readFileSync(path.join(repo, 'parent.txt'), 'utf8'), 'parent:P1\\n');
      assert.equal(fs.readFileSync(path.join(repo, 'fork-one.txt'), 'utf8'), 'fork-one:F1\\n');
      assert.equal(fs.readFileSync(path.join(repo, 'fork-two.txt'), 'utf8'), 'fork-two.txt:base\\n');
      console.log('CROSS_PROCESS_ROLLBACK_ORDER_OK');
    `, {
      PI_MUTATION_JOURNAL_FILE: journalFile,
      PI_ACCEPTED_MUTATION_SCOPE_STATE: JSON.stringify({
        schema_version: 1,
        accepted: [
          { path: 'parent.txt', rationale: 'Cross-process rollback regression parent path.' },
          { path: 'fork-one.txt', rationale: 'Cross-process rollback regression fork path one.' },
          { path: 'fork-two.txt', rationale: 'Cross-process rollback regression fork path two.' },
        ],
        temporary: [],
        baseline: [],
      }),
    });
    assert.match(result.stdout, /CROSS_PROCESS_ROLLBACK_ORDER_OK/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(journalFile, { force: true });
  }
});

test('#424 parent rollback refuses an older journal entry when fork latest is local-only', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cross-process-local-only-'));
  const journalFile = path.join(os.tmpdir(), `pi-cross-process-local-only-journal-${process.pid}-${Date.now()}.json`);
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'parent.txt'), 'parent:base\n');
    fs.writeFileSync(path.join(repo, 'fork.txt'), 'fork:base\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/dev', 'HEAD'], { cwd: repo });

    const result = runRuntimeScenario(`
      const { ProgressController } = await import(CONTROLLER_URL);
      ProgressController.prototype.checkToolCall = () => undefined;
      const { default: install } = await import(RUNTIME_URL);
      install(pi);
      const repo = ${JSON.stringify(repo)};
      const ctx = { cwd: repo, abort: () => {} };

      assert.equal(await handlers.get('tool_call')({
        toolCallId: 'parent-p1',
        toolName: 'write',
        input: { path: 'parent.txt' },
      }, ctx), undefined);
      fs.writeFileSync(path.join(repo, 'parent.txt'), 'parent:P1\\n');
      await handlers.get('tool_execution_end')({
        toolCallId: 'parent-p1',
        toolName: 'write',
        isError: false,
        result: { content: [] },
      }, ctx);

      const { spawnSync } = await import('node:child_process');
      const childProgram = [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const journal = await import(" + JSON.stringify(JOURNAL_URL) + ");",
        "const snapshots = await import(" + JSON.stringify(SNAPSHOT_URL) + ");",
        "const root = process.argv[1];",
        "const relative = 'fork.txt';",
        "const before = snapshots.captureMutationSnapshot(root, relative);",
        "fs.writeFileSync(path.join(root, relative), 'fork:LOCAL\\n');",
        "const after = snapshots.captureMutationSnapshot(root, relative);",
        "journal.markMutationJournalLocalOnly({ cwd: root, after, tool: 'write', env: process.env });",
      ].join('\\n');
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', childProgram, repo], {
        encoding: 'utf8',
        env: process.env,
      });
      assert.equal(child.status, 0, child.stderr);

      const rollback = registeredTools.get('rollback_last_mutation');
      await assert.rejects(
        rollback.execute('parent-rollback', { reason: 'must not hit stale P1' }, null, null, ctx),
        error => error.code === 'mutation_rollback_latest_local_only_unavailable',
      );
      assert.equal(fs.readFileSync(path.join(repo, 'parent.txt'), 'utf8'), 'parent:P1\\n');
      assert.equal(fs.readFileSync(path.join(repo, 'fork.txt'), 'utf8'), 'fork:LOCAL\\n');
      console.log('CROSS_PROCESS_LOCAL_ONLY_REFUSAL_OK');
    `, {
      PI_MUTATION_JOURNAL_FILE: journalFile,
      PI_ACCEPTED_MUTATION_SCOPE_STATE: JSON.stringify({
        schema_version: 1,
        accepted: [
          { path: 'parent.txt', rationale: 'Cross-process local-only regression parent path.' },
          { path: 'fork.txt', rationale: 'Cross-process local-only regression fork path.' },
        ],
        temporary: [],
        baseline: [],
      }),
    });
    assert.match(result.stdout, /CROSS_PROCESS_LOCAL_ONLY_REFUSAL_OK/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(journalFile, { force: true });
  }
});

test('#424 full persistent journal degrades to local rollback instead of blocking the next edit', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-journal-degrade-runtime-'));
  const journalFile = path.join(os.tmpdir(), `pi-full-journal-${process.pid}-${Date.now()}.json`);
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'target.txt'), 'before\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/dev', 'HEAD'], { cwd: repo });

    const entries = Array.from({ length: 256 }, (_, index) => ({
      id: `mutation-00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      path: `historical-${index}.tmp`,
      tool: 'write',
      disposition: 'temporary',
      prior: { existed: false },
      post: { exists: false },
    }));
    fs.writeFileSync(journalFile, JSON.stringify({ schema_version: 1, entries }));

    const result = runRuntimeScenario(`
      const { ProgressController } = await import(CONTROLLER_URL);
      ProgressController.prototype.checkToolCall = () => undefined;
      const { default: install } = await import(RUNTIME_URL);
      install(pi);
      const repo = ${JSON.stringify(repo)};
      const ctx = { cwd: repo, abort: () => {} };

      const callResult = await handlers.get('tool_call')({
        toolCallId: 'overflow-write',
        toolName: 'write',
        input: { path: 'target.txt', content: 'after\\n' },
      }, ctx);
      assert.equal(callResult, undefined, 'capacity exhaustion must not block the mutation');

      fs.writeFileSync(path.join(repo, 'target.txt'), 'after\\n');
      await handlers.get('tool_execution_end')({
        toolCallId: 'overflow-write',
        toolName: 'write',
        isError: false,
        result: { content: [] },
      }, ctx);
      assert.equal(fs.readFileSync(path.join(repo, 'target.txt'), 'utf8'), 'after\\n');

      const rollback = registeredTools.get('rollback_last_mutation');
      assert.ok(rollback);
      await rollback.execute('rollback-local', { reason: 'exercise local fallback' }, null, null, ctx);
      assert.equal(fs.readFileSync(path.join(repo, 'target.txt'), 'utf8'), 'before\\n');
      console.log('JOURNAL_CAPACITY_DEGRADES_OK');
    `, {
      PI_MUTATION_JOURNAL_FILE: journalFile,
      PI_ACCEPTED_MUTATION_SCOPE_STATE: JSON.stringify({
        schema_version: 1,
        accepted: [{ path: 'target.txt', rationale: 'Runtime overflow regression target.' }],
        temporary: [],
        baseline: [],
      }),
    });
    assert.match(result.stdout, /JOURNAL_CAPACITY_DEGRADES_OK/);
    assert.match(result.stderr, /PI_MUTATION_JOURNAL_DEGRADED/);
    assert.match(result.stderr, /PI_MUTATION_JOURNAL_LOCAL_FALLBACK/);
    assert.doesNotMatch(result.stderr, /PI_MUTATION_JOURNAL_REVERTED/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(journalFile, { force: true });
  }
});

test('runtime mock does not treat unknown repository state as a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-runtime-nogit-'));
  try {
    const result = runRuntimeScenario(`
      const { ProgressController } = await import(CONTROLLER_URL);
      ProgressController.prototype.checkToolCall = () => undefined;
      const { default: install } = await import(RUNTIME_URL);
      install(pi);
      let aborts = 0;
      const ctx = { cwd: ${JSON.stringify(dir)}, abort: () => { aborts += 1; } };
      // Not a git repository: fingerprints are null and rollback has no snapshot.
      for (let index = 0; index < 3; index += 1) {
        const id = 'rollback-' + index;
        assert.equal(await handlers.get('tool_call')({ toolCallId: id, toolName: 'rollback_last_mutation', input: {} }, ctx), undefined);
        await handlers.get('tool_execution_end')({ toolCallId: id, toolName: 'rollback_last_mutation', isError: false, result: {} }, ctx);
      }
      assert.equal(messages.length, 0);
      assert.equal(aborts, 0);
      console.log('UNKNOWN_STATE_INTEGRATION_OK');
    `, {
      PI_LOOP_GUARD_WINDOW: '4',
      PI_LOOP_GUARD_THRESHOLD: '1',
    });
    assert.match(result.stdout, /UNKNOWN_STATE_INTEGRATION_OK/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime mock classifies blocked tool calls without tool_execution_end', () => {
  const result = runRuntimeScenario(`
    const { default: install } = await import(RUNTIME_URL);
    install(pi);
    const result = await handlers.get('tool_call')(
      { toolName: 'read', toolCallId: 'blocked-1', input: { path: 'other.md' } },
      { abort: () => {} },
    );
    assert.equal(result.block, true);
    assert.equal(messages.length, 1);
    console.log('BLOCKED_LOOP_INTEGRATION_OK');
  `, {
    PI_LOOP_GUARD_WINDOW: '2',
    PI_LOOP_GUARD_THRESHOLD: '1',
  });
  assert.match(result.stdout, /BLOCKED_LOOP_INTEGRATION_OK/);
});

test('runtime mock short-circuits an identical write without touching the filesystem', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-runtime-write-noop-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'same content\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    const before = fs.statSync(path.join(repo, 'a.txt')).mtimeMs;

    const result = runRuntimeScenario(`
      const { ProgressController } = await import(CONTROLLER_URL);
      ProgressController.prototype.checkToolCall = () => undefined;
      const { default: install } = await import(RUNTIME_URL);
      install(pi);
      const repo = ${JSON.stringify(repo)};
      const ctx = { cwd: repo, abort: () => {} };
      let endCalls = 0;
      const realEnd = handlers.get('tool_execution_end');
      handlers.set('tool_execution_end', async (...args) => { endCalls += 1; return realEnd(...args); });

      const outcome = await handlers.get('tool_call')(
        { toolCallId: 'write-1', toolName: 'write', input: { path: 'a.txt', content: 'same content\\n' } },
        ctx,
      );
      assert.equal(outcome.block, true);
      assert.match(outcome.reason, /NO CHANGE/);
      assert.equal(endCalls, 0, 'a short-circuited write must never reach tool_execution_end');
      console.log('WRITE_NOOP_INTEGRATION_OK');
    `, {
      PI_LOOP_GUARD_WINDOW: '4',
      PI_LOOP_GUARD_THRESHOLD: '3',
    });
    assert.match(result.stdout, /WRITE_NOOP_INTEGRATION_OK/);
    assert.equal(fs.statSync(path.join(repo, 'a.txt')).mtimeMs, before);
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'same content\n');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('runtime mock treats a repeated identical write as a loop, not progress', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-runtime-write-repeat-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'same content\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

    const result = runRuntimeScenario(`
      const { ProgressController } = await import(CONTROLLER_URL);
      ProgressController.prototype.checkToolCall = () => undefined;
      const { default: install } = await import(RUNTIME_URL);
      install(pi);
      const repo = ${JSON.stringify(repo)};
      const ctx = { cwd: repo, abort: () => {} };
      const outcome = await handlers.get('tool_call')(
        { toolCallId: 'write-1', toolName: 'write', input: { path: 'a.txt', content: 'same content\\n' } },
        ctx,
      );
      assert.equal(outcome.block, true);
      assert.equal(messages.length, 1, 'a no-op write must still steer at the configured revisit threshold');
      assert.match(messages[0][0], /RUNTIME LOOP GUARD/);
      console.log('WRITE_NOOP_LOOP_INTEGRATION_OK');
    `, {
      PI_LOOP_GUARD_WINDOW: '4',
      PI_LOOP_GUARD_THRESHOLD: '1',
    });
    assert.match(result.stdout, /WRITE_NOOP_LOOP_INTEGRATION_OK/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('control scenario read semantic lookup source edit verify submit completes without a warning', () => {
  const guard = new SemanticLoopGuard();
  const results = [
    observation(guard, { tool: 'read', result: { source: 'target' } }),
    observation(guard, { tool: 'lsp_find_symbol', input: { symbol: 'Foo' }, result: { path: 'src/foo.js' } }),
    observation(guard, { tool: 'read', input: { path: 'src/foo.js' }, result: { source: 'resolved source' } }),
    observation(guard, {
      tool: 'safe_edit',
      input: { path: 'src/foo.js', operation: 'replace' },
      repositoryStateBefore: 'A',
      repositoryStateAfter: 'B',
    }),
    observation(guard, { tool: 'read', input: { path: 'src/foo.test.js' }, result: { verification: 'focused pass' } }),
    observation(guard, { tool: 'submit_result', result: { ok: true } }),
  ];
  assert.equal(results.some(result => result.tripped), false);
});
