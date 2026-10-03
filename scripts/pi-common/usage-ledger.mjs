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
  return { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, responseMs: 0 };
}

function add(target, usage, responseMs) {
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.total += usage.totalTokens;
  target.responseMs += Number.isFinite(responseMs) ? responseMs : 0;
  target.responses += 1;
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
    add(row, usage, record.responseMs);
    add(totals, usage, record.responseMs);
  };
  const responseSums = new Map();
  for (const record of responses.values()) {
    include(record);
    const session = sessionOf(record);
    const usage = normalizeUsage(record.usage);
    if (session && usage) {
      const sum = responseSums.get(session) ?? emptyTotals();
      add(sum, usage, 0);
      responseSums.set(session, sum);
    }
  }
  // Roll-ups per child session: the session's own record and any delegate aggregate. Keep the
  // largest known one; it is a lower bound that must never be discarded for a smaller sum.
  const rollups = new Map();
  const offer = (session, call, usage) => {
    if (!session || !usage) return;
    if (!rollups.has(session) || usage.totalTokens > rollups.get(session).usage.totalTokens) rollups.set(session, { call, usage });
  };
  for (const record of aggregates.values()) {
    const session = sessionOf(record);
    if (session) offer(session, record.call, normalizeUsage(record.usage));
    else include(record);
  }
  for (const [session, record] of sessions) offer(session, record.call, normalizeUsage(record.usage));

  for (const [session, { call, usage }] of rollups) {
    const row = calls.get(call) ?? emptyTotals();
    calls.set(call, row);
    const sum = responseSums.get(session);
    if (!sum) {
      add(row, usage, 0);
      add(totals, usage, 0);
      continue;
    }
    if (usage.totalTokens === sum.total) continue;
    // Per-response records and the roll-up disagree: never double count, never drop known tokens.
    if (usage.totalTokens > sum.total) {
      const delta = {
        input: Math.max(0, (usage.input ?? 0) - sum.input), output: Math.max(0, (usage.output ?? 0) - sum.output),
        cacheRead: Math.max(0, (usage.cacheRead ?? 0) - sum.cacheRead), cacheWrite: Math.max(0, (usage.cacheWrite ?? 0) - sum.cacheWrite),
        totalTokens: usage.totalTokens - sum.total,
      };
      for (const target of [row, totals]) {
        target.input += delta.input; target.output += delta.output;
        target.cacheRead += delta.cacheRead; target.cacheWrite += delta.cacheWrite;
        target.total += delta.totalTokens;
      }
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
