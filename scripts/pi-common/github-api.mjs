/**
 * Shared authenticated GitHub REST client for trusted Pi control-plane code.
 *
 * WHY: pagination/auth/error handling must behave identically in Dispatcher,
 * Architect, PR guards, Merge Gate and recovery code. Workflows should not
 * grow their own curl loops.
 *
 * GUARANTEES: fail on non-2xx responses; pages() exhausts every 100-item page;
 * ensureLabel() treats "already exists" as success.
 *
 * NOT FOR: agent worktrees or untrusted PR code. Callers must run this module
 * from the trusted control-plane checkout of the default branch.
 */

import { baseBranch } from './project-config.mjs';

export function githubClient({
  repo = process.env.GITHUB_REPOSITORY ?? process.env.REPO,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  // Optional, trusted control-plane diagnostics. No URL, token, or response body
  // is passed to either callback.
  onRequest, onPage, signal,
} = {}) {
  const requireConfig = () => {
    if (!repo || !token) throw new Error('GitHub repository and token are required');
  };
  const root = repo ? `https://api.github.com/repos/${repo}` : null;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const timeoutMs = Number(process.env.PI_GITHUB_HTTP_TIMEOUT_MS ?? 30000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('PI_GITHUB_HTTP_TIMEOUT_MS must be a positive integer');
  }
  let requestSequence = 0;
  const requestInfo = (path, method) => {
    const url = new URL(path, 'https://example.invalid');
    const name = url.pathname;
    const category = name === '/issues' ? 'issues'
      : name === '/pulls' ? 'pulls'
        : name === '/actions/runs' ? 'workflow-runs'
          : name.startsWith('/git/matching-refs/') ? 'issue-refs'
            : name.startsWith('/actions/workflows/') ? 'workflow-dispatch'
              : name.startsWith('/git/refs/') ? 'checkpoint-ref'
                : name.startsWith('/issues/') && name.endsWith('/labels') ? 'issue-labels'
                  : name.startsWith('/issues/') ? 'issue'
                    : 'other';
    const page = Number(url.searchParams.get('page'));
    const status = url.searchParams.get('status');
    return {
      method, category,
      ...(Number.isSafeInteger(page) && page > 0 ? { page } : {}),
      ...(category === 'workflow-runs' &&
        ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(status) ? { status } : {}),
    };
  };
  async function raw(path, method = 'GET', body) {
    requireConfig();
    const requestId = ++requestSequence;
    const info = requestInfo(path, method);
    const started = performance.now();
    const requestTimeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout;
    onRequest?.({ event: 'start', id: requestId, ...info });
    let onAbort;
    try {
      // Promise.race also covers a transport/mock which ignores AbortSignal.
      // The signal still aborts real in-flight fetches.
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(requestSignal.reason ?? new Error('request aborted'));
        requestSignal.addEventListener('abort', onAbort, { once: true });
        if (requestSignal.aborted) onAbort();
      });
      const response = await Promise.race([
        fetch(root + path, {
          method,
          headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: requestSignal,
        }),
        aborted,
      ]);
      onRequest?.({ event: 'end', id: requestId, ...info, code: response.status,
        durationMs: Math.round(performance.now() - started) });
      return response;
    } catch (error) {
      const cause = signal?.aborted ? 'deadline'
        : requestTimeout.aborted || error?.name === 'TimeoutError' ? 'timeout' : 'transport';
      onRequest?.({ event: 'error', id: requestId, ...info, cause,
        durationMs: Math.round(performance.now() - started) });
      if (signal?.aborted) throw new Error('Reconciler execution deadline exceeded');
      if (cause === 'timeout') throw new Error(`${method} ${path}: timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      if (onAbort) requestSignal.removeEventListener('abort', onAbort);
    }
  }
  async function api(path, method = 'GET', body) {
    const response = await raw(path, method, body);
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }
  async function pages(path) {
    const all = [];
    for (let page = 1; ; page++) {
      const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      all.push(...batch);
      onPage?.({ ...requestInfo(path, 'GET'), page, items: batch.length, total: all.length });
      if (batch.length < 100) return all;
    }
  }
  async function ensureLabel(name, color, description) {
    requireConfig();
    const response = await raw('/labels', 'POST', { name, color, description });
    if (![201, 422].includes(response.status)) {
      throw new Error(`Cannot ensure ${name} label: ${response.status} ${await response.text()}`);
    }
  }
  const loadPullRequest = prNumber => api(`/pulls/${prNumber}`);
  const loadIssue = number => api(`/issues/${number}`);
  const updateIssue = (number, body) => api(`/issues/${number}`, 'PATCH', body);
  const replaceLabels = (number, labels) => api(`/issues/${number}/labels`, 'PUT', { labels });
  const comment = (number, body) => api(`/issues/${number}/comments`, 'POST', { body });
  // Always dispatch the trusted default branch, never a caller-chosen ref.
  const dispatchWorkflow = (workflow, inputs) => api(
    `/actions/workflows/${workflow}/dispatches`,
    'POST',
    inputs === undefined ? { ref: baseBranch() } : { ref: baseBranch(), inputs },
  );
  async function workflowRuns(path) {
    const all = [];
    for (let page = 1; ; page++) {
      const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = data.workflow_runs ?? [];
      all.push(...batch);
      onPage?.({ ...requestInfo(path, 'GET'), page, items: batch.length, total: all.length });
      if (batch.length < 100) return all;
    }
  }
  async function deleteRef(ref) {
    try {
      await api(`/git/refs/${ref}`, 'DELETE');
    } catch (error) {
      // GitHub can report an already-missing ref as either 404 or
      // 422 "Reference does not exist". Ref cleanup is intentionally idempotent.
      if (!/DELETE .*: 404 /.test(error.message) &&
          !/DELETE .*: 422 .*Reference does not exist/i.test(error.message)) {
        throw error;
      }
    }
  }

  return {
    api, raw, pages, ensureLabel, repo,
    loadPullRequest, loadIssue, updateIssue, replaceLabels, comment, dispatchWorkflow, workflowRuns, deleteRef,
  };
}
