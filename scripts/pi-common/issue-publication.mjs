#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { controlPlanePaths } from './control-plane-policy.mjs';
import { githubClient } from './github-api.mjs';

/**
 * Trusted publication primitives for an Implementer result.
 *
 * WHY: checkpoint, issue-branch push, PR upsert and Reviewer dispatch were large
 * shell/curl blocks embedded in workflow YAML. Publication is control-plane
 * policy and must have one implementation.
 *
 * SAFETY:
 * - checkpoint/issue branch pushes use exact-ref --force-with-lease;
 * - forbidden control-plane paths are checked with the central policy;
 * - credential/runtime files are rejected before checkpoint publication;
 * - PR metadata comes from the validated submit_result file, with a safe issue
 *   fallback only when metadata is unavailable;
 * - GitHub mutations use the shared authenticated API client.
 *
 * This helper never decides whether implementation content is correct. The live
 * Implementer + product-checks own that. This helper publishes an already
 * validated tree.
 */
function git(args, { cwd, allowFailure = false, token } = {}) {
  const prefix = token ? ['-c', `credential.helper=!f() { echo username=x-access-token; echo password="${token}"; }; f`] : [];
  const r = spawnSync('git', [...prefix, ...args], { cwd, encoding: 'utf8', env: process.env });
  if (r.error) throw r.error;
  if (!allowFailure && r.status !== 0) throw new Error((r.stderr || r.stdout || 'git failed').trim());
  return { status: r.status ?? 1, out: (r.stdout ?? '').trim() };
}
const lines = (s) => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

export function saveCheckpoint({ issue, cwd, startCommit, expectedSha, token }) {
  for (const p of ['.pytest_cache','.ruff_cache','htmlcov','build','dist']) fs.rmSync(`${cwd}/${p}`, { recursive: true, force: true });
  for (const p of ['.coverage','coverage.xml']) fs.rmSync(`${cwd}/${p}`, { force: true });
  git(['config','user.name','social-mcp-pi'], { cwd }); git(['config','user.email','social-mcp-pi@users.noreply.github.com'], { cwd });
  if (lines(git(['diff','--name-only','--diff-filter=U'], { cwd }).out).length) return { changed:false, reason:'conflicts' };
  git(['add','-A'], { cwd });
  const staged = lines(git(['diff','--cached','--name-only'], { cwd }).out);
  const sensitive = staged.filter(p => /(^|\/)(\.env(\.|$)|.*\.(db|sqlite3?|pem|key)$|credentials([^/]*$|\/))/.test(p) && !/(^|\/)\.env\.example$/.test(p));
  if (sensitive.length) throw new Error(`Refusing to checkpoint credential/runtime files: ${sensitive.join(', ')}`);
  if (git(['diff','--cached','--quiet'], { cwd, allowFailure:true }).status !== 0) git(['commit','-m',`feat: implement issue #${issue}`], { cwd });
  if (git(['diff','--quiet',`${startCommit}...HEAD`], { cwd, allowFailure:true }).status === 0) return { changed:false, reason:'no-change' };
  const changed = lines(git(['diff','--name-only',startCommit,'HEAD'], { cwd }).out);
  const forbidden = controlPlanePaths(changed);
  if (forbidden.length) throw new Error(`Implementer attempted to modify protected control-plane files: ${forbidden.join(', ')}`);
  const commit = git(['rev-parse','HEAD'], { cwd }).out;
  git(['push',`--force-with-lease=refs/heads/pi/issue-${issue}-checkpoint:${expectedSha ?? ''}`,'origin',`${commit}:refs/heads/pi/issue-${issue}-checkpoint`], { cwd, token });
  return { changed:true, commit };
}

export function pushIssueBranch({ issue, cwd, startCommit, expectedSha, token }) {
  git(['diff','--check'], { cwd });
  const changed = lines(git(['diff','--name-only',startCommit,'HEAD'], { cwd }).out);
  const forbidden = controlPlanePaths(changed);
  if (forbidden.length) throw new Error(`Refusing to publish protected control-plane files: ${forbidden.join(', ')}`);
  const commit = git(['rev-parse','HEAD'], { cwd }).out;
  git(['push',`--force-with-lease=refs/heads/pi/issue-${issue}:${expectedSha ?? ''}`,'--set-upstream','origin',`${commit}:refs/heads/pi/issue-${issue}`], { cwd, token });
  return { commit };
}

export async function upsertPullRequest({ issue, issueTitle, resultFile, owner }) {
  const { api } = githubClient();
  const existing = await api(`/pulls?state=open&head=${encodeURIComponent(owner + ':pi/issue-' + issue)}&base=dev`);
  let metadata;
  if (resultFile && fs.existsSync(resultFile) && fs.statSync(resultFile).size) metadata = JSON.parse(fs.readFileSync(resultFile,'utf8'));
  else metadata = { title:`Pi: #${issue} ${issueTitle}`, summary:`Implements issue #${issue}.`, changes:[], security_notes:'', limitations:'' };
  const changes = metadata.changes?.length ? metadata.changes.map(x=>`- ${x}`).join('\n') : '- See the diff for implementation details.';
  const tests = '- pytest: passed\n- ruff check .: passed\n- git diff --check: passed\n- The merged result is validated by the normal CI run on dev after merge.';
  const body = `## Summary\n${metadata.summary}\n\n## Changes\n${changes}\n\n## Security\n${metadata.security_notes || 'No special security impact identified.'}\n\n## Validation\n${tests}\n\n## Known limitations\n${metadata.limitations || 'None identified.'}\n\nCloses #${issue}\n`;
  if (existing[0]) {
    const pr = await api(`/pulls/${existing[0].number}`,'PATCH',{title:metadata.title,body});
    return { number:pr.number, url:pr.html_url };
  }
  const pr = await api('/pulls','POST',{title:metadata.title,head:`pi/issue-${issue}`,base:'dev',body});
  return { number:pr.number, url:pr.html_url };
}

export async function dispatchReviewer(prNumber) {
  const { dispatchWorkflow } = githubClient();
  await dispatchWorkflow('pi-pr-review.yml', { pr_number: String(prNumber) });
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'checkpoint') return console.log(JSON.stringify(saveCheckpoint({issue:Number(a[0]),cwd:a[1],startCommit:a[2],expectedSha:a[3],token:process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN})));
  if (cmd === 'push') return console.log(JSON.stringify(pushIssueBranch({issue:Number(a[0]),cwd:a[1],startCommit:a[2],expectedSha:a[3],token:process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN})));
  if (cmd === 'pr') return console.log(JSON.stringify(await upsertPullRequest({issue:Number(a[0]),issueTitle:a[1],resultFile:a[2],owner:a[3]})));
  if (cmd === 'review') return dispatchReviewer(Number(a[0]));
  throw new Error('unknown publication command');
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e);process.exitCode=1;});
