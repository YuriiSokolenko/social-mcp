import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// End-to-end coverage for pi-triage.mjs's network-bound prepare/apply flow
// (candidates()/main()), which the pure-logic unit tests in
// pi-triage.test.mjs deliberately do not exercise.

function writeMock(mockFile, storeFile) {
  writeFileSync(mockFile, `
    import { readFileSync, writeFileSync } from 'node:fs';
    const storeFile = ${JSON.stringify(storeFile)};
    function load() { return JSON.parse(readFileSync(storeFile, 'utf8')); }
    function save(store) { writeFileSync(storeFile, JSON.stringify(store)); }

    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const { pathname } = new URL(url);
      const store = load();

      if (method === 'POST' && pathname.endsWith('/labels')) {
        return new Response(null, { status: 201 });
      }
      if (method === 'GET' && pathname.endsWith('/issues')) {
        return Response.json(Object.values(store.issues));
      }
      const commentsMatch = /\\/issues\\/(\\d+)\\/comments$/.exec(pathname);
      if (commentsMatch) {
        const number = Number(commentsMatch[1]);
        if (method === 'GET') return Response.json(store.issues[number].comments ?? []);
        if (method === 'POST') {
          const body = JSON.parse(options.body);
          store.issues[number].comments = store.issues[number].comments ?? [];
          store.issues[number].comments.push({ user: { login: 'pi-triage' }, body: body.body });
          save(store);
          return Response.json({ id: store.issues[number].comments.length, body: body.body });
        }
      }
      const issueMatch = /\\/issues\\/(\\d+)$/.exec(pathname);
      if (issueMatch) {
        const number = Number(issueMatch[1]);
        if (method === 'GET') {
          const issue = store.issues[number];
          if (!issue) return new Response('not found', { status: 404 });
          return Response.json(issue);
        }
        if (method === 'PATCH') {
          const body = JSON.parse(options.body);
          store.issues[number].labels = body.labels.map(name => ({ name }));
          save(store);
          return Response.json(store.issues[number]);
        }
      }
      throw new Error('Unexpected ' + method + ' ' + url);
    };
  `);
}

function run(args, storeFile) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-triage-'));
  const mockFile = join(dir, 'mock.mjs');
  writeMock(mockFile, storeFile);
  return spawnSync(process.execPath, ['--import', pathToFileURL(mockFile).href, 'scripts/pi-triage.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'test/repo', GITHUB_TOKEN: 'synthetic-token' },
  });
}

test('prepare re-checks only triage-owned pi:needs-human issues whose body changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-triage-'));
  const storeFile = join(dir, 'store.json');
  const outFile = join(dir, 'context.json');
  writeFileSync(storeFile, JSON.stringify({
    issues: {
      // Untriaged, no pipeline label yet: a plain candidate.
      1: { number: 1, title: 'New idea', body: 'Just a rough idea.', labels: [] },
      // Already owned by the pipeline: never re-triaged.
      2: { number: 2, title: 'In progress', body: 'x', labels: [{ name: 'dispatcher:ready' }] },
      // Flagged needs-human, body unchanged since the last triage comment: skipped.
      3: {
        number: 3, title: 'Needs a person', body: 'still vague',
        labels: [{ name: 'pi:needs-human' }],
        comments: [{ body: `<!-- pi-triage:hash:${crypto.createHash('sha1').update('still vague').digest('hex').slice(0, 16)} -->` }],
      },
      // Needs-human is explicitly reconsidered only after its body changes.
      4: {
        number: 4, title: 'Clarified by a person', body: 'now concrete',
        labels: [{ name: 'pi:needs-human' }],
        comments: [{ body: `<!-- pi-triage:hash:${crypto.createHash('sha1').update('old vague body').digest('hex').slice(0, 16)} -->` }],
      },
      // A manual block is durable even if the body changes.
      5: { number: 5, title: 'Do not run', body: 'changed text', labels: [{ name: 'pi:blocked' }] },
      // Manual needs-human has no Triage marker and must remain durable.
      6: {
        number: 6, title: 'Human decision required', body: 'changed text',
        labels: [{ name: 'pi:needs-human' }], comments: [],
      },
    },
  }));

  const result = run(['prepare', outFile], storeFile);
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.deepEqual(context.candidates.map(c => c.issue), [1, 4]);
  assert.equal(context.candidates.find(c => c.issue === 4).reconsidering, true);
  assert.match(result.stdout, /2 candidate issue/);
});

test('apply marks ready issues dispatcher:ready and flags needs_human issues with a comment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-triage-'));
  const storeFile = join(dir, 'store.json');
  const jsonlFile = join(dir, 'result.jsonl');
  writeFileSync(storeFile, JSON.stringify({
    issues: {
      1: { number: 1, state: 'open', title: 'Ready to go', body: '## Goal\nClear scope.\n\n## Acceptance criteria\n- Deliver the requested behavior.\n- Keep the change scoped.\n- Add focused tests.', labels: [] },
      2: { number: 2, state: 'open', title: 'Needs clarification', body: 'Ambiguous ask.', labels: [] },
      3: {
        number: 3, state: 'open', title: 'Clarified retry',
        body: '## Goal\nClear now.\n\n## Acceptance criteria\n- Deliver the requested behavior.\n- Keep the change scoped.\n- Add focused tests.',
        labels: [{ name: 'pi:needs-human' }],
        comments: [{ body: `<!-- pi-triage:hash:${crypto.createHash('sha1').update('old ambiguous body').digest('hex').slice(0, 16)} -->` }],
      },
    },
  }));
  const triageResult = {
    ready: [1, 3],
    needs_human: [{ issue: 2, comment: 'The acceptance criteria are missing entirely.' }],
    skipped: [],
  };
  writeFileSync(jsonlFile, JSON.stringify({
    type: 'entry_appended',
    entry: { type: 'custom', customType: 'triage-result', data: triageResult },
  }));

  const result = run(['apply', jsonlFile], storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Marked #1 dispatcher:ready/);
  assert.match(result.stdout, /Flagged #2 pi:needs-human/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.deepEqual(store.issues[1].labels.map(l => l.name), ['dispatcher:ready']);
  assert.deepEqual(store.issues[2].labels.map(l => l.name), ['pi:needs-human']);
  assert.deepEqual(store.issues[3].labels.map(l => l.name), ['dispatcher:ready']);
  assert.equal(store.issues[2].comments.length, 1);
  assert.match(store.issues[2].comments[0].body, /needs a person before this can be dispatched/);
  assert.match(store.issues[2].comments[0].body, /<!-- pi-triage:hash:[0-9a-f]{16} -->/);
});
