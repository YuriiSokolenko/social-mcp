#!/usr/bin/env node
/**
 * Tiny workflow-facing adapter for the shared GitHub workflow dispatcher.
 *
 * WHY: workflow YAML must orchestrate, not reimplement authenticated REST calls
 * with inline curl. The shared client owns the API route and pins dispatches to
 * trusted dev.
 *
 * This adapter intentionally accepts only a workflow filename. Workflows that
 * need business inputs should dispatch from their stage script instead.
 */
import { githubClient } from './github-api.mjs';

const [workflow] = process.argv.slice(2);
if (!/^pi-[a-z0-9-]+\.yml$/.test(workflow ?? '')) {
  throw new Error('usage: workflow-dispatch.mjs <pi-workflow.yml>');
}
await githubClient().dispatchWorkflow(workflow);
