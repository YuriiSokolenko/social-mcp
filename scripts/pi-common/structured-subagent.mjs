import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const SUBAGENT_DELEGATION_REQUEST_EVENT = 'prompt-template:subagent:request';
const SUBAGENT_DELEGATION_RESPONSE_EVENT = 'prompt-template:subagent:response';

// Descendant usage is appended to the shared metrics file (inherited by child processes) and
// replayed into the job log by the log filter; it never depends on the child finishing cleanly.
export function recordDescendantMetric(record, env = process.env) {
  if (!env.PI_METRICS_FILE) return;
  try {
    fs.appendFileSync(env.PI_METRICS_FILE, `${JSON.stringify({ issue: Number(env.PI_ISSUE) || 0, phase: env.PI_PHASE ?? 'agent', descendant: true, ...record })}\n`);
  } catch (error) {
    console.warn(`PI_USAGE_RECORD_FAILED ${JSON.stringify({ error: String(error?.message ?? error) })}`);
  }
}

// `context: 'fork'` branches the parent's persisted session transcript into the child
// (pi-subagents createBranchedSession); `childEnv` is visible only while the child runs.
export async function runStructuredSubagent(pi, ctx, {
  agent, nodeId, task, schema = null, timeoutMs, maxTokens = null, toolBudget = { hard: 1 },
  context = 'fresh', childEnv = {}, thinking = null, metricCall = null,
}, signal) {
  const requestId = randomUUID();
  // Every attempt is its own accounted session, whatever its outcome (metricCall opts in).
  let metricStatus = 'error';
  let metricUsage = null;
  const ownerRunId = ctx.sessionManager.getSessionId();
  const previousBudget = process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS;
  if (maxTokens) process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = String(maxTokens);
  const previousEnv = Object.fromEntries(Object.keys(childEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, childEnv);

  try {
    const response = await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      let unsubscribe = () => {};

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener?.('abort', onAbort);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const onAbort = () => finish(reject, Object.assign(new Error(`${agent} delegation was aborted`), { delegationStatus: 'cancelled' }));

      unsubscribe = pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
        if (payload?.requestId !== requestId) return;
        if (payload.status !== 'invalid_request' &&
            (payload.ownerRunId !== ownerRunId || payload.nodeId !== nodeId)) return;
        finish(resolve, payload);
      });

      timer = setTimeout(
        () => finish(reject, Object.assign(new Error(`${agent} did not return within ${timeoutMs} ms`), { delegationStatus: 'timed_out' })),
        timeoutMs + 5000,
      );
      signal?.addEventListener?.('abort', onAbort, { once: true });

      pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
        requestId,
        ownerRunId,
        nodeId,
        agent,
        task,
        context,
        cwd: ctx.cwd,
        timeoutMs,
        ...(toolBudget ? { toolBudget } : {}),
        // Request-level thinking wins over the agent's (incl. worktree agentOverrides/defaults).
        ...(thinking ? { thinking } : {}),
        intercomBridge: { mode: 'off' },
        result: schema ? { kind: 'structured', schema } : { kind: 'text' },
      });
    });

    if (response.status !== 'completed') {
      // Terminal failure still carries whatever usage the child accrued; keep it for attribution.
      throw Object.assign(new Error(`${agent} failed: ${response.error || response.status}`), {
        delegationStatus: response.status,
        delegationUsage: response.usage ?? null,
      });
    }
    metricStatus = 'completed';
    metricUsage = response.usage ?? null;
    if (schema && response.result?.kind !== 'structured') {
      throw Object.assign(new Error(`${agent} did not return a structured result`), { delegationUsage: metricUsage });
    }
    return response;
  } catch (error) {
    if (metricStatus !== 'completed') {
      metricStatus = error?.delegationStatus ?? 'error';
      metricUsage = error?.delegationUsage ?? null;
    }
    throw error;
  } finally {
    if (metricCall) {
      recordDescendantMetric({
        call: metricCall, scope: 'session', childSession: requestId, parentSession: ownerRunId,
        status: metricStatus, usage: metricUsage,
      });
    }
    if (previousBudget == null) delete process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS;
    else process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = previousBudget;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

