// Deterministic child-process fetch preload for Reconciler observability tests.
// No network calls, model, credentials or real GitHub state are used.
import fs from 'node:fs';

const mode = process.env.TEST_RECONCILE_MODE ?? 'fast';
const repo = process.env.GITHUB_REPOSITORY;
const callsFile = process.env.TEST_RECONCILE_CALLS;
const old = '2020-01-01T00:00:00Z';
const issue = (number, labels = []) => ({
  number, title: 'private-issue-title-' + number, state: 'open',
  labels: labels.map(name => ({ name })), created_at: old, updated_at: old,
});
const orphanIssues = [issue(1, ['pi:running']), issue(2, ['pi:running'])];
const response = (body, status = 200) => new Response(
  status === 204 ? null : JSON.stringify(body),
  { status, headers: status === 204 ? undefined : { 'content-type': 'application/json' } },
);

globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const prefix = '/repos/' + repo;
  const endpoint = parsed.pathname.slice(prefix.length);
  const method = options.method ?? 'GET';
  if (!parsed.pathname.startsWith(prefix)) throw new Error('unexpected test repository');
  if (callsFile) fs.appendFileSync(callsFile, JSON.stringify({
    endpoint, method, page: Number(parsed.searchParams.get('page') ?? 0),
    status: parsed.searchParams.get('status'),
    ...(method === 'PATCH' ? { body: JSON.parse(options.body) } : {}),
  }) + '\n');
  if (endpoint === '/issues' && method === 'GET') {
    if (mode === 'hung') return new Promise(() => {});
    if (mode === 'cancel') return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('test abort')), { once: true });
    });
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 45));
    if (mode === 'rate429') return response({ message: 'PRIVATE_RESPONSE_BODY_TOKEN' }, 429);
    if (mode === 'server503') return response({ message: 'PRIVATE_RESPONSE_BODY_TOKEN' }, 503);
    if (mode === 'multipage') {
      const page = Number(parsed.searchParams.get('page'));
      return response(page === 1
        ? Array.from({ length: 100 }, (_, index) => issue(index + 1))
        : page === 2 ? [issue(101)] : []);
    }
    return response(['partial', 'retry', 'paused', 'live'].includes(mode) ? orphanIssues : []);
  }
  if (endpoint === '/pulls' && method === 'GET') return response([]);
  if (endpoint === '/git/matching-refs/heads/pi/' && method === 'GET') return response([]);
  if (endpoint === '/actions/runs' && method === 'GET') {
    if (mode === 'live' && parsed.searchParams.get('status') === 'in_progress') {
      return response({ workflow_runs: [{
        status: 'in_progress', display_title: '🤖 Implement #1',
      }] });
    }
    return response({ workflow_runs: [] });
  }
  const issueMatch = /^\/issues\/(\d+)$/.exec(endpoint);
  if (issueMatch && method === 'GET') return response(orphanIssues[Number(issueMatch[1]) - 1]);
  if (issueMatch && method === 'PATCH') {
    if (mode === 'partial' && Number(issueMatch[1]) === 2) {
      return response({ message: 'PRIVATE_RESPONSE_BODY_TOKEN' }, 503);
    }
    return response({ labels: JSON.parse(options.body).labels });
  }
  if (endpoint.startsWith('/actions/workflows/') && method === 'POST') return response(null, 204);
  throw new Error('unexpected fake GitHub operation');
};
