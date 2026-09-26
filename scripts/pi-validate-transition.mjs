#!/usr/bin/env node
import { validateIssueTransition, validateReviewTransition } from './pi-state-machine.mjs';

const [kind, action] = process.argv.slice(2);
const repo = process.env.REPO;
const token = process.env.GH_TOKEN;
const number = kind === 'issue' ? process.env.ISSUE : process.env.PR;
if (!['issue', 'review'].includes(kind) || !action || !repo || !token || !number) {
  throw new Error('usage: pi-validate-transition.mjs <issue|review> <action>');
}
const endpoint = kind === 'issue' ? `issues/${number}` : `pulls/${number}`;
const response = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28' },
});
if (!response.ok) throw new Error(`cannot load ${kind} #${number}: ${response.status} ${await response.text()}`);
const item = await response.json();
const target = kind === 'issue' ? validateIssueTransition(item, action) : validateReviewTransition(item, action);
console.log(`${kind} #${number}: transition ${action} -> ${target} allowed`);
