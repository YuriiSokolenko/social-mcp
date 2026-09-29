import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { safeEdit } from '../scripts/pi-common/safe-edit.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-safe-edit-'));
}

test('safe_edit inserts a multiline docstring after a signature without oldText', () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, 'sample.py');
    fs.writeFileSync(file, [
      'class Client:',
      '    def _effective_transport(self):',
      '        if self._transport is not None:',
      '            return self._transport',
      '',
    ].join('\n'));

    const result = safeEdit(dir, {
      path: 'sample.py',
      operation: 'insert_after',
      start_line: 2,
      expected_marker: '_effective_transport',
      text: '        """Return the injected transport or lazily create the platform transport."""',
    });

    assert.equal(result.changed_start_line, 3);
    assert.equal(result.changed_end_line, 3);
    assert.equal(result.line_delta, 1);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      [
        'class Client:',
        '    def _effective_transport(self):',
        '        """Return the injected transport or lazily create the platform transport."""',
        '        if self._transport is not None:',
        '            return self._transport',
        '',
      ].join('\n'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safe_edit preserves CRLF and final-newline state while replacing a range', () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, 'sample.txt');
    fs.writeFileSync(file, 'alpha\r\nbeta\r\ngamma\r\n');

    const result = safeEdit(dir, {
      path: 'sample.txt',
      operation: 'replace',
      start_line: 2,
      end_line: 2,
      expected_marker: 'beta',
      text: '    one\n    two',
    });

    assert.deepEqual(
      [result.changed_start_line, result.changed_end_line, result.line_delta],
      [2, 3, 1],
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'alpha\r\n    one\r\n    two\r\ngamma\r\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safe_edit rejects stale markers and invalid ranges without changing the file', () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, 'sample.py');
    const original = 'one\ntwo\nthree';
    fs.writeFileSync(file, original);

    assert.throws(
      () => safeEdit(dir, {
        path: 'sample.py',
        operation: 'insert_after',
        start_line: 2,
        expected_marker: 'missing marker',
        text: 'inserted',
      }),
      /expected_marker was not found/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), original);

    assert.throws(
      () => safeEdit(dir, {
        path: 'sample.py',
        operation: 'replace',
        start_line: 4,
        end_line: 4,
        text: 'replacement',
      }),
      /outside the current file/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safe_edit refuses symbolic-link targets', () => {
  const dir = tempRepo();
  try {
    const real = path.join(dir, 'real.txt');
    const link = path.join(dir, 'link.txt');
    fs.writeFileSync(real, 'real\n');
    fs.symlinkSync(real, link);
    assert.throws(
      () => safeEdit(dir, {
        path: 'link.txt',
        operation: 'replace',
        start_line: 1,
        text: 'changed',
      }),
      /refuses symbolic-link targets/,
    );
    assert.equal(fs.readFileSync(real, 'utf8'), 'real\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safe_edit cannot escape the current worktree', () => {
  const dir = tempRepo();
  const outside = path.join(path.dirname(dir), 'pi-safe-edit-outside.txt');
  try {
    fs.writeFileSync(path.join(dir, 'inside.txt'), 'inside\n');
    fs.writeFileSync(outside, 'outside\n');
    assert.throws(
      () => safeEdit(dir, {
        path: '../pi-safe-edit-outside.txt',
        operation: 'replace',
        start_line: 1,
        text: 'changed',
      }),
      /escapes the current worktree/,
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});
