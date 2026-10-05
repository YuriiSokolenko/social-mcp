import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  SemanticLoopGuard,
  mutationResolvesSubmissionObligation,
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


test('#426 aggregate changed-file lists cannot masquerade as a mutation target', () => {
  const obligation = submissionObligation(
    'Implementer file-set mismatch: unexpected files: scratch/tmp.py',
  );
  assert.equal(
    mutationResolvesSubmissionObligation(
      obligation,
      { reason: 'unrelated coding work' },
      { details: { changed_files: ['src/real.py', 'scratch/tmp.py'] } },
    ),
    false,
    'changed_files describes aggregate repository state, not the file touched by this mutation',
  );
  assert.equal(
    mutationResolvesSubmissionObligation(
      obligation,
      { reason: 'targeted recovery' },
      { details: { path: 'scratch/tmp.py', changed_files: ['src/real.py', 'scratch/tmp.py'] } },
    ),
    true,
    'a singular authoritative result.path can resolve the named obligation',
  );
});


test('#426 workflow preserves terminal recovery blocked provenance for needs-human routing', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.equal(
    (workflow.match(/PI_TERMINAL_RECOVERY_BLOCKED/g) ?? []).length,
    6,
    'both no-change and changed-work failure paths validate, classify and report terminal recovery blocked',
  );
  assert.equal(
    (workflow.match(/FAILURE_REASON="Terminal recovery exhausted or could not select a capability-valid deterministic repair;/g) ?? []).length,
    2,
    'both workflow failure paths map the blocked code to fixed trusted guidance',
  );
  assert.doesNotMatch(workflow, /FAILURE_REASON="\$\(jq/);
  assert.match(workflow, /pi-transition\.mjs" issue needs-human/);
});


test('#426 cleanup expected_files never re-authorizes the accidental path being removed', () => {
  const obligation = submissionObligation(
    'Runtime scratch artifacts cannot be submitted: scratch/tmp.py. Remove them before submit_result.',
  );
  const plan = selectTerminalRecovery({
    obligation,
    terminalInput: { files: ['src/a.py', 'scratch/tmp.py'] },
    activeToolNames: ['undo_mutation', 'submit_result'],
    currentChangedFiles: ['src/a.py', 'scratch/tmp.py'],
    acceptedPaths: ['src/a.py'],
    drift: [{
      path: 'scratch/tmp.py',
      class: 'journaled',
      action: 'undo_mutation',
      mutation_id: 'm-scratch',
    }],
  });

  assert.equal(plan.status, 'repair');
  assert.equal(plan.tool, 'undo_mutation');
  assert.deepEqual(plan.args.expected_files, ['src/a.py']);
  assert.ok(!plan.args.expected_files.includes('scratch/tmp.py'));
});

test('#426 conflict recovery inspects first and refuses blind mutation-only capability', () => {
  const obligation = submissionObligation(
    'Latest dev conflicts with the implementation. Resolve these files and retry submit_result: src/conflict.py',
  );

  const transition = selectTerminalRecovery({
    obligation,
    activeToolNames: ['need_more_evidence', 'safe_edit', 'submit_result'],
  });
  assert.equal(transition.status, 'repair');
  assert.equal(transition.tool, 'need_more_evidence');
  assert.equal(transition.target, 'src/conflict.py');

  const blocked = selectTerminalRecovery({
    obligation,
    activeToolNames: ['safe_edit', 'submit_result'],
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.requiredTool, 'read');
  assert.match(blocked.reason, /refusing a blind mutation/);
});


test('#426 multi-path cleanup validates one deterministic repair step at a time', () => {
  const obligation = submissionObligation(
    'Implementer file-set mismatch: unexpected files: scratch/a.py, scratch/b.py',
  );
  const plan = selectTerminalRecovery({
    obligation,
    terminalInput: { files: ['src/real.py'] },
    activeToolNames: ['undo_mutation', 'submit_result'],
    currentChangedFiles: ['scratch/a.py', 'scratch/b.py', 'src/real.py'],
    acceptedPaths: ['src/real.py'],
    drift: [
      { path: 'scratch/a.py', class: 'journaled', action: 'undo_mutation', mutation_id: 'm-a' },
      { path: 'scratch/b.py', class: 'journaled', action: 'undo_mutation', mutation_id: 'm-b' },
    ],
  });

  assert.equal(plan.target, 'scratch/a.py');
  assert.equal(plan.args.mutation_id, 'm-a');
  assert.deepEqual(
    plan.args.expected_files,
    ['scratch/b.py', 'src/real.py'],
    'first undo predicts exactly the one-step post-repair worktree; the next obligation remains visible',
  );
});


test('#426 file-set recovery fails closed when canonical repository facts are unavailable', () => {
  const obligation = submissionObligation(
    'Implementer file-set mismatch: missing files: src/a.py',
  );
  const plan = selectTerminalRecovery({
    obligation,
    activeToolNames: ['submit_result', 'undo_mutation'],
    currentChangedFiles: [],
    acceptedPaths: [],
    drift: [],
    repositoryFactsAvailable: false,
  });

  assert.equal(plan.status, 'blocked');
  assert.match(plan.reason, /repository\/worktree facts are unavailable/);
  assert.equal(plan.obligationKey, obligation.key);
});


test('#426 mutation path matching is exact across relative and absolute repository paths', () => {
  const relativeObligation = submissionObligation(
    'Implementer file-set mismatch: unexpected files: src/a.py',
  );
  assert.equal(
    mutationResolvesSubmissionObligation(
      relativeObligation,
      { path: 'a.py' },
      { details: { path: 'a.py' } },
      '/checkout',
    ),
    false,
    'basename-only relative targets cannot resolve a nested repository-relative obligation',
  );
  assert.equal(
    mutationResolvesSubmissionObligation(
      relativeObligation,
      { path: '/checkout/src/a.py' },
      { details: { path: '/checkout/src/a.py' } },
      '/checkout',
    ),
    true,
    'an absolute runtime target normalizes to the exact repository-relative obligation',
  );

  const absoluteObligation = submissionObligation(
    'Implementer file-set mismatch: unexpected files: /checkout/src/a.py',
  );
  assert.equal(
    mutationResolvesSubmissionObligation(
      absoluteObligation,
      { path: 'src/a.py' },
      { details: { path: 'src/a.py' } },
      '/checkout',
    ),
    true,
    'a repository-relative mutation target resolves the same absolute obligation under the known root',
  );
});


test('#426 submit_repair latest-dev conflict is a first-class conflict obligation', () => {
  const implementer = submissionObligation(
    'Latest dev conflicts with the implementation. Resolve these files and retry submit_result: src/a.py, src/b.py',
  );
  const repair = submissionObligation(
    'PR conflicts with current dev. Resolve these files and retry submit_repair: src/b.py, src/a.py',
  );

  assert.equal(repair.kind, 'conflict');
  assert.equal(repair.code, 'latest_dev_conflict');
  assert.deepEqual(repair.conflictPaths, ['src/a.py', 'src/b.py']);
  assert.equal(
    repair.key,
    implementer.key,
    'equivalent latest-dev conflict obligations keep one stable identity across terminal tools',
  );
});


test('#426 wrapped conflict diagnostics preserve clean paths and stable obligation identity', () => {
  const message = 'PR conflicts with current dev. Resolve these files and retry submit_repair: src/a.py, src/b.py\nextra diagnostic';
  const expected = submissionObligation(
    'PR conflicts with current dev. Resolve these files and retry submit_repair: src/a.py, src/b.py',
  );
  const wrapped = [
    JSON.stringify({ message }),
    'Error: ' + JSON.stringify({ error: message }),
    JSON.stringify(message),
    'Error: ' + JSON.stringify(message),
  ];

  for (const text of wrapped) {
    const obligation = submissionObligation(text);
    assert.equal(obligation.kind, 'conflict');
    assert.deepEqual(obligation.conflictPaths, ['src/a.py', 'src/b.py']);
    assert.equal(obligation.key, expected.key);
  }
});

test('#426 malformed validation action cannot be discharged by an unrelated passing run_check', () => {
  const guard = new SemanticLoopGuard();
  const payload = {
    code: 'TARGETED_BEHAVIORAL_VALIDATION_REQUIRED',
    required_targets: ['tests/test_required.py'],
    action: {},
  };

  const failed = failedSubmit(guard, payload);
  assert.equal(failed.classification, 'error');
  assert.equal(guard.terminalObligation.kind, 'validation');

  const unrelatedPass = guard.observe({
    stage: 'implementer',
    tool: 'run_check',
    input: { kind: 'pytest', targets: ['tests/test_unrelated.py'] },
    result: {
      content: [{ type: 'text', text: JSON.stringify({ status: 'pass', summary: '1 passed' }) }],
      details: { status: 'pass', summary: '1 passed' },
    },
    productiveState: 'action_required',
  });

  assert.notEqual(unrelatedPass.classification, 'success_obligation_resolved');
  assert.equal(guard.terminalObligation.kind, 'validation');
  assert.deepEqual(guard.terminalObligation.requiredTargets, ['tests/test_required.py']);
});


test('#426 metadata retries fail closed when the prior terminal payload is unavailable', () => {
  const metadata = submissionObligation(JSON.stringify({
    code: 'missing_publication_fields',
    missing_fields: ['limitations'],
  }));
  const metadataPlan = selectTerminalRecovery({
    obligation: metadata,
    terminalInput: null,
    activeToolNames: ['submit_result'],
  });
  assert.equal(metadataPlan.status, 'blocked');
  assert.match(metadataPlan.reason, /previous terminal submission payload is unavailable/);

  const fileSet = submissionObligation(
    'Implementer file-set mismatch: missing files: src/old.py; unexpected files: src/new.py',
  );
  const fileSetPlan = selectTerminalRecovery({
    obligation: fileSet,
    terminalInput: null,
    activeToolNames: ['submit_result'],
    currentChangedFiles: ['src/new.py'],
    acceptedPaths: ['src/new.py'],
    drift: [{ path: 'src/new.py', class: 'journaled', action: 'undo_mutation', mutation_id: 'm-task' }],
  });
  assert.equal(fileSetPlan.status, 'blocked');
  assert.match(fileSetPlan.reason, /previous terminal submission payload is unavailable/);
});
