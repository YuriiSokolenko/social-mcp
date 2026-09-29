import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { structuralEdit } from '../scripts/pi-common/structural-edit.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-structural-edit-'));
}

function matchFor({ file, source, startText, replacement, language = 'Python' }) {
  const bytes = Buffer.from(source, 'utf8');
  const start = bytes.indexOf(Buffer.from(startText, 'utf8'));
  assert.notEqual(start, -1);
  const end = start + Buffer.byteLength(startText, 'utf8');
  return {
    text: startText,
    range: {
      byteOffset: { start, end },
      start: { line: 0, column: 0 },
      end: { line: 0, column: 0 },
    },
    file,
    replacement,
    language,
  };
}

test('structural_edit applies exactly one ast-grep dry-run replacement atomically', () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, 'sample.py');
    const source = [
      '# π prefix proves byte offsets are handled as bytes',
      'def _check_active(self) -> None:',
      '    if self._closed:',
      '        raise RuntimeError("closed")',
      '',
    ].join('\n');
    fs.writeFileSync(file, source);
    const target = [
      'def _check_active(self) -> None:',
      '    if self._closed:',
      '        raise RuntimeError("closed")',
    ].join('\n');
    const replacement = [
      'def _check_active(self) -> None:',
      '    """Verify the client is still usable."""',
      '    if self._closed:',
      '        raise RuntimeError("closed")',
    ].join('\n');
    let calls = 0;
    const result = structuralEdit(dir, {
      path: 'sample.py',
      pattern: 'def _check_active(self) -> None:\n    $$$BODY',
      rewrite: 'def _check_active(self) -> None:\n    """Verify the client is still usable."""\n    $$$BODY',
    }, {
      run(command, args, options) {
        calls += 1;
        assert.equal(command, 'ast-grep');
        assert.equal(options.allowFailure, true);
        assert.ok(args.includes('--json=compact'));
        return {
          status: 0,
          out: JSON.stringify([matchFor({ file, source, startText: target, replacement })]),
          err: '',
        };
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.engine, 'ast-grep');
    assert.equal(result.language, 'Python');
    assert.equal(result.before.text, target);
    assert.equal(result.after.text, replacement);
    assert.equal(fs.readFileSync(file, 'utf8'), source.replace(target, replacement));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('structural_edit rejects zero or multiple matches without changing the file', () => {
  for (const matchCount of [0, 2]) {
    const dir = tempRepo();
    try {
      const file = path.join(dir, 'sample.py');
      const source = 'def target():\n    return 1\n';
      fs.writeFileSync(file, source);
      const one = matchFor({
        file,
        source,
        startText: 'def target():\n    return 1',
        replacement: 'def target():\n    return 2',
      });
      assert.throws(
        () => structuralEdit(dir, {
          path: 'sample.py',
          pattern: 'def target():\n    $$$BODY',
          rewrite: 'def target():\n    return 2',
        }, {
          run: () => ({ status: matchCount === 0 ? 1 : 0, out: JSON.stringify(Array(matchCount).fill(one)), err: '' }),
        }),
        new RegExp(`exactly one AST match; found ${matchCount}`),
      );
      assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('structural_edit refuses stale ast-grep byte ranges', () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, 'sample.py');
    const source = 'def target():\n    return 1\n';
    fs.writeFileSync(file, source);
    const stale = matchFor({
      file,
      source,
      startText: 'def target():\n    return 1',
      replacement: 'def target():\n    return 2',
    });
    stale.text = 'def target():\n    return 999';
    assert.throws(
      () => structuralEdit(dir, {
        path: 'sample.py',
        pattern: 'def target():\n    $$$BODY',
        rewrite: 'def target():\n    return 2',
      }, {
        run: () => ({ status: 0, out: JSON.stringify([stale]), err: '' }),
      }),
      /target changed after the ast-grep dry run/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('structural_edit refuses symbolic-link targets and worktree escapes', () => {
  const dir = tempRepo();
  const outside = path.join(path.dirname(dir), 'pi-structural-edit-outside.py');
  try {
    const real = path.join(dir, 'real.py');
    const link = path.join(dir, 'link.py');
    fs.writeFileSync(real, 'x = 1\n');
    fs.writeFileSync(outside, 'x = 1\n');
    fs.symlinkSync(real, link);
    assert.throws(
      () => structuralEdit(dir, { path: 'link.py', pattern: 'x = 1', rewrite: 'x = 2' }),
      /refuses symbolic-link targets/,
    );
    assert.throws(
      () => structuralEdit(dir, { path: '../pi-structural-edit-outside.py', pattern: 'x = 1', rewrite: 'x = 2' }),
      /escapes the current worktree/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});
