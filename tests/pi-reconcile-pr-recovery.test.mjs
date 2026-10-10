import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('real reconciler apply path restarts stranded PR ownership after the grace period', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reconcile-pr-recovery-'));
  const preload = path.join(dir, 'fake-github.mjs');
  const callsFile = path.join(dir, 'calls.jsonl');

  fs.writeFileSync(preload, `
    import fs from 'node:fs';

    const repo = process.env.GITHUB_REPOSITORY;
    const callsFile = process.env.TEST_GITHUB_CALLS;
    const old = '2020-01-01T00:00:00Z';
    const prs = [
      {
        number: 101,
        title: 'stranded unreviewed PR',
        state: 'open',
        draft: false,
        created_at: old,
        updated_at: old,
        labels: [{ name: 'pi:mr-created' }],
        base: { ref: 'dev' },
        head: { ref: 'pi/issue-101', repo: { full_name: repo } },
      },
      {
        number: 102,
        title: 'stranded changes-requested PR',
        state: 'open',
        draft: false,
        created_at: old,
        updated_at: old,
        labels: [{ name: 'pi:mr-created' }, { name: 'review:changes-requested' }],
        base: { ref: 'dev' },
        head: { ref: 'pi/issue-102', repo: { full_name: repo } },
      },
      {
        number: 103,
        title: 'stranded passed PR',
        state: 'open',
        draft: false,
        created_at: old,
        updated_at: old,
        labels: [{ name: 'pi:mr-created' }, { name: 'review:passed' }],
        base: { ref: 'dev' },
        head: { ref: 'pi/issue-103', repo: { full_name: repo } },
      },
    ];

    const json = (value, status = 200) => new Response(
      value === null ? null : JSON.stringify(value),
      {
        status,
        headers: value === null ? undefined : { 'content-type': 'application/json' },
      },
    );

    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      const prefix = \`/repos/\${repo}\`;
      if (!parsed.pathname.startsWith(prefix)) {
        return json({ message: 'unexpected host/path' }, 500);
      }
      const endpoint = parsed.pathname.slice(prefix.length);
      const method = options.method ?? 'GET';

      if (method === 'GET' && endpoint === '/issues' && parsed.searchParams.get('state') === 'all') {
        return json([]);
      }
      if (method === 'GET' && endpoint === '/pulls' && parsed.searchParams.get('state') === 'all') {
        return json(prs);
      }
      if (method === 'GET' && endpoint === '/git/matching-refs/heads/pi/') {
        return json([]);
      }
      if (method === 'GET' && endpoint === '/actions/runs') {
        return json({ workflow_runs: [] });
      }
      if (method === 'POST' && /^\\/actions\\/workflows\\/[^/]+\\/dispatches$/.test(endpoint)) {
        fs.appendFileSync(callsFile, JSON.stringify({
          method,
          endpoint,
          body: JSON.parse(options.body ?? '{}'),
        }) + '\\n');
        return json(null, 204);
      }

      return json({
        message: \`unexpected request: \${method} \${endpoint}\${parsed.search}\`,
      }, 500);
    };
  `);

  try {
    const result = spawnSync(
      process.execPath,
      ['--import', preload, 'scripts/pi-reconcile.mjs', '--apply'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'example/repo',
          GITHUB_TOKEN: 'test-token',
          GITHUB_WORKSPACE: root,
          PI_AUTOMATION_MODE: 'RUNNING',
          TEST_GITHUB_CALLS: callsFile,
        },
      },
    );

    assert.equal(
      result.status,
      0,
      `reconciler failed:\nstdout:\n\${result.stdout}\nstderr:\n\${result.stderr}`,
    );

    const calls = fs.existsSync(callsFile)
      ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];

    assert.deepEqual(calls, [
      {
        method: 'POST',
        endpoint: '/actions/workflows/pi-pr-review.yml/dispatches',
        body: { ref: 'dev', inputs: { pr_number: '101' } },
      },
      {
        method: 'POST',
        endpoint: '/actions/workflows/pi-pr-fix.yml/dispatches',
        body: { ref: 'dev', inputs: { pr_number: '102' } },
      },
      {
        method: 'POST',
        endpoint: '/actions/workflows/pi-auto-merge.yml/dispatches',
        body: { ref: 'dev' },
      },
    ]);

    assert.match(result.stdout, /PR #101/);
    assert.match(result.stdout, /recovery: unreviewed \+ Reviewer/);
    assert.match(result.stdout, /PR #102/);
    assert.match(result.stdout, /recovery: review:changes-requested \+ PR Fix/);
    assert.match(result.stdout, /PR #103/);
    assert.match(result.stdout, /recovery: review:passed \+ Merge Gate/);
    assert.doesNotMatch(result.stdout, /stranded unreviewed PR|stranded changes-requested PR|stranded passed PR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
