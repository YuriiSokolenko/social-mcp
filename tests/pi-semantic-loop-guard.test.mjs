import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ProgressController } from '../scripts/pi-common/progress-controller.mjs';
import { safeEdit } from '../scripts/pi-common/safe-edit.mjs';
import {
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
  observation(guard, { tool: 'set_response_budget', result: { budget: 'short' } });
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

test('runtime wires semantic loop metrics, repository state, and result observation', () => {
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(runtime, /SemanticLoopGuard/);
  assert.match(runtime, /repositoryStateFingerprint/);
  assert.match(runtime, /event\.result/);
  assert.match(runtime, /PI_LOOP_GUARD_STEER/);
  assert.match(runtime, /PI_LOOP_GUARD_ABORT/);
  assert.match(runtime, /madeProgress: effectiveProgress/);
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
