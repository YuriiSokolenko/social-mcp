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

export function githubClient({ repo = process.env.GITHUB_REPOSITORY ?? process.env.REPO, token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN } = {}) {
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
  async function raw(path, method = 'GET', body) {
    requireConfig();
    try {
      return await fetch(root + path, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new Error(`${method} ${path}: timed out after ${timeoutMs}ms`);
      throw error;
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
