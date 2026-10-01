import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readScript } from './helpers/resolved-source.mjs';

test('issue summary reports the simple merge then dev-CI pipeline', () => {
  const source = readScript('scripts/pi-issue-summary.mjs', 'utf8');
  assert.match(source, /READY TO MERGE/);
  assert.match(source, /MERGED \/ DEV CI/);
  assert.match(source, /BLOCKED/);
  assert.match(source, /NEEDS HUMAN/);
  assert.match(source, /runs on merged dev push/);
  assert.doesNotMatch(source, /social-mcp\/pi-review|social-mcp\/integration|SHA-bound|exact dev\+PR/);
});
