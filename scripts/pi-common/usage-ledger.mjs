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
  const answeredSessions = new Set([...responses.values()].map(sessionOf).filter(Boolean));

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
  for (const record of responses.values()) include(record);
  for (const record of aggregates.values()) {
    const session = sessionOf(record);
    if (session && answeredSessions.has(session)) continue;
    include(record);
  }
  for (const [session, record] of sessions) {
    const status = String(record.status ?? "");
    if (!calls.has(record.call)) calls.set(record.call, emptyTotals());
    const sessionUsage = normalizeUsage(record.usage);
    const answered = answeredSessions.has(session)
      || [...aggregates.values()].some((aggregate) => sessionOf(aggregate) === session && normalizeUsage(aggregate.usage));
    // The session's own roll-up is the fallback when no per-response records exist for it.
    if (!answered && sessionUsage) {
      add(calls.get(record.call), sessionUsage, record.responseMs);
      add(totals, sessionUsage, record.responseMs);
    }
    if (INCOMPLETE_STATUSES.has(status)) {
      unknown.push({ call: record.call, childSession: session, response: null, reason: `${status}_request_usage_unavailable` });
    } else if (!answered && !sessionUsage && !record.usageKnownEmpty) {
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
