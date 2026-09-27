#!/usr/bin/env node
import { githubClient } from './github-api.mjs';

const MODES = new Set(['RUNNING','DRAINING','PAUSED']);

/**
 * Change the repository automation mode using the dedicated PI_CONTROL_TOKEN.
 * The value is read back immediately; a successful PATCH without the expected
 * value is not accepted as success.
 */
export async function setAutomationMode(mode) {
  if (!MODES.has(mode)) throw new Error(`invalid automation mode: ${mode}`);
  const { api } = githubClient();
  await api('/actions/variables/PI_AUTOMATION_MODE','PATCH',{value:mode});
  const actual = await api('/actions/variables/PI_AUTOMATION_MODE');
  if (actual.value !== mode) throw new Error(`Automation mode verification failed: expected ${mode}, got ${actual.value}`);
}

/**
 * RUNNING has exactly one normal scheduler wake: Dispatcher. Reconciler is
 * recovery/audit only and must not become a second queue owner.
 */
export async function resumeDispatcher() {
  const { dispatchWorkflow } = githubClient();
  await dispatchWorkflow('pi-dispatcher.yml');
}

async function main(){
 const [cmd,arg]=process.argv.slice(2);
 if(cmd==='set') return setAutomationMode(arg);
 if(cmd==='resume') return resumeDispatcher();
 throw new Error('usage: automation-control.mjs set <RUNNING|DRAINING|PAUSED> | resume');
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)main().catch(e=>{console.error(e);process.exitCode=1;});
