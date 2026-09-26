#!/usr/bin/env node
const [kind] = process.argv.slice(2);
const repo = process.env.REPO;
const token = process.env.GH_TOKEN;
if (!['issue', 'review'].includes(kind) || !repo || !token) throw new Error('usage: pi-labels.mjs <issue|review>');
const labels = kind === 'issue' ? [
  ['pi:ready','57f678','Ready for the Pi issue agent'],
  ['pi:running','0052cc','Pi agent is working on this issue'],
  ['pi:mr-created','1d76db','Pi agent created a pull request'],
  ['pi:needs-human','fbca04','Pi finished without a usable repository change'],
  ['pi:failed','d73a4a','Pi agent workflow failed'],
  ['pi:cancelled','6e7781','Pi agent workflow was cancelled'],
] : [
  ['review:ready','bfdadc','Ready for automated Pi review'],
  ['review:running','fbca04','Automated Pi review is running'],
  ['review:passed','0e8a16','Automated Pi review passed'],
  ['review:changes-requested','d93f0b','Automated Pi review found changes to make'],
  ['review:failed','b60205','Automated Pi review workflow failed'],
];
const base=`https://api.github.com/repos/${repo}`;
const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'};
for (const [name,color,description] of labels) {
  const response=await fetch(`${base}/labels`,{method:'POST',headers,body:JSON.stringify({name,color,description})});
  if (![201,422].includes(response.status)) throw new Error(`Cannot ensure ${name}: ${response.status} ${await response.text()}`);
}
