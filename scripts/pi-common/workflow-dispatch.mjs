#!/usr/bin/env node
/**
 * Tiny workflow-facing adapter for the shared GitHub workflow dispatcher.
 *
 * WHY: workflow YAML must orchestrate, not reimplement authenticated REST calls
 * with inline curl. The shared client owns the API route and pins dispatches to
 * the trusted default branch.
 *
 * This adapter intentionally accepts only a configured workflow filename. Workflows that
 * need business inputs should dispatch from their stage script instead.
 */
import { githubClient } from './github-api.mjs';
import { projectConfig } from './project-config.mjs';

const [workflow] = process.argv.slice(2);
// Only a configured harness workflow may be woken through this adapter.
if (!Object.values(projectConfig().workflows).includes(workflow)) {
  throw new Error(`usage: workflow-dispatch.mjs <${Object.values(projectConfig().workflows).join('|')}>`);
}
await githubClient().dispatchWorkflow(workflow);
