#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { readPiJsonl } from "./pi-common/result-jsonl.mjs";

const EVIDENCE_STATUSES = new Set(["ESTABLISHED", "ASSUMPTION"]);

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

  if (!criterion || !EVIDENCE_STATUSES.has(status) || !evidence.length || evidence.some(entry => !entry)) {
    throw new Error(`invalid review criterion evidence at index ${index}`);
  }
  if (status === "ASSUMPTION" && !assumption) {
    throw new Error(`review criterion evidence at index ${index} requires an explicit assumption`);
  }
  if (status === "ESTABLISHED" && assumption) {
    throw new Error(`established review criterion evidence at index ${index} cannot carry an assumption`);
  }

  return {
    criterion,
    status,
    evidence,
    ...(assumption ? { assumption } : {}),
  };
}

export function validateReviewResult(result) {
  if (!["PASS", "CHANGES_REQUESTED"].includes(result?.verdict) || typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("invalid review result");
  }
  if (!Array.isArray(result.criteria_evidence) || result.criteria_evidence.length === 0) {
    throw new Error("review result requires structured criteria_evidence");
  }
  return {
    verdict: result.verdict,
    text: result.text.trim(),
    criteria_evidence: result.criteria_evidence.map(validateCriterionEvidence),
  };
}

function renderReviewResult(result) {
  const lines = [
    `REVIEW_RESULT: ${result.verdict}`,
    "",
    result.text,
    "",
    "Acceptance evidence:",
  ];
  for (const item of result.criteria_evidence) {
    lines.push(`- [${item.status}] ${item.criterion}: ${item.evidence.join("; ")}${item.assumption ? ` Assumption: ${item.assumption}` : ""}`);
  }
  return lines.join("\n");
}

export function parseReviewResult(jsonl) {
  const { customResult: toolResult } = readPiJsonl(jsonl, { customType: "review-result" });
  if (!toolResult) throw new Error("Pi review did not call submit_result");
  const validated = validateReviewResult(toolResult);
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
    process.stdout.write(JSON.stringify(parseReviewResult(fs.readFileSync(path, "utf8"))));
  } catch (error) {
    console.error(error.message);
    process.exit(error.message.includes("submit_result") ? 3 : 4);
  }
}
