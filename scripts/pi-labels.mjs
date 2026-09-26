#!/usr/bin/env node
import { githubClient } from './github-api.mjs';

const [kind] = process.argv.slice(2);
if (kind !== 'issue') throw new Error('usage: pi-labels.mjs issue');
const { ensureLabel } = githubClient();
const labels = [
  ['dispatcher:ready','5319e7','Ready for deterministic dispatcher ownership'],
  ['architect:ready','c5def5','Large issue approved for Pi Architect'],
  ['architect:epic','8250df','Architect epic containing child issues'],
  ['pi:ready','57f678','Ready for the Pi issue agent'],
  ['pi:running','0052cc','Pi agent is working on this issue'],
  ['pi:mr-created','1d76db','Pi agent created a pull request'],
  ['pi:needs-human','fbca04','Automation requires human attention'],
];
for (const [name, color, description] of labels) await ensureLabel(name, color, description);
