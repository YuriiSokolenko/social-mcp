import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { plannerOrbitSeedTargets } from '../scripts/pi-common/planner-orbit.mjs';

test('Planner Orbit seed rejects symlink targets whose real path escapes the worktree', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-symlink-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-symlink-outside-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/inside.py'), 'pass\n');
  fs.writeFileSync(path.join(outside, 'outside.py'), 'pass\n');

  try {
    fs.symlinkSync(path.join(dir, 'src/inside.py'), path.join(dir, 'src/inside-link.py'));
    fs.symlinkSync(path.join(outside, 'outside.py'), path.join(dir, 'src/outside-link.py'));
  } catch (error) {
    t.skip(`symlinks unavailable in test environment: ${String(error?.code ?? error)}`);
    return;
  }

  const targets = plannerOrbitSeedTargets({
    title: 'Inspect `src/inside-link.py` and `src/outside-link.py`',
    body: '',
  }, { cwd: dir });

  assert.deepEqual(targets, ['src/inside-link.py']);
});
