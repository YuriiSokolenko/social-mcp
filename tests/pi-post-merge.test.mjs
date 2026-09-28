import assert from 'node:assert/strict';
import test from 'node:test';

import { linkedIssueNumber } from '../scripts/pi-post-merge.mjs';

const repo = 'owner/repo';
const pr = {
  body: 'Implements the change.\n\nCloses #94',
  base: { ref: 'dev', repo: { full_name: repo } },
  head: { ref: 'pi/issue-94', repo: { full_name: repo } },
};

test('linkedIssueNumber accepts a matching merged-work branch and closing keyword', () => {
  assert.equal(linkedIssueNumber(pr, repo), 94);
});

test('linkedIssueNumber rejects a PR without an explicit closing contract', () => {
  assert.equal(linkedIssueNumber({ ...pr, body: 'Implements #94' }, repo), null);
});

test('linkedIssueNumber rejects a non-dev target', () => {
  assert.equal(linkedIssueNumber({ ...pr, base: { ...pr.base, ref: 'main' } }, repo), null);
});
