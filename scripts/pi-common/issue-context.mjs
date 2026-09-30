#!/usr/bin/env node
import fs from 'node:fs';
import { githubClient } from './github-api.mjs';
import { PIPELINE_LABELS } from './state-machine.mjs';

/**
 * Load the Implementer's GitHub issue once and validate dispatch ownership.
 *
 * WHY: the workflow previously fetched the same issue twice: once to prove it
 * was still open/pi:ready and again to build the model task. One fresh read is
 * enough and avoids two independent curl snippets.
 *
 * The returned JSON is a short-lived snapshot for this single workflow run.
 * Pipeline state is still GitHub labels; this file is not transported to any
 * other workflow and is never authoritative after this preparation step.
 */
export async function loadIssue(issue) {
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('issue must be a positive integer');
  const data = await githubClient().loadIssue(issue);
  return { number: data.number, title: data.title, body: data.body ?? '', state: data.state, labels: (data.labels ?? []).map(x => x.name) };
}

export async function loadReadyIssue(issue) {
  const data = await loadIssue(issue);
  if (data.state !== 'open' || !data.labels.includes(PIPELINE_LABELS.ready)) {
    throw new Error(`Issue #${issue} is not an open ${PIPELINE_LABELS.ready} issue`);
  }
  return { number: data.number, title: data.title, body: data.body };
}
async function main() {
  const [raw, output, mode = 'ready'] = process.argv.slice(2);
  if (!output || !['ready', 'plain'].includes(mode)) throw new Error('usage: issue-context.mjs <issue> <output-json> [ready|plain]');
  const data = mode === 'ready' ? await loadReadyIssue(Number(raw)) : await loadIssue(Number(raw));
  fs.writeFileSync(output, JSON.stringify(data, null, 2));
  console.log(`Loaded ${mode === 'ready' ? 'ready ' : ''}issue #${data.number}: ${data.title}`);
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e);process.exitCode=1;});
