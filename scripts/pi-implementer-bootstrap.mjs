import fs from 'node:fs';

import { stageConfig } from './pi-common/stage-config.mjs';
import { prepareImplementation, writePreparedImplementation } from './pi-common/implementation-planner.mjs';

// Session A of a fresh Implementer run: a short-lived Pi process whose only job is to host the
// implementation-planner child and write the validated PreparedImplementation artifact. It shuts
// down before any model request of its own, so nothing of the planner's conversation can reach the
// main Implementer session (Session B), which starts afterwards.
//
// The planner is launched from `resources_discover`, not `session_start`: pi runs handlers
// sequentially in load order, and pi-subagents only installs the extension context that delegated
// execution needs from its own `session_start` handler. Every session_start handler has completed
// before resources_discover (which pi also awaits, even in a prompt-less run), so the context is valid.
export default function (pi) {
  const file = process.env.PI_PREPARED_IMPLEMENTATION_FILE;
  if (!file || process.env.PI_IMPLEMENTER_BOOTSTRAP !== 'true') return;

  let started = false;
  pi.on('resources_discover', async (_event, ctx) => {
    if (started) return;
    started = true;
    const config = stageConfig('implementer');
    try {
      const prepared = await prepareImplementation(pi, ctx, config, undefined);
      writePreparedImplementation(file, prepared);
      console.log(`PI_BOOTSTRAP ${JSON.stringify({
        phase: 'planner_completed',
        status: prepared.status,
        plannerDurationMs: prepared.plannerDurationMs,
        evidenceUsed: prepared.plannerEvidenceUsed ?? 0,
        evidenceCap: prepared.plannerEvidenceCap ?? config.implementationPlannerEvidenceBudget,
        providerTurns: prepared.plannerProviderTurns ?? null,
        inputTokens: prepared.plannerUsage?.input ?? null,
        outputTokens: prepared.plannerUsage?.output ?? null,
        ...(prepared.status === 'fallback' ? { failureClass: prepared.failureClass } : {}),
      })}`);
    } catch (error) {
      // No artifact is written: the runner treats a missing artifact as a bootstrap failure.
      console.warn(`PI_BOOTSTRAP ${JSON.stringify({ phase: 'failed', error: String(error?.message ?? error) })}`);
      fs.rmSync(file, { force: true });
    } finally {
      ctx.shutdown();
    }
  });
}
