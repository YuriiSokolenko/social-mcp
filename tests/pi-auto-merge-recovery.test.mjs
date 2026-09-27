import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedFiles, linkedIssueNumber } from '../scripts/pi-auto-merge.mjs';

test('a Pi PR identifies its linked issue only on the trusted dev path', () => {
  const repo = 'test/repo';
  const pr = {
    draft: false,
    body: 'Closes #42',
    base: { ref: 'dev', repo: { full_name: repo } },
    head: { ref: 'pi/issue-42', repo: { full_name: repo } },
  };
  assert.equal(linkedIssueNumber(pr, repo), 42);
  assert.equal(linkedIssueNumber({ ...pr, base: { ...pr.base, ref: 'main' } }, repo), null);
  assert.equal(linkedIssueNumber({ ...pr, head: { ...pr.head, ref: 'other' } }, repo), null);
  assert.equal(linkedIssueNumber({ ...pr, body: 'Related to #42' }, repo), null);
});


test('Pi PRs cannot auto-merge changes to control scripts or workflows', () => {
  assert.equal(allowedFiles([{ filename: 'scripts/pi-auto-merge.mjs' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'scripts/pi-issue-status.sh' }], 1), false);
  assert.equal(allowedFiles([{ filename: '.github/workflows/ci.yml' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'src/new.mjs', previous_filename: 'scripts/pi-auto-merge.mjs' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'src/application.py' }], 1), true);
});
