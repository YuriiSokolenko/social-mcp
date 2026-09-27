import { pathToFileURL } from 'node:url';

import { githubClient } from './github-api.mjs';

const { api, pages, repo } = githubClient();

export function linkedIssueNumber(pr, repository) {
  const match = /^pi\/issue-([1-9]\d*)$/.exec(pr.head?.ref ?? '');
  if (pr.draft || pr.base?.ref !== 'dev' ||
      pr.base?.repo?.full_name !== repository || pr.head?.repo?.full_name !== repository || !match) return null;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || !new RegExp(`\\b(?:closes|fixes|resolves)\\s+#${number}\\b`, 'i').test(pr.body ?? '')) return null;
  return number;
}

export function issueNumber(pr, repository) {
  return pr.state === 'open' ? linkedIssueNumber(pr, repository) : null;
}

export function allowedFiles(files, changedCount) {
  return files.length === changedCount &&
    files.every(file => [file.filename, file.previous_filename].filter(Boolean).every(name =>
      !name.startsWith('.github/workflows/') && !/^scripts\/pi-[^/]+\.(?:mjs|sh)$/.test(name)));
}

async function processPR(prSummary) {
  const pr = await api(`/pulls/${prSummary.number}`);
  const issue = issueNumber(pr, repo);
  if (!issue) return;

  const prLabels = new Set((pr.labels ?? []).map(label => label.name));
  if (prLabels.has('pi:needs-human')) {
    console.log(`#${pr.number}: PR requires human attention; automation skipped`);
    return;
  }

  const issueData = await api(`/issues/${issue}`);
  const labels = new Set(issueData.labels.map(label => label.name));
  if (issueData.state !== 'open' || !labels.has('pi:mr-created') || labels.has('pi:needs-human')) {
    console.log(`#${pr.number}: issue #${issue} is not ready for merge`);
    return;
  }

  if (!prLabels.has('review:passed')) {
    console.log(`#${pr.number}: waiting for independent review PASS`);
    return;
  }

  const files = await pages(`/pulls/${pr.number}/files`);
  if (!allowedFiles(files, pr.changed_files)) {
    console.log(`#${pr.number}: changed control files or incomplete file list; human review required`);
    const nextLabels = [...prLabels].filter(label => !label.startsWith('review:'));
    if (!nextLabels.includes('pi:needs-human')) nextLabels.push('pi:needs-human');
    await api(`/issues/${pr.number}/labels`, 'PUT', { labels: nextLabels });
    const marker = `<!-- merge-gate:unsafe-pr:${pr.number} -->`;
    const comments = await pages(`/issues/${issue}/comments`);
    if (!comments.some(comment => (comment.body ?? '').includes(marker))) {
      await api(`/issues/${issue}/comments`, 'POST', {
        body: `Merge Gate stopped PR #${pr.number}: it changes CI/control-plane files or the changed-file list was incomplete. Human review is required.\n\n${marker}`,
      });
    }
    return;
  }

  // Deliberately simple contract:
  // 1. Merge the ready PR.
  // 2. The resulting push to dev runs CI.
  // 3. CI success means the merged result is good; CI failure stops the pipeline for repair/human action.
  // Do not reintroduce pre-merge dev-SHA/exact-pair integration or review status state.
  const sha = pr.head.sha;
  const fresh = await api(`/pulls/${pr.number}`);
  if (fresh.state !== 'open' || fresh.head.sha !== sha) {
    console.log(`#${pr.number}: PR changed before merge; next gate run will reconsider it`);
    return;
  }

  try {
    const merged = await api(`/pulls/${pr.number}/merge`, 'PUT', { sha, merge_method: 'squash' });
    if (!merged.merged) throw new Error(`merge API did not confirm merge`);
    console.log(`#${pr.number}: merged ${sha}; dev push CI now validates the merged result`);
    return true;
  } catch (error) {
    if (!/merge conflicts/i.test(error.message)) throw error;

    const marker = `<!-- merge-gate:conflict-pr:${pr.number}:${sha} -->`;
    const comments = await pages(`/issues/${issue}/comments`);
    if (!comments.some(comment => (comment.body ?? '').includes(marker))) {
      await api(`/issues/${issue}/comments`, 'POST', {
        body: `Merge Gate found that PR #${pr.number} conflicts with current dev. The approved HEAD can no longer be merged unchanged, so the old review is invalidated and PR Fix will integrate current dev, resolve conflicts, validate the result, and send the new HEAD through Reviewer again.\n\n${marker}`,
      });
    }

    const nextLabels = [...prLabels].filter(label => !label.startsWith('review:'));
    nextLabels.push('review:changes-requested');
    await api(`/issues/${pr.number}/labels`, 'PUT', { labels: nextLabels });
    await api('/actions/workflows/pi-pr-fix.yml/dispatches', 'POST', {
      ref: 'dev',
      inputs: { pr_number: String(pr.number) },
    });
    console.log(`#${pr.number}: merge conflict; assigned review:changes-requested ownership and dispatched PR Fix`);
    return 'blocked';
  }
}

export async function main() {
  const prs = await pages('/pulls?state=open&base=dev');
  for (const pr of prs) {
    try {
      if (await processPR(pr)) break;
    } catch (error) {
      console.error(`#${pr.number}: ${error.message}`);
      process.exitCode = 1;
      break;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
