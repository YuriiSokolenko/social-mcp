import test from 'node:test';
import assert from 'node:assert/strict';

test('issue summary helper is tracked by CI node test glob', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync('scripts/pi-issue-summary.mjs', 'utf8');
  assert.match(source, /social-mcp\/pi-review/);
  assert.match(source, /MERGE GATE/);
  assert.match(source, /pi\/issue-/);
  assert.match(source, /run\.event === 'workflow_dispatch'/);
  assert.match(source, /run\.head_sha === pr\.head\.sha/);
  assert.doesNotMatch(source, /\['push', 'workflow_dispatch'\]/);
});
