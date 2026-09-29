import assert from 'node:assert/strict';
import test from 'node:test';

import { linkedIssueNumber } from '../scripts/pi-post-merge.mjs';
import { githubClient } from '../scripts/pi-common/github-api.mjs';

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


test('deleteRef ignores GitHub 422 when the reference is already missing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ message: 'Reference does not exist' }),
    { status: 422, headers: { 'content-type': 'application/json' } },
  );
  try {
    const { deleteRef } = githubClient({ repo, token: 'test-token' });
    await assert.doesNotReject(deleteRef('heads/pi/issue-94-checkpoint'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deleteRef still rejects unrelated GitHub 422 responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ message: 'Validation failed' }),
    { status: 422, headers: { 'content-type': 'application/json' } },
  );
  try {
    const { deleteRef } = githubClient({ repo, token: 'test-token' });
    await assert.rejects(deleteRef('heads/pi/issue-94-checkpoint'), /Validation failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
