// Shared usage accounting for the job summary and the repository usage CSV.
//
// Records are PI_METRIC lines. Per-response records carry `call` (+ optional
// `childSession` for descendant sessions) and a response number that is only
// unique inside that session. `aggregate: true` records are a delegate's own
// roll-up of responses that may also be present individually. A record whose
// usage is unavailable is an *unknown*, never zero: it makes the ledger
// incomplete and the totals a known lower bound.

const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
const INCOMPLETE_STATUSES = new Set(["cancelled", "timed_out"]);

export function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const keys = [...USAGE_KEYS, "totalTokens"];
  if (!keys.some((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  const usage = Object.fromEntries(keys.filter((key) => Number.isSafeInteger(value[key]) && value[key] >= 0).map((key) => [key, value[key]]));
  if (!Number.isSafeInteger(usage.totalTokens)) {
    usage.totalTokens = USAGE_KEYS.reduce((sum, key) => sum + (usage[key] ?? 0), 0);
  }
  if (Number.isSafeInteger(value.turns) && value.turns >= 0) usage.turns = value.turns;
  if (Number.isFinite(value.durationMs) && value.durationMs >= 0) usage.durationMs = value.durationMs;
  return usage;
}

function sessionOf(record) {
  return record.childSession == null ? null : String(record.childSession);
}

function responseKey(record) {
  const session = sessionOf(record);
  return `${record.call}:${session ?? ""}:${record.response}`;
}

export function emptyTotals() {
  return {
    responses: 0,
    providerResponses: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    responseMs: 0,
    providerResponseMs: 0,
    delegatedLifecycleMs: 0,
  };
}

function providerTurns(usage) {
  return Number.isSafeInteger(usage?.turns) && usage.turns >= 0 ? usage.turns : 1;
}

function delegatedLifecycleDurationMs(usage) {
  return Number.isFinite(usage?.durationMs) && usage.durationMs >= 0 ? usage.durationMs : 0;
}

function rollupLifecycleDurationMs(usage, responseMs = 0) {
  const explicit = Number(responseMs);
  const aggregateElapsed = Number.isFinite(explicit) && explicit >= 0 ? explicit : 0;
  // Aggregate/session responseMs is lifecycle/tool elapsed time, not provider-only response time.
  // Keep the best known lifecycle duration without adding overlapping measurements together.
  return Math.max(delegatedLifecycleDurationMs(usage), aggregateElapsed);
}

function add(target, usage, responseMs, {
  providerResponses = 1,
  providerResponseMs = responseMs,
  delegatedLifecycleMs = 0,
} = {}) {
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.total += usage.totalTokens;
  target.responseMs += Number.isFinite(responseMs) ? responseMs : 0;
  target.responses += 1;
  target.providerResponses += Number.isSafeInteger(providerResponses) && providerResponses >= 0 ? providerResponses : 1;
  target.providerResponseMs += Number.isFinite(providerResponseMs) && providerResponseMs >= 0 ? providerResponseMs : 0;
  target.delegatedLifecycleMs += Number.isFinite(delegatedLifecycleMs) && delegatedLifecycleMs >= 0 ? delegatedLifecycleMs : 0;
}

function supplementProviderRollup(target, sum, usage, responseMs = 0) {
  const turns = Math.max(sum.providerResponses, providerTurns(usage));
  target.providerResponses += turns - sum.providerResponses;
  // Delegated roll-up timing may arrive either as usage.durationMs or as the aggregate tool's
  // responseMs. Both are lifecycle measurements, never provider-only response time.
  target.delegatedLifecycleMs += rollupLifecycleDurationMs(usage, responseMs);
}

/**
 * Attribute every record exactly once.
 *
 * - Duplicate (replayed) per-response records collapse by call + session + response.
 * - An aggregate record is dropped when per-response records exist for the same
 *   child session, so a successful delegate is not counted twice.
 * - Unknown usage is listed with its call/session/response and flips `complete`.
 */
export function summarizeUsage(records) {
  const responses = new Map();
  const aggregates = new Map();
  const sessions = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object" || typeof record.call !== "string") continue;
    const session = sessionOf(record);
    if (record.scope === "session" && session) {
      sessions.set(session, record);
      continue;
    }
    if (record.aggregate) {
      aggregates.set(`${record.call}:${session ?? record.response}`, record);
      continue;
    }
    responses.set(responseKey(record), record);
  }
  const calls = new Map();
  const totals = emptyTotals();
  const unknown = [];
  const include = (record) => {
    const row = calls.get(record.call) ?? emptyTotals();
    calls.set(record.call, row);
    const usage = normalizeUsage(record.usage);
    if (!usage) {
      unknown.push({ call: record.call, childSession: sessionOf(record), response: record.response ?? null, reason: record.reason ?? "usage_unavailable" });
      return;
    }
    const rollup = Boolean(record.aggregate || record.scope === "session");
    const responseMs = Number(record.responseMs) || 0;
    const provider = {
      providerResponses: rollup ? providerTurns(usage) : 1,
      providerResponseMs: rollup ? 0 : responseMs,
      delegatedLifecycleMs: rollup ? rollupLifecycleDurationMs(usage, responseMs) : 0,
    };
    // Preserve generic elapsed timing for standalone aggregates, but never relabel that lifecycle
    // measurement as provider response time.
    add(row, usage, responseMs, provider);
    add(totals, usage, responseMs, provider);
  };
  const responseSums = new Map();
  for (const record of responses.values()) {
    include(record);
    const session = sessionOf(record);
    const usage = normalizeUsage(record.usage);
    if (session && usage) {
      const sum = responseSums.get(session) ?? emptyTotals();
      add(sum, usage, 0, {
        providerResponses: 1,
        providerResponseMs: Number(record.responseMs) || 0,
      });
      responseSums.set(session, sum);
    }
  }
  // Roll-ups per child session: the session's own record and any delegate aggregate. Keep the
  // largest known one; it is a lower bound that must never be discarded for a smaller sum.
  const rollups = new Map();
  const offer = (session, call, usage, responseMs = 0) => {
    if (!session || !usage) return;
    const existing = rollups.get(session);
    if (!existing || usage.totalTokens > existing.usage.totalTokens ||
        (usage.totalTokens === existing.usage.totalTokens && delegatedLifecycleDurationMs(usage) > delegatedLifecycleDurationMs(existing.usage))) {
      rollups.set(session, { call, usage, responseMs });
    }
  };
  for (const record of aggregates.values()) {
    const session = sessionOf(record);
    if (session) offer(session, record.call, normalizeUsage(record.usage), record.responseMs);
    else include(record);
  }
  for (const [session, record] of sessions) offer(session, record.call, normalizeUsage(record.usage), record.responseMs);

  for (const [session, { call, usage, responseMs }] of rollups) {
    const row = calls.get(call) ?? emptyTotals();
    calls.set(call, row);
    const sum = responseSums.get(session);
    if (!sum) {
      const provider = {
        providerResponses: providerTurns(usage),
        providerResponseMs: 0,
        delegatedLifecycleMs: rollupLifecycleDurationMs(usage, responseMs),
      };
      add(row, usage, Number(responseMs) || 0, provider);
      add(totals, usage, Number(responseMs) || 0, provider);
      continue;
    }
    const sameVector = USAGE_KEYS.every((key) => (usage[key] ?? 0) === sum[key]) && usage.totalTokens === sum.total;
    supplementProviderRollup(row, sum, usage, responseMs);
    supplementProviderRollup(totals, sum, usage, responseMs);
    if (sameVector) continue;
    // Per-response records and the roll-up disagree somewhere in the vector: never double count and
    // never drop known tokens. Take the known lower bound per component; the total can be no
    // smaller than either source's total or the reconciled components themselves.
    const reconciled = Object.fromEntries(USAGE_KEYS.map((key) => [key, Math.max(sum[key], usage[key] ?? 0)]));
    const reconciledTotal = Math.max(sum.total, usage.totalTokens, USAGE_KEYS.reduce((acc, key) => acc + reconciled[key], 0));
    for (const target of [row, totals]) {
      for (const key of USAGE_KEYS) target[key] += reconciled[key] - sum[key];
      target.total += reconciledTotal - sum.total;
    }
    unknown.push({ call, childSession: session, response: null, reason: "session_response_usage_mismatch" });
  }
  for (const [session, record] of sessions) {
    const status = String(record.status ?? "");
    if (!calls.has(record.call)) calls.set(record.call, emptyTotals());
    if (INCOMPLETE_STATUSES.has(status)) {
      unknown.push({ call: record.call, childSession: session, response: null, reason: `${status}_request_usage_unavailable` });
    } else if (!responseSums.has(session) && !rollups.has(session) && !record.usageKnownEmpty) {
      unknown.push({ call: record.call, childSession: session, response: null, reason: "session_usage_unavailable" });
    }
  }
  return { calls, totals, unknown, complete: unknown.length === 0 };
}

export function completenessNote({ complete, unknown }) {
  if (complete) return "Complete: every recorded response reported usage.";
  const ids = unknown.map((entry) => `${entry.call}${entry.childSession ? `/${entry.childSession}` : ""}${entry.response != null ? `#${entry.response}` : ""} (${entry.reason})`);
  return `INCOMPLETE: usage unavailable for ${unknown.length} request(s)/session(s): ${ids.join(", ")}. Totals are a known lower bound, not a complete total.`;
}
