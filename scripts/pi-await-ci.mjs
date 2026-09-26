#!/usr/bin/env node
const repo = process.env.REPO ?? process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const sha = process.env.HEAD_SHA ?? process.argv[2];
const branch = process.env.HEAD_REF ?? process.argv[3];
if (!repo || !token || !sha || !branch) throw new Error('repo, token, SHA and branch are required');

const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28' };
const root = `https://api.github.com/repos/${repo}`;
async function api(path, options = {}) {
  const response = await fetch(root + path, { ...options, headers: { ...headers, ...(options.body ? {'Content-Type':'application/json'} : {}) } });
  if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
function matching(runs) {
  return (runs.workflow_runs ?? []).filter(run => run.head_sha === sha && run.head_branch === branch &&
    ['push','workflow_dispatch'].includes(run.event)).sort((a,b) => b.id-a.id)[0] ?? null;
}
let data = await api(`/actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`);
let run = matching(data);
if (!run) {
  await api('/actions/workflows/ci.yml/dispatches', { method:'POST', body: JSON.stringify({ ref: branch }) });
  console.log(`CI dispatched for ${branch} @ ${sha.slice(0,12)}`);
}
const deadline = Date.now() + Number(process.env.PI_CI_WAIT_MS ?? 20 * 60 * 1000);
while (Date.now() < deadline) {
  if (!run) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    data = await api(`/actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`);
    run = matching(data);
    continue;
  }
  if (run.status === 'completed') {
    console.log(JSON.stringify({ id: run.id, url: run.html_url, sha, branch, status: run.status, conclusion: run.conclusion }));
    process.exit(run.conclusion === 'success' ? 0 : 3);
  }
  await new Promise(resolve => setTimeout(resolve, 10000));
  data = await api(`/actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`);
  run = matching(data);
}
throw new Error(`Timed out waiting for CI on ${sha}`);
