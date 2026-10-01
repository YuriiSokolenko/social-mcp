#!/usr/bin/env node
import { githubClient } from './pi-common/github-api.mjs';
import { projectConfig } from './pi-common/project-config.mjs';

const [kind] = process.argv.slice(2);
if (kind !== 'issue') throw new Error('usage: pi-labels.mjs issue');
const { ensureLabel } = githubClient();
// Label NAMES are project config; colour and description are harness defaults per role.
const labels = [
  ['queued','5319e7','Ready for deterministic dispatcher ownership'],
  ['architectReady','c5def5','Large issue approved for the Architect'],
  ['epic','8250df','Architect epic containing child issues'],
  ['ready','57f678','Ready for the Implementer'],
  ['running','0052cc','Agent is working on this issue'],
  ['pr','1d76db','Agent created a pull request'],
  ['needsHuman','fbca04','Automation requires human attention'],
  ['blocked','d93f0b','Human-blocked issue; automation must not dispatch it'],
];
for (const [role, color, description] of labels) {
  const name = projectConfig().labels[role];
  if (name) await ensureLabel(name, color, description);
}
