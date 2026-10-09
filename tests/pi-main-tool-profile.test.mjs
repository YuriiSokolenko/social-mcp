import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterFreshMainToolProfile, isFreshMainToolProfilePhase, isMainCoreTool,
  mainCapabilityGrant, mainToolProfileResultTelemetry, optionalMainToolGroup,
  MAIN_CAPABILITY_REQUEST_TOOL, MAX_MAIN_CAPABILITY_ESCALATIONS,
} from '../scripts/pi-common/main-tool-profile.mjs';
import { classifyMissingExecutor, providerToolNames, withProviderCapabilityInstructions } from '../scripts/pi-common/session-state.mjs';

const tool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } });
const essential = ['read', 'repo_search', 'indexed_repo_search', 'bash', 'safe_edit', 'write',
  'accept_mutation_scope', 'begin_result_submission', 'run_check',
  'retry_last_failed_check', 'recover_worktree', 'undo_mutation', 'submit_result',
  MAIN_CAPABILITY_REQUEST_TOOL];
const optional = ['mcp__context7__query_docs', 'mcp__searxng__search',
  'lsp_start_server', 'lsp_find_symbol', 'git_history',
  'subagents_enable', 'subagent', 'unknown_extension'];

test('#684 fresh Main reduces wire schema while retaining new-file, edit, check, and recovery routes', () => {
  const original = { tools: [...essential, ...optional].map(tool) };
  const filtered = filterFreshMainToolProfile(original, { freshMain: true });
  assert.equal(filtered.profile, 'fresh_core');
  assert.deepEqual(providerToolNames(filtered.payload), essential);
  assert.deepEqual(filtered.deferred, optional);
  assert.equal(original.tools.length, essential.length + optional.length);
  assert.ok(Buffer.byteLength(JSON.stringify(filtered.payload.tools)) <
    Buffer.byteLength(JSON.stringify(original.tools)));
  for (const name of ['write', 'read', 'safe_edit', 'accept_mutation_scope',
    'run_check', 'retry_last_failed_check', 'recover_worktree', 'submit_result']) {
    assert.ok(filtered.admitted.includes(name), name);
  }
});

test('#684 escalation adds only explicitly granted groups in a following request', () => {
  const original = { tools: [...essential, ...optional].map(tool) };
  const before = filterFreshMainToolProfile(original, { freshMain: true });
  const grant = mainCapabilityGrant([], 'docs');
  assert.deepEqual(grant, { ok: true, changed: true, granted: ['docs'] });
  assert.deepEqual(providerToolNames(before.payload), essential,
    'grant cannot mutate the previous serialized request');
  const next = filterFreshMainToolProfile(original, { freshMain: true, grantedGroups: grant.granted });
  assert.equal(next.profile, 'fresh_expanded');
  assert.ok(next.admitted.includes('mcp__context7__query_docs'));
  assert.ok(next.admitted.includes('mcp__searxng__search'));
  assert.ok(!next.admitted.includes('lsp_find_symbol'));
  assert.ok(!next.admitted.includes('subagent'));
  assert.ok(!next.admitted.includes('git_history'));
  assert.deepEqual(providerToolNames(before.payload), essential);
  const lsp = filterFreshMainToolProfile(original, { freshMain: true, grantedGroups: ['lsp'] });
  assert.ok(lsp.admitted.includes('lsp_start_server'));
  assert.ok(lsp.admitted.includes('lsp_find_symbol'));
  assert.ok(!lsp.admitted.includes('mcp__context7__query_docs'));
});

test('#684 grants are bounded and unknown requested groups are rejected', () => {
  assert.equal(mainCapabilityGrant([], 'not-a-group').reason, 'unknown_group');
  assert.equal(mainCapabilityGrant(['docs', 'lsp', 'history'], 'delegation').reason, 'escalation_limit');
  assert.deepEqual(mainCapabilityGrant(['docs'], 'docs'),
    { ok: true, changed: false, granted: ['docs'] });
  assert.equal(MAX_MAIN_CAPABILITY_ESCALATIONS, 3);
  const all = filterFreshMainToolProfile({ tools: optional.map(tool) }, {
    freshMain: true, grantedGroups: ['extended'],
  });
  assert.equal(all.admitted.length, optional.length);
  assert.equal(optionalMainToolGroup('lsp_find_symbol'), 'lsp');
  assert.equal(optionalMainToolGroup('git_history'), 'history');
  assert.equal(optionalMainToolGroup('subagents_enable'), 'delegation');
  assert.equal(optionalMainToolGroup('unknown_extension'), 'extended');
  assert.equal(isMainCoreTool('safe_edit'), true);
  assert.equal(isMainCoreTool('mcp__searxng__search'), false);
  for (const name of ['submit_unsafe', 'recover_everything', 'undo_everything', 'terminal_disable']) {
    assert.equal(isMainCoreTool(name), false, name);
  }
  const forbidden = filterFreshMainToolProfile({ tools: ['grep', 'find', 'ls', 'read'].map(tool) }, {
    freshMain: true, grantedGroups: ['extended'],
  });
  assert.deepEqual(forbidden.admitted, ['read']);
  assert.deepEqual(forbidden.deferred, ['grep', 'find', 'ls']);
});

test('#684 action-required remains an intersection of the existing phase and profile', () => {
  const wire = { tools: ['safe_edit', 'accept_mutation_scope', MAIN_CAPABILITY_REQUEST_TOOL,
    'begin_result_submission', 'submit_result'].map(tool) };
  const filtered = filterFreshMainToolProfile(wire, { freshMain: true, grantedGroups: ['docs', 'lsp'] });
  assert.equal(filtered.payload, wire);
  assert.deepEqual(providerToolNames(filtered.payload), providerToolNames(wire));
  assert.ok(!providerToolNames(filtered.payload).includes('read'));
});

test('#684 restored, validation-repair, coding, and exact terminal routes are phase-owned', () => {
  for (const state of [
    { resumed: true }, { validationRepair: true }, { codingSession: true },
    { terminalRecoveryRequiredTool: 'safe_edit' }, { preComplexityActionRequired: true },
    { stage: 'repair' },
  ]) {
    const wire = { tools: [tool('submit_result'), tool('lsp_find_symbol')] };
    const freshMain = isFreshMainToolProfilePhase(state);
    assert.equal(freshMain, false, JSON.stringify(state));
    const result = filterFreshMainToolProfile(wire, { freshMain });
    assert.equal(result.payload, wire, JSON.stringify(state));
    assert.equal(result.profile, 'phase_owned');
  }
  assert.equal(isFreshMainToolProfilePhase(), true);
  const empty = { tools: [] };
  assert.equal(filterFreshMainToolProfile(empty, { freshMain: true }).payload, empty);
  assert.equal(filterFreshMainToolProfile({}, { freshMain: true }).profile, 'phase_owned');
});

test('#684 missing tools stay missing, no capability is synthesized', () => {
  const wire = { tools: [tool('read'), tool('lsp_find_symbol')] };
  const result = filterFreshMainToolProfile(wire, {
    freshMain: true, grantedGroups: ['history'],
  });
  assert.deepEqual(result.admitted, ['read']);
  assert.deepEqual(result.deferred, ['lsp_find_symbol']);
  assert.equal(result.payload.tools[0], wire.tools[0]);
});

test('#684 request-local guidance derives names from final filtered schema only', () => {
  const raw = { messages: [{ role: 'user', content: 'Task' }],
    tools: [...essential, ...optional].map(tool) };
  const filtered = filterFreshMainToolProfile(raw, { freshMain: true });
  const rendered = withProviderCapabilityInstructions(filtered.payload, {
    mode: 'main', preparationState: 'PREPARED', productiveState: 'action_required',
    executableTools: providerToolNames(raw),
  }, { trustedRuntimeEnvelope: true });
  const advertised = rendered.tools.at(-1).function.description;
  assert.match(advertised, /CURRENTLY EXPOSED TOOLS/);
  assert.doesNotMatch(advertised, /lsp_find_symbol|git_history|mcp__searxng/);
  assert.ok(advertised.includes('safe_edit'));
  assert.equal(providerToolNames(rendered).length, essential.length);
});

test('#684 profile-hidden and late-active tools have distinct missing-executor diagnostics', () => {
  const snapshot = {
    request: 8, executableTools: ['read', MAIN_CAPABILITY_REQUEST_TOOL],
    profileHiddenTools: ['lsp_start_server', 'subagents_enable'],
    deferredTools: ['write'],
  };
  assert.equal(classifyMissingExecutor('lsp_start_server', snapshot), 'profile_hidden');
  assert.equal(classifyMissingExecutor('subagents_enable', snapshot), 'profile_hidden');
  assert.equal(classifyMissingExecutor('write', snapshot), 'deferred');
  assert.equal(classifyMissingExecutor('nonsense', snapshot), 'unavailable');
  assert.equal(classifyMissingExecutor('read', snapshot), 'contract_failure');
  assert.equal(classifyMissingExecutor('read', null), 'contract_failure');
});

test('#684 final provider usage telemetry uses known cache fields only', () => {
  const profile = { profile: 'fresh_core', phase: 'evidence_allowed', toolSchemaBytesAfter: 11234 };
  const unknown = mainToolProfileResultTelemetry(profile, { input: 4321, cacheRead: 0, cacheWrite: 0 }, 9);
  assert.deepEqual(unknown, {
    request: 9, profile: 'fresh_core', phase: 'evidence_allowed',
    toolSchemaBytes: 11234, inputTokens: 4321,
    cacheReadTokens: null, cacheReadTelemetry: 'unknown', cacheWriteTokens: 0,
  });
  const known = mainToolProfileResultTelemetry(profile, {
    input: 4400, cacheReadKnown: true, cacheRead: 0, cacheWrite: 100,
  }, 10);
  assert.equal(known.cacheReadTokens, 0);
  assert.equal(known.cacheReadTelemetry, 'known');
  const absent = mainToolProfileResultTelemetry(profile, null, 11);
  assert.equal(absent.inputTokens, null);
  assert.equal(absent.cacheReadTokens, null);
  assert.equal(absent.cacheWriteTokens, null);
});
