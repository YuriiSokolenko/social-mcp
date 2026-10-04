import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SemanticLoopGuard,
  submissionObligation,
} from '../scripts/pi-common/semantic-loop-guard.mjs';
import {
  compactTerminalRecoveryPayload,
  selectTerminalRecovery,
  terminalRecoveryGuidance,
} from '../scripts/pi-common/terminal-recovery-controller.mjs';

function failedSubmit(guard, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return guard.observe({
    stage: 'implementer',
    tool: 'submit_result',
    input: { summary: 'done' },
    result: { content: [{ type: 'text', text }] },
    isError: true,
    productiveState: 'action_required',
  });
}

test('#426 selects journaled cleanup before resubmitting a polluted file set', () => {
  const obligation = submissionObligation(
    'Implementer file-set mismatch: unexpected files: scratch/tmp.py',
  );
  const plan = selectTerminalRecovery({
    obligation,
    terminalInput: { files: ['src/a.py'] },
    activeToolNames: ['submit_result', 'undo_mutation', 'recover_worktree'],
    currentChangedFiles: ['scratch/tmp.py', 'src/a.py'],
    acceptedPaths: ['src/a.py'],
    drift: [{
      path: 'scratch/tmp.py',
      class: 'journaled',
      action: 'undo_mutation',
      mutation_id: 'm17',
    }],
  });

  assert.equal(plan.status, 'repair');
  assert.equal(plan.tool, 'undo_mutation');
  assert.equal(plan.target, 'scratch/tmp.py');
  assert.deepEqual(plan.args.expected_files, ['src/a.py']);
  assert.equal(plan.args.mutation_id, 'm17');
  assert.match(terminalRecoveryGuidance(plan), /Call undo_mutation/);
});

test('#426 accepted file-set delta becomes metadata repair instead of cleanup', () => {
  const obligation = submissionObligation(
    'Implementer file-set mismatch: unexpected files: src/new.py; missing files: src/old.py',
  );
  const plan = selectTerminalRecovery({
    obligation,
    terminalInput: { files: ['src/old.py'] },
    activeToolNames: ['submit_result', 'undo_mutation'],
    currentChangedFiles: ['src/new.py'],
    acceptedPaths: ['src/new.py'],
    drift: [{
      path: 'src/new.py',
      class: 'journaled',
      action: 'undo_mutation',
      mutation_id: 'm-task',
    }],
  });

  assert.equal(plan.status, 'repair');
  assert.equal(plan.kind, 'file_set_metadata_retry');
  assert.equal(plan.tool, 'submit_result');
  assert.deepEqual(plan.files, ['src/new.py']);
  assert.deepEqual(plan.acceptedUnexpected, ['src/new.py']);
  assert.deepEqual(plan.missing, ['src/old.py']);
});

test('#426 structured missing publication fields select immediate submit metadata retry', () => {
  const obligation = submissionObligation(JSON.stringify({
    code: 'missing_publication_fields',
    missing_fields: ['limitations', 'security_notes', 'limitations'],
  }));
  const plan = selectTerminalRecovery({
    obligation,
    terminalInput: { title: 'Fix', summary: 'Summary' },
    activeToolNames: ['submit_result', 'write'],
  });

  assert.equal(plan.status, 'repair');
  assert.equal(plan.tool, 'submit_result');
  assert.deepEqual(plan.missingFields, ['limitations', 'security_notes']);
  assert.match(terminalRecoveryGuidance(plan), /fill exactly these missing publication fields/);
});

test('#426 exact validation obligation selects the authoritative run_check action', () => {
  const obligation = submissionObligation(JSON.stringify({
    code: 'TARGETED_BEHAVIORAL_VALIDATION_REQUIRED',
    required_targets: ['tests/test_widget.py'],
    action: { kind: 'pytest', targets: ['tests/test_widget.py'] },
  }));
  const plan = selectTerminalRecovery({
    obligation,
    activeToolNames: ['run_check', 'submit_result'],
  });

  assert.equal(plan.status, 'repair');
  assert.equal(plan.kind, 'exact_validation');
  assert.equal(plan.tool, 'run_check');
  assert.deepEqual(plan.args, { kind: 'pytest', paths: [], targets: ['tests/test_widget.py'] });
});

test('#426 exact validation pass resets repeated terminal failure state', () => {
  const guard = new SemanticLoopGuard();
  const payload = {
    code: 'TARGETED_BEHAVIORAL_VALIDATION_REQUIRED',
    required_targets: ['tests/test_widget.py'],
    action: { kind: 'pytest', targets: ['tests/test_widget.py'] },
  };

  assert.equal(failedSubmit(guard, payload).tripped, false);
  assert.equal(failedSubmit(guard, payload).tripped, false);
  const third = failedSubmit(guard, payload);
  assert.equal(third.action, 'steer');
  assert.equal(third.obligation.kind, 'validation');

  const exactPass = guard.observe({
    stage: 'implementer',
    tool: 'run_check',
    input: { kind: 'pytest', targets: ['tests/test_widget.py'] },
    result: {
      content: [{ type: 'text', text: JSON.stringify({ status: 'pass', summary: '1 passed' }) }],
      details: { status: 'pass', summary: '1 passed' },
    },
    productiveState: 'action_required',
  });
  assert.equal(exactPass.classification, 'success_obligation_resolved');

  assert.equal(failedSubmit(guard, payload).tripped, false);
  assert.equal(failedSubmit(guard, payload).tripped, false);
  assert.equal(failedSubmit(guard, payload).action, 'steer');
});

test('#426 unavailable trusted cleanup yields a precise blocked plan', () => {
  const obligation = submissionObligation(
    'Implementer file-set mismatch: unexpected files: scratch/tmp.py',
  );
  const plan = selectTerminalRecovery({
    obligation,
    terminalInput: { files: ['src/a.py'] },
    activeToolNames: ['submit_result'],
    currentChangedFiles: ['scratch/tmp.py', 'src/a.py'],
    acceptedPaths: ['src/a.py'],
    drift: [{
      path: 'scratch/tmp.py',
      class: 'journaled',
      action: 'undo_mutation',
      mutation_id: 'm17',
    }],
  });

  assert.equal(plan.status, 'blocked');
  assert.equal(plan.requiredTool, 'undo_mutation');
  assert.match(plan.reason, /not executable/);
  assert.match(terminalRecoveryGuidance(plan), /Preserve the current worktree\/checkpoint/);
});

test('#426 recovery context compacts only obsolete equivalent terminal diagnostics', () => {
  const first = 'Implementer file-set mismatch: unexpected files: scratch/tmp.py';
  const second = first + '. Targeted cleanup available: undo_mutation({mutation_id:"m1"})';
  const obligation = submissionObligation(first);
  const recovery = `RUNTIME TERMINAL RECOVERY [${obligation.key}]: deterministic targeted_cleanup repair selected.`;
  const messages = [
    { role: 'user', content: 'Acceptance: preserve the exact task contract.' },
    { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'submit_result', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: first },
    { role: 'user', content: recovery },
    { role: 'assistant', tool_calls: [{ id: 'check', function: { name: 'run_check', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'check', content: '{"status":"fail","summary":"exact evidence"}' },
    { role: 'assistant', tool_calls: [{ id: 'b', function: { name: 'submit_result', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'b', content: second },
    { role: 'user', content: recovery },
  ];

  const payload = compactTerminalRecoveryPayload(
    { messages, tools: [] },
    { obligationKey: obligation.key },
  );
  assert.equal(payload.messages[0].content, messages[0].content, 'acceptance context is preserved');
  assert.match(payload.messages[2].content, /superseded repeated terminal diagnostic/);
  assert.equal(payload.messages[5].content, messages[5].content, 'exact-check evidence is preserved');
  assert.equal(payload.messages[7].content, second, 'newest terminal diagnostic is preserved');
  assert.match(payload.messages[3].content, /superseded repeated terminal diagnostic/);
  assert.equal(payload.messages[8].content, recovery, 'newest recovery directive is preserved');
});


test('#426 prefixed structured terminal errors preserve the same obligation identity', () => {
  const exact = submissionObligation(JSON.stringify({
    code: 'missing_publication_fields',
    missing_fields: ['limitations', 'security_notes'],
  }));
  const prefixed = submissionObligation('Error: ' + JSON.stringify({
    code: 'missing_publication_fields',
    missing_fields: ['security_notes', 'limitations'],
  }));
  assert.equal(prefixed.kind, 'metadata');
  assert.equal(prefixed.key, exact.key);
  assert.deepEqual(prefixed.missingFields, ['limitations', 'security_notes']);
});

test('#426 compactor recognizes structured tool content instead of the message envelope', () => {
  const error = JSON.stringify({
    code: 'missing_publication_fields',
    missing_fields: ['limitations'],
  });
  const obligation = submissionObligation(error);
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'submit_result', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: error },
    { role: 'assistant', tool_calls: [{ id: 'b', function: { name: 'submit_result', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'b', content: 'Error: ' + error },
  ];
  const payload = compactTerminalRecoveryPayload(
    { messages },
    { obligationKey: obligation.key },
  );
  assert.match(payload.messages[1].content, /superseded repeated terminal diagnostic/);
  assert.equal(payload.messages[3].content, 'Error: ' + error);
});
