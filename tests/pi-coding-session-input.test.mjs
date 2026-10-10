import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CODING_SESSION_HANDOFF_MAX_LENGTH,
  normalizedCodingSessionHandoff,
  codingSessionArgumentValidation,
  codingSessionArgumentFailure,
} from '../scripts/pi-common/coding-session-input.mjs';

function failure(errors) {
  return { errors, diagnostic: 'Validation failed for tool "begin_coding_session":\n  - ' + errors.join('\n  - ') };
}

test('#741 runtime retains its public validation export and shared 1200-char limit', () => {
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(runtime, /from '\.\/pi-common\/coding-session-input\.mjs'/);
  assert.match(runtime, /export \{ codingSessionArgumentValidation \}/);
  assert.match(runtime, /maxLength: CODING_SESSION_HANDOFF_MAX_LENGTH/);
  assert.equal(CODING_SESSION_HANDOFF_MAX_LENGTH, 1200);
});

test('#741 handoff normalization is omission-safe and Unicode-codepoint bounded', () => {
  for (const value of [undefined, null, '', '  ', '\t\n']) assert.equal(normalizedCodingSessionHandoff(value), '');
  assert.equal(normalizedCodingSessionHandoff('  new fact  '), 'new fact');
  assert.equal(normalizedCodingSessionHandoff(7), '7');
  assert.equal(normalizedCodingSessionHandoff('😀'.repeat(1201)), '😀'.repeat(1200));
  assert.equal(normalizedCodingSessionHandoff('x'.repeat(1199) + '    end'), 'x'.repeat(1199));
  assert.equal(normalizedCodingSessionHandoff('x'.repeat(1200) + 'y'), 'x'.repeat(1200));
});

test('#741 top-level validation preserves exact diagnostics and optional fields', () => {
  for (const input of [undefined, null, 0, false, '', 'text', [], ['reason']])
    assert.deepEqual(codingSessionArgumentValidation(input), failure(['arguments: must be an object']));
  assert.equal(codingSessionArgumentValidation({}), null);
  assert.equal(codingSessionArgumentValidation({ reason: 'ok', handoff: '', required_capability: 'read', other: 5 }), null);
});

test('#741 checks fields in order with codepoint-based max length, without mutation', () => {
  assert.equal(codingSessionArgumentValidation({
    reason: '😀'.repeat(300), handoff: '😀'.repeat(1200), required_capability: '😀'.repeat(100),
  }), null);
  const input = { reason: '😀'.repeat(301), handoff: 'x'.repeat(1201), required_capability: 'y'.repeat(101) };
  const copy = { ...input };
  assert.deepEqual(codingSessionArgumentValidation(input), failure([
    'reason: must not have more than 300 characters',
    'handoff: must not have more than 1200 characters',
    'required_capability: must not have more than 100 characters',
  ]));
  assert.deepEqual(input, copy);
  assert.deepEqual(codingSessionArgumentValidation({ reason: 1, handoff: null, required_capability: false }),
    failure(['reason: must be a string', 'handoff: must be a string', 'required_capability: must be a string']));
  assert.equal(codingSessionArgumentValidation(Object.create({ reason: 5 })), null);
});

test('#741 absent or deferred tools do not trigger a launch-argument diagnostic', () => {
  const bad = { content: [{ type: 'toolCall', name: 'begin_coding_session', arguments: '{' }] };
  assert.equal(codingSessionArgumentFailure(bad, null, ['begin_coding_session']), null);
  assert.equal(codingSessionArgumentFailure(bad, 'begin_coding_session', []), null);
  assert.equal(codingSessionArgumentFailure(bad, 'begin_coding_session', null), null);
  assert.equal(codingSessionArgumentFailure(bad, 'other_tool', ['other_tool']), null);
  assert.equal(codingSessionArgumentFailure({ content: [{ type: 'text', name: 'begin_coding_session' }] }, 'begin_coding_session', ['begin_coding_session']), null);
  assert.equal(codingSessionArgumentFailure({ content: 'not-array' }, 'begin_coding_session', ['begin_coding_session']), null);
});

test('#741 JSON-string argument envelopes preserve parsing, rejection and errors', () => {
  const validate = argumentsValue => codingSessionArgumentFailure({
    content: [{ type: 'toolCall', name: 'begin_coding_session', arguments: argumentsValue }],
  }, 'begin_coding_session', ['begin_coding_session']);
  assert.equal(validate('{"handoff":"ready"}'), null);
  assert.deepEqual(validate('null'), failure(['arguments: must be an object']));
  assert.deepEqual(validate('[]'), failure(['arguments: must be an object']));
  assert.deepEqual(validate('{"handoff":3}'), failure(['handoff: must be a string']));
  assert.deepEqual(validate('{'), failure(['arguments: must be a valid JSON object']));
  assert.deepEqual(validate(''), failure(['arguments: must be a valid JSON object']));
});

test('#741 arguments, input, parameters precedence never masks malformed JSON', () => {
  const call = part => codingSessionArgumentFailure({
    content: [part],
  }, 'begin_coding_session', ['begin_coding_session']);
  const base = { type: 'toolCall', name: 'begin_coding_session' };
  assert.equal(call({ ...base, input: { handoff: 'ok' } }), null);
  assert.equal(call({ ...base, parameters: { reason: 'ok' } }), null);
  assert.deepEqual(call({ ...base, arguments: '{', input: { handoff: 'ok' } }),
    failure(['arguments: must be a valid JSON object']));
  assert.deepEqual(call({ ...base, arguments: null, input: { handoff: 2 }, parameters: {} }),
    failure(['handoff: must be a string']));
  assert.equal(call({ ...base, arguments: undefined, input: undefined, parameters: {} }), null);
  assert.deepEqual(call(base), failure(['arguments: must be an object']));
});
