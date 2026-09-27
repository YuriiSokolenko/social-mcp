import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('issue summary reports the simple merge then dev-CI pipeline', () => {
  const source = fs.readFileSync('scripts/pi-issue-summary.mjs', 'utf8');
  assert.match(source, /READY TO MERGE/);
  assert.match(source, /MERGED \/ DEV CI/);
  assert.match(source, /runs on merged dev push/);
  assert.doesNotMatch(source, /social-mcp\/pi-review|social-mcp\/integration|SHA-bound|exact dev\+PR/);
});
