#!/usr/bin/env node
import fs from 'node:fs';
import { githubClient } from './github-api.mjs';

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
export async function loadReadyIssue(issue) {
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('issue must be a positive integer');
  const { api } = githubClient();
  const data = await api(`/issues/${issue}`);
  const labels = (data.labels ?? []).map(x => x.name);
  if (data.state !== 'open' || !labels.includes('pi:ready')) {
    throw new Error(`Issue #${issue} is not an open pi:ready issue`);
  }
  return { number: data.number, title: data.title, body: data.body ?? '' };
}
async function main() {
  const [raw, output] = process.argv.slice(2);
  if (!output) throw new Error('usage: issue-context.mjs <issue> <output-json>');
  const data = await loadReadyIssue(Number(raw));
  fs.writeFileSync(output, JSON.stringify(data, null, 2));
  console.log(`Loaded ready issue #${data.number}: ${data.title}`);
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e);process.exitCode=1;});
