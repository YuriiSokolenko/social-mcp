import fs from 'node:fs';

import { stageConfig } from './pi-common/stage-config.mjs';
import { prepareImplementation, writePreparedImplementation } from './pi-common/implementation-planner.mjs';

// Session A of a fresh Implementer run: a short-lived Pi process whose only job is to host the
// implementation-planner child and write the validated PreparedImplementation artifact. It shuts
// down from session_start, before any model request of its own, so nothing of the planner's
// conversation can reach the main Implementer session (Session B), which starts afterwards.
export default function (pi) {
  const file = process.env.PI_PREPARED_IMPLEMENTATION_FILE;
  if (!file || process.env.PI_IMPLEMENTER_BOOTSTRAP !== 'true') return;

  pi.on('session_start', async (_event, ctx) => {
    const config = stageConfig('implementer');
    try {
      const prepared = await prepareImplementation(pi, ctx, config, undefined);
      writePreparedImplementation(file, prepared);
      console.log(`PI_BOOTSTRAP ${JSON.stringify({
        phase: 'planner_completed',
        status: prepared.status,
        plannerDurationMs: prepared.plannerDurationMs,
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
