import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCodingRepairDiagnosticText,
  strictFailureSetReduction,
  mutationTextExtent,
  codingMutationShape,
} from '../scripts/pi-common/coding-repair-policy.mjs';

test('#756 diagnostic normalization preserves semantic values while discarding volatile details', () => {
  assert.equal(normalizeCodingRepairDiagnosticText(null), '');
  assert.equal(normalizeCodingRepairDiagnosticText(undefined), '');
  assert.equal(normalizeCodingRepairDiagnosticText(0), '0');
  assert.equal(normalizeCodingRepairDiagnosticText(false), 'false');
  assert.equal(normalizeCodingRepairDiagnosticText({}), '[object Object]');

  assert.equal(
    normalizeCodingRepairDiagnosticText('  failed\r\n at /tmp/run42/app/test.ts\tin 12.5ms  '),
    'failed at <path> in <number>',
  );
  assert.equal(
    normalizeCodingRepairDiagnosticText('fail 0xDeAdBEEF ABCDEF123456789 expected 42, got 43'),
    'fail <hex> <hex> expected 42, got 43',
  );
  assert.equal(
    normalizeCodingRepairDiagnosticText('error C:\\build\\job\\file.py after -2e+3us'),
    'error <path> after <number>',
  );
  assert.equal(
    normalizeCodingRepairDiagnosticText('  5ms 10bytes 1GB  1.0s  '),
    '<number> <number> <number> <number>',
  );

  const a = normalizeCodingRepairDiagnosticText('  timeout /tmp/first/log.txt after 10ms ');
  const b = normalizeCodingRepairDiagnosticText('timeout /opt/second/log.txt after 35ms');
  assert.equal(a, b, 'equivalent diagnostics produce the same stable signature');
  assert.equal(new Set([a, b]).size, 1, 'the caller can de-duplicate identical normalized diagnostics');
  assert.notEqual(
    normalizeCodingRepairDiagnosticText('expected 42'),
    normalizeCodingRepairDiagnosticText('expected 43'),
    'semantic numeric values remain distinct',
  );
  assert.equal(
    normalizeCodingRepairDiagnosticText('\x1b[31merror\x1b[0m'),
    '\x1b[31merror\x1b[0m',
    'ANSI sequences are deliberately not stripped by the current policy',
  );
});

test('#756 strict failure reduction uses array length plus membership, including duplicates', () => {
  assert.equal(strictFailureSetReduction(['A'], ['A', 'B']), true);
  assert.equal(strictFailureSetReduction([], ['A']), true);
  assert.equal(strictFailureSetReduction([], []), false);
  assert.equal(strictFailureSetReduction(['A'], ['A']), false);
  assert.equal(strictFailureSetReduction(['A', 'B'], ['A']), false);
  assert.equal(strictFailureSetReduction(['A', 'B'], ['B', 'C']), false);
  assert.equal(strictFailureSetReduction(['C'], ['A', 'B']), false);
  assert.equal(strictFailureSetReduction(['A', 'B'], ['A', 'B', 'C']), true);
  assert.equal(strictFailureSetReduction(['A'], undefined), false);
  assert.equal(strictFailureSetReduction(['A'], null), false);
  assert.equal(strictFailureSetReduction(['A'], 'A,B'), false);

  // The historical contract compares array lengths, not distinct set cardinalities.
  assert.equal(strictFailureSetReduction(['A', 'A'], ['A', 'B', 'C']), true);
  assert.equal(strictFailureSetReduction(['A', 'A'], ['A', 'B']), false);
  assert.equal(strictFailureSetReduction(['A'], ['A', 'A']), true);
  assert.throws(() => strictFailureSetReduction(null, ['A']), TypeError);
});

test('#756 mutation text extent measures the largest matching field, not aggregate payload', () => {
  const zero = { chars: 0, lines: 0 };
  assert.deepEqual(mutationTextExtent(null), zero);
  assert.deepEqual(mutationTextExtent(123), zero);
  assert.deepEqual(mutationTextExtent('hello'), zero);
  assert.deepEqual(mutationTextExtent('hello', 'path'), zero);
  assert.deepEqual(mutationTextExtent('hello', 'replacement'), { chars: 5, lines: 1 });
  assert.deepEqual(mutationTextExtent('', 'text'), { chars: 0, lines: 1 });
  assert.deepEqual(mutationTextExtent('a\nb\n', 'old_text'), { chars: 4, lines: 3 });
  assert.deepEqual(mutationTextExtent('😀', 'content'), { chars: 2, lines: 1 }, 'chars are UTF-16 units');

  assert.deepEqual(
    mutationTextExtent({ path: '/tmp/a.py', metadata: { explanation: 'ignored' }, edit: {
      old_text: 'ab\nc', new_text: 'longer', extra: { insert: '1\n2\n3\n4' },
    } }),
    { chars: 6, lines: 4 },
    'the independent maxima may come from different fields',
  );
  assert.deepEqual(
    mutationTextExtent([{ text: 'x'.repeat(100) }, { value: 'x\nx\nx' }]),
    { chars: 100, lines: 3 },
  );
  assert.deepEqual(mutationTextExtent({ details: ['a', 'b'] }), zero);
  assert.deepEqual(mutationTextExtent(['a\nb'], 'text'), { chars: 3, lines: 2 });
});

test('#756 mutation shape preserves creation/rewrite classification and exact broad-edit thresholds', () => {
  assert.equal(codingMutationShape('write', { content: 'x'.repeat(30000) }, { existed: false }), 'creation');
  assert.equal(codingMutationShape('write', {}, null), 'creation');
  assert.equal(codingMutationShape('write', {}, { existed: true }), 'whole_file_rewrite');
  assert.equal(codingMutationShape('bash', { text: 'x'.repeat(50000) }, { existed: true }), 'other');
  assert.equal(codingMutationShape('edit', null, null), 'targeted_edit');
  assert.equal(codingMutationShape('structural_edit', { text: 'x' }, null), 'targeted_edit');
  assert.equal(codingMutationShape('edit', { text: 'x'.repeat(12000) }, null), 'targeted_edit');
  assert.equal(codingMutationShape('edit', { text: 'x'.repeat(12001) }, null), 'broad_edit');
  assert.equal(codingMutationShape('structural_edit', { replacement: 'x\n'.repeat(79) + 'x' }, null), 'targeted_edit');
  assert.equal(codingMutationShape('structural_edit', { replacement: 'x\n'.repeat(80) + 'x' }, null), 'broad_edit');
  assert.equal(codingMutationShape('safe_edit', { start_line: 1, end_line: 80 }, null), 'targeted_edit');
  assert.equal(codingMutationShape('safe_edit', { start_line: 1, end_line: 81 }, null), 'broad_edit');
  assert.equal(codingMutationShape('safe_edit', { start_line: 80, end_line: 1 }, null), 'targeted_edit');
  assert.equal(codingMutationShape('safe_edit', { start_line: 1, end_line: '81' }, null), 'broad_edit');
  assert.equal(codingMutationShape('safe_edit', { text: 'x'.repeat(12001) }, null), 'broad_edit');
  assert.equal(codingMutationShape('edit', { path: 'x'.repeat(12001) }, null), 'targeted_edit', 'paths are not mutation text');
});
