#!/usr/bin/env node
import { githubClient } from './github-api.mjs';
import { projectConfig, workflowFile } from './project-config.mjs';

const MODES = new Set(['RUNNING','DRAINING','PAUSED']);

/**
 * Change the repository automation mode (a repository variable named by the
 * project config) using the dedicated control token.
 * The value is read back immediately; a successful PATCH without the expected
 * value is not accepted as success.
 */
export async function setAutomationMode(mode) {
  if (!MODES.has(mode)) throw new Error(`invalid automation mode: ${mode}`);
  const { api } = githubClient();
  const variable = projectConfig().automation.modeVariable;
  await api(`/actions/variables/${variable}`,'PATCH',{value:mode});
  const actual = await api(`/actions/variables/${variable}`);
  if (actual.value !== mode) throw new Error(`Automation mode verification failed: expected ${mode}, got ${actual.value}`);
}

/**
 * RUNNING has exactly one normal scheduler wake: Dispatcher. Reconciler is
 * recovery/audit only and must not become a second queue owner.
 */
export async function resumeDispatcher() {
  const { dispatchWorkflow } = githubClient();
  await dispatchWorkflow(workflowFile('dispatcher'));
}

async function main(){
 const [cmd,arg]=process.argv.slice(2);
 if(cmd==='set') return setAutomationMode(arg);
 if(cmd==='resume') return resumeDispatcher();
 throw new Error('usage: automation-control.mjs set <RUNNING|DRAINING|PAUSED> | resume');
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)main().catch(e=>{console.error(e);process.exitCode=1;});
