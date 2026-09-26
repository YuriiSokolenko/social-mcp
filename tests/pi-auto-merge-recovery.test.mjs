import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { allowedFiles, linkedIssueNumber } from '../scripts/pi-auto-merge.mjs';

test('a merged Pi PR into dev still identifies its linked issue', () => {
  const repo = 'test/repo';
  const pr = {
    state: 'closed', merged_at: '2026-09-24T19:00:00Z', draft: false,
    body: 'Closes #42',
    base: { ref: 'dev', repo: { full_name: repo } },
    head: { ref: 'pi/issue-42', repo: { full_name: repo } },
  };
  assert.equal(linkedIssueNumber(pr, repo), 42);
  assert.equal(linkedIssueNumber({ ...pr, base: { ...pr.base, ref: 'main' } }, repo), null);
  assert.equal(linkedIssueNumber({ ...pr, head: { ...pr.head, ref: 'other' } }, repo), null);
});

test('recovers a merged dev PR by closing its issue before dispatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-merge-'));
  const mockFile = join(dir, 'mock.mjs');
  const callsFile = join(dir, 'calls.jsonl');
  writeFileSync(mockFile, `
    import { appendFileSync } from 'node:fs';
    const repo = 'test/repo';
    const pr = {
      number: 42, state: 'closed', merged_at: '2026-09-24T19:00:00Z',
      draft: false, body: 'Closes #42',
      labels: [{ name: 'review:passed' }],
      base: { ref: 'dev', repo: { full_name: repo } },
      head: { ref: 'pi/issue-42', repo: { full_name: repo } },
    };
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      const path = url.pathname.replace('/repos/test/repo', '');
      const method = options.method || 'GET';
      appendFileSync(process.env.MOCK_CALLS_FILE, JSON.stringify({ path, method }) + '\\n');
      if (path === '/pulls' && url.searchParams.get('state') === 'closed') {
        return Response.json([pr]);
      }
      if (path === '/pulls' && url.searchParams.get('state') === 'open') {
        return Response.json([]);
      }
      if (path === '/issues/42' && method === 'GET') {
        return Response.json({ state: 'open', labels: [{ name: 'pi:mr-created' }] });
      }
      if (path === '/issues/42' && method === 'PATCH') {
        return Response.json({ state: 'closed', state_reason: 'completed' });
      }
      if (path === '/actions/workflows/pi-dispatcher.yml/dispatches' && method === 'POST') {
        return new Response(null, { status: 204 });
      }
      if (path === '/issues/42/labels/pi%3Amr-created' && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error('Unexpected request: ' + method + ' ' + path);
    };
  `);
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(mockFile).href, 'scripts/pi-auto-merge.mjs',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env, GITHUB_REPOSITORY: 'test/repo',
      GITHUB_TOKEN: 'synthetic-token', MOCK_CALLS_FILE: callsFile,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const actions = calls.filter(call => call.method !== 'GET');
  assert.deepEqual(actions, [
    { path: '/issues/42', method: 'PATCH' },
    { path: '/actions/workflows/pi-dispatcher.yml/dispatches', method: 'POST' },
    { path: '/issues/42/labels/pi%3Amr-created', method: 'DELETE' },
  ]);
});

function conflictMockSource() {
  return `
    import { appendFileSync } from 'node:fs';
    const repo = 'test/repo';
    const hasMarker = process.env.MOCK_HAS_MARKER === 'true';
    const pr = {
      number: 77, state: 'open', draft: false, body: 'Closes #77',
      changed_files: 1, mergeable: false, mergeable_state: 'dirty', labels: [],
      base: { ref: 'dev', repo: { full_name: repo } },
      head: { ref: 'pi/issue-77', sha: 'abc123', repo: { full_name: repo } },
    };
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      const path = url.pathname.replace('/repos/test/repo', '');
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : undefined;
      appendFileSync(process.env.MOCK_CALLS_FILE, JSON.stringify({ path, method, body }) + '\\n');
      if (path === '/pulls' && url.searchParams.get('state') === 'closed') return Response.json([]);
      if (path === '/pulls' && url.searchParams.get('state') === 'open') return Response.json([{ number: 77 }]);
      if (path === '/pulls/77' && method === 'GET') return Response.json(pr);
      if (path === '/issues/77' && method === 'GET') return Response.json({ state: 'open', labels: [{ name: 'pi:mr-created' }] });
      if (path === '/pulls/77/files' && method === 'GET') return Response.json([{ filename: 'app/x.py' }]);
      if (path === '/git/ref/heads/dev') return Response.json({ object: { sha: 'devsha' } });
      if (path === '/compare/dev...abc123') return Response.json({ behind_by: 1, status: 'behind' });
      if (path === '/commits/abc123/statuses') {
        return Response.json(hasMarker ? [{ context: 'social-mcp/merge-conflict-fix-dispatched', state: 'success' }] : []);
      }
      if (path === '/actions/workflows/ci.yml/runs') return Response.json({ workflow_runs: [] });
      if (path === '/actions/workflows/pi-pr-fix.yml/dispatches' && method === 'POST') return new Response(null, { status: 204 });
      if (path === '/statuses/abc123' && method === 'POST') return Response.json({ state: 'success' }, { status: 201 });
      throw new Error('Unexpected request: ' + method + ' ' + path);
    };
  `;
}

function runConflictMock(hasMarker) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-conflict-'));
  const mockFile = join(dir, 'mock.mjs');
  const callsFile = join(dir, 'calls.jsonl');
  writeFileSync(mockFile, conflictMockSource());
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(mockFile).href, 'scripts/pi-auto-merge.mjs',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env, GITHUB_REPOSITORY: 'test/repo',
      GITHUB_TOKEN: 'synthetic-token', MOCK_CALLS_FILE: callsFile,
      MOCK_HAS_MARKER: hasMarker ? 'true' : 'false',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
}

test('a real merge conflict is dispatched to Pi PR Fix instead of silently waiting for a person', () => {
  const calls = runConflictMock(false);
  const dispatch = calls.find(call => call.path === '/actions/workflows/pi-pr-fix.yml/dispatches' && call.method === 'POST');
  assert.deepEqual(dispatch.body, { ref: 'dev', inputs: { pr_number: '77', pr_title: undefined, reason: 'conflict' } });
  const marker = calls.find(call => call.path === '/statuses/abc123' && call.method === 'POST');
  assert.equal(marker.body.context, 'social-mcp/merge-conflict-fix-dispatched');
  assert.equal(calls.some(call => call.path === '/pulls/77/update-branch'), false);
});

test('a conflict repair already dispatched for this SHA is not dispatched again', () => {
  const calls = runConflictMock(true);
  assert.equal(calls.some(call => call.path === '/actions/workflows/pi-pr-fix.yml/dispatches'), false);
});

test('Pi PRs cannot auto-merge changes to control scripts', () => {
  assert.equal(allowedFiles([{ filename: 'scripts/pi-auto-merge.mjs' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'scripts/pi-issue-status.sh' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'src/new.mjs', previous_filename: 'scripts/pi-auto-merge.mjs' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'src/application.py' }], 1), true);
});
