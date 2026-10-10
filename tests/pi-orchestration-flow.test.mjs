import { test } from 'node:test';

import {
  architectSplit, automationModes, delayedCompletion, gatedStates, happyPath, repairLoop, staleHead,
} from './helpers/orchestration-scenarios.mjs';

// Cross-stage behavioral coverage (#727): production stage entrypoints run as
// child processes against one stateful fake GitHub. Scenario bodies live in
// helpers/orchestration-scenarios.mjs so pi-orchestration-mutants.test.mjs can
// replay them against deliberately broken control-plane copies.

test('happy path: Triage → Dispatcher → Implementer → PR → Reviewer PASS → Merge Gate → post-merge, and a second pass is a no-op', happyPath);
test('Dispatcher ARCHITECT → Architect split exposes children in dependency order; Reconciler completes an interrupted split', architectSplit);
test('CHANGES_REQUESTED → PR Fix publishes a new HEAD → verdict invalidated → lost Reviewer handoff recovered once → PASS → merge', repairLoop);
test('a verdict, follow-up or merge for an outdated PR HEAD is never accepted', staleHead);
test('RUNNING, DRAINING and PAUSED keep their dispatch and recovery policies; mode changes are read back', automationModes);
test('blocked, draft, needs-human, unverified and control-plane work never proceeds; publication is idempotent', gatedStates);
test('a late failure signal after the PR merged completes the issue instead of escalating it', delayedCompletion);
