#!/usr/bin/env node
import { githubClient } from './pi-common/github-api.mjs';
import { ISSUE_ACTIVE, PIPELINE_LABELS } from './pi-common/state-machine.mjs';

const { pages } = githubClient();
const issues = await pages('/issues?state=open');
const active = new Set([...ISSUE_ACTIVE, PIPELINE_LABELS.queued]);
for (const issue of issues) {
  if (issue.pull_request) continue;
  if (issue.labels.some(label => active.has(label.name))) console.log(issue.number);
}
