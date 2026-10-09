#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readPiJsonl } from "./pi-common/result-jsonl.mjs";

const EVIDENCE_STATUSES = new Set(["ESTABLISHED", "ASSUMPTION"]);
const MAX_CRITERIA_EVIDENCE = 30;
const MAX_EVIDENCE_ITEMS = 4;
const MAX_CRITERION_CHARS = 500;
const MAX_EVIDENCE_CHARS = 1000;
const MAX_ASSUMPTION_CHARS = 1000;
const MAX_SUMMARY_CHARS = 12000;
const MAX_REVIEW_COMMENT_CHARS = 60000;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateCriterionEvidence(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`invalid review criterion evidence at index ${index}`);
  }
  const criterion = clean(item.criterion);
  const status = clean(item.status);
  const evidence = Array.isArray(item.evidence) ? item.evidence.map(clean) : [];
  const assumption = clean(item.assumption);

  if (
    !criterion ||
    criterion.length > MAX_CRITERION_CHARS ||
    !EVIDENCE_STATUSES.has(status) ||
    evidence.length === 0 ||
    evidence.length > MAX_EVIDENCE_ITEMS ||
    evidence.some(entry => !entry || entry.length > MAX_EVIDENCE_CHARS)
  ) {
    throw new Error(`invalid review criterion evidence at index ${index}`);
  }
  if (status === "ASSUMPTION" && (!assumption || assumption.length > MAX_ASSUMPTION_CHARS)) {
    throw new Error(`review criterion evidence at index ${index} requires a bounded explicit assumption`);
  }

  return {
    criterion,
    status,
    evidence,
    ...(status === "ASSUMPTION" ? { assumption } : {}),
  };
}

function renderReviewResult(result) {
  const lines = [
    `REVIEW_RESULT: ${result.verdict}`,
    "",
    result.text,
  ];
  if (result.criteria_evidence.length) {
    lines.push("", "Acceptance evidence:");
    for (const item of result.criteria_evidence) {
      lines.push(`- [${item.status}] ${item.criterion}: ${item.evidence.join("; ")}${item.assumption ? ` Assumption: ${item.assumption}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function validateReviewResult(result) {
  const text = clean(result?.text);
  if (!["PASS", "CHANGES_REQUESTED"].includes(result?.verdict) || !text || text.length > MAX_SUMMARY_CHARS) {
    throw new Error("invalid review result");
  }
  const rawEvidence = result.criteria_evidence ?? [];
  if (!Array.isArray(rawEvidence) || rawEvidence.length > MAX_CRITERIA_EVIDENCE) {
    throw new Error("invalid structured criteria_evidence");
  }
  if (result.verdict === "PASS" && rawEvidence.length === 0) {
    throw new Error("PASS review result requires structured criteria_evidence");
  }

  const validated = {
    verdict: result.verdict,
    text,
    criteria_evidence: rawEvidence.map(validateCriterionEvidence),
  };
  if (renderReviewResult(validated).length > MAX_REVIEW_COMMENT_CHARS) {
    throw new Error(`review result exceeds ${MAX_REVIEW_COMMENT_CHARS} rendered characters`);
  }
  return validated;
}

// Criteria are derived from the trusted PR preflight; model-supplied headings
// may identify a criterion but cannot silently shrink this required set.
export function reviewAcceptanceCriteria(body) {
  const lines = clean(body).split(/\r?\n/);
  const index = lines.findIndex(line => /^##\s+(?:Acceptance(?: criteria)?|Definition of done)\s*$/i.test(line));
  if (index < 0) return [];
  const out = [];
  for (const raw of lines.slice(index + 1)) {
    if (/^##\s+/.test(raw)) break;
    if (!raw.trim() || /^\s*<!--/.test(raw) || /^\s*#/.test(raw)) continue;
    const line = raw.trim().replace(/^[-*]\s+(?:\[[ xX]\]\s*)?/, '').replace(/^\d+[.)]\s*/, '');
    out.push(...line.split(/;\s+|(?<=[.!?])\s+(?=[A-Z])/).map(x => x.trim()).filter(x => x.length >= 8));
  }
  // Never truncate trusted requirements: an oversized list is a human gate,
  // not permission for a partial PASS.
  return out;
}

const proofLocation = /(?:[\w.-]+\/)+[\w.-]+(?::\d+)?|\x60[^\x60]{4,}\x60|\b(?:node --test|npm test|pytest|git diff|git ls-files)\b/i;
const genericEvidence = /transmission probe|criteria_evidence channel|^test[s]? pass(?:ed)?[.!]?$/i;
const significantWords = input => [...new Set((input.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])
  .filter(word => !['that','with','from','only','must','have','when','there','these','this','into','does','should','file','files','test','tests','code','change','changes','passing','review','using','against','such','after','before','were','been'].includes(word)))];

export function validateTextReview({ verdict, reviewText, acceptanceCriteria = [] }) {
  const text = clean(reviewText);
  if (!['PASS', 'CHANGES_REQUESTED'].includes(verdict) || !text || text.length > MAX_SUMMARY_CHARS) {
    throw new Error('review_text_invalid');
  }
  if (/transmission probe for criteria_evidence channel/i.test(text)) throw new Error('review_probe_only');
  if (verdict === 'CHANGES_REQUESTED') {
    const blocking = text.split(/^##\s+Blocking findings\s*$/mi)[1]?.split(/^##\s+/m)[0]?.trim() ?? '';
    if (blocking.length < 35 || !proofLocation.test(blocking) ||
        !/\b(?:because|fails?|breaks?|incorrect|missing|regression|risk|reject|cannot|error|mismatch)\b/i.test(blocking)) {
      throw new Error('review_blocker_not_actionable');
    }
    return { verdict, text, criteria_evidence: [] };
  }
  if (!Array.isArray(acceptanceCriteria) || !acceptanceCriteria.length || acceptanceCriteria.length > 30) {
    throw new Error('review_acceptance_criteria_unavailable');
  }
  const section = text.split(/^##\s+Acceptance evidence\s*$/mi)[1]?.split(/^##\s+/m)[0] ?? '';
  const blocks = [...section.matchAll(/^###\s+Criterion\s+(\d+):\s*(.+?)\s*$([\s\S]*?)(?=^###\s+Criterion\s+\d+:|(?![\s\S]))/gmi)];
  if (blocks.length !== acceptanceCriteria.length) throw new Error('review_criterion_coverage_incomplete');
  const seen = new Set();
  const criteria_evidence = blocks.map(match => {
    const index = Number(match[1]), criterion = acceptanceCriteria[index - 1];
    if (!criterion || seen.has(index)) throw new Error('review_criterion_index_invalid');
    seen.add(index);
    const required = significantWords(criterion), title = significantWords(match[2]);
    if (required.length && !required.some(word => title.includes(word))) throw new Error('review_criterion_mismatch');
    const status = match[3].match(/^Status:\s*(ESTABLISHED|ASSUMPTION)\s*$/mi)?.[1];
    const evidence = match[3].match(/^Evidence:\s*(.+)$/mi)?.[1]?.trim() ?? '';
    const assumption = match[3].match(/^Assumption:\s*(.+)$/mi)?.[1]?.trim() ?? '';
    if (!status || evidence.length < 25 || evidence.length > MAX_EVIDENCE_CHARS ||
        !proofLocation.test(evidence) || genericEvidence.test(evidence) ||
        (status === 'ASSUMPTION' && !assumption)) {
      throw new Error('review_criterion_evidence_insufficient');
    }
    return validateCriterionEvidence({ criterion, status, evidence: [evidence], ...(assumption ? { assumption } : {}) }, index - 1);
  });
  if (new Set(criteria_evidence.map(item => item.criterion)).size !== acceptanceCriteria.length) throw new Error('review_duplicate_criteria');
  return { verdict, text, criteria_evidence };
}

export const REVIEW_RECEIPT_KIND = 'pi_reviewer_terminal_receipt';
export function reviewResultDigest(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export function createReviewReceipt(data, identity) {
  return { kind: REVIEW_RECEIPT_KIND, schema_version: 1, status: 'success',
    identity, result_sha256: reviewResultDigest(data) };
}
export function assertReviewReceipt(data, env = process.env) {
  const marker = clean(env.PI_TERMINAL_RESULT_FILE);
  if (!marker || !fs.existsSync(marker)) throw new Error('review_terminal_receipt_missing');
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(marker, 'utf8')); }
  catch { throw new Error('review_terminal_receipt_invalid'); }
  if (receipt?.kind !== REVIEW_RECEIPT_KIND || receipt.schema_version !== 1 ||
      receipt.status !== 'success' || receipt.result_sha256 !== reviewResultDigest(data)) {
    throw new Error('review_terminal_receipt_invalid');
  }
  const id = receipt.identity ?? {};
  if (!id.session || !id.head || !id.run || !id.attempt || !id.issue || !id.pr ||
      id.run !== clean(env.GITHUB_RUN_ID) ||
      id.attempt !== clean(env.REVIEW_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT) ||
      id.issue !== clean(env.ISSUE) || id.pr !== clean(env.PR) ||
      id.head !== clean(env.HEAD_SHA)) {
    throw new Error('review_terminal_receipt_foreign_identity');
  }
  let context;
  try { context = JSON.parse(fs.readFileSync(clean(env.REVIEW_CONTEXT), 'utf8')); }
  catch { throw new Error('review_context_invalid'); }
  if (String(context.head) !== id.head || String(context.pr) !== id.pr ||
      String(context.issue) !== id.issue) throw new Error('review_terminal_receipt_stale_head');
  const checked = validateTextReview({ verdict: data.verdict, reviewText: data.text,
    acceptanceCriteria: reviewAcceptanceCriteria(context.review?.issue?.body) });
  if (JSON.stringify(checked) !== JSON.stringify(data)) throw new Error('review_terminal_receipt_evidence_mismatch');
  return receipt;
}

export function parseReviewResult(jsonl, env = process.env) {
  const { customResult: toolResult } = readPiJsonl(jsonl, { customType: "review-result" });
  if (!toolResult) throw new Error("Pi review did not call submit_result");
  const validated = validateReviewResult(toolResult);
  if (env.PI_STAGE === 'reviewer') assertReviewReceipt(validated, env);
  return {
    verdict: validated.verdict,
    text: renderReviewResult(validated),
    criteria_evidence: validated.criteria_evidence,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: pi-review-result.mjs <pi-json-log>");
    process.exit(2);
  }
  try {
    // This CLI is the production Reviewer publication boundary. Never rely on
    // PI_STAGE being inherited from a previous shell step to enforce the receipt.
    process.stdout.write(JSON.stringify(parseReviewResult(
      fs.readFileSync(path, "utf8"), { ...process.env, PI_STAGE: "reviewer" },
    )));
  } catch (error) {
    console.error(error.message);
    process.exit(error.message.includes("submit_result") ? 3 : 4);
  }
}
