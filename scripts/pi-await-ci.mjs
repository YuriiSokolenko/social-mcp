#!/usr/bin/env node
const repo = process.env.REPO ?? process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const sha = process.env.HEAD_SHA ?? process.argv[2];
const branch = process.env.HEAD_REF ?? process.argv[3];
const baseSha = process.env.BASE_SHA ?? process.argv[4];
if (!repo || !token || !sha || !branch || !baseSha) throw new Error('repo, token, SHA, branch and base SHA are required');

const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28' };
const root = `https://api.github.com/repos/${repo}`;
async function api(path, options = {}) {
  const response = await fetch(root + path, { ...options, headers: { ...headers, ...(options.body ? {'Content-Type':'application/json'} : {}) } });
  if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
const dispatchIdentity = `target:${sha} ref:${branch} base:${baseSha}`;
function matching(runs) {
  return (runs.workflow_runs ?? []).filter(run =>
    run.event === 'workflow_dispatch' &&
    run.display_title === `🧪 CI · ${dispatchIdentity}`
  ).sort((a,b) => b.id-a.id)[0] ?? null;
}
let data = await api('/actions/workflows/ci.yml/runs?event=workflow_dispatch&branch=dev&per_page=100');
let run = matching(data);
if (!run) {
  console.error(`Waiting for Merge Gate to dispatch integration CI for dev ${baseSha.slice(0,12)} + ${branch} @ ${sha.slice(0,12)}`);
}
const deadline = Date.now() + Number(process.env.PI_CI_WAIT_MS ?? 20 * 60 * 1000);
while (Date.now() < deadline) {
  if (!run) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    data = await api('/actions/workflows/ci.yml/runs?event=workflow_dispatch&branch=dev&per_page=100');
    run = matching(data);
    continue;
  }
  if (run.status === 'completed') {
    console.log(JSON.stringify({ id: run.id, url: run.html_url, sha, branch, baseSha, status: run.status, conclusion: run.conclusion }));
    process.exit(run.conclusion === 'success' ? 0 : 3);
  }
  await new Promise(resolve => setTimeout(resolve, 10000));
  data = await api('/actions/workflows/ci.yml/runs?event=workflow_dispatch&branch=dev&per_page=100');
  run = matching(data);
}
throw new Error(`Timed out waiting for integration CI on ${baseSha} + ${sha}`);
