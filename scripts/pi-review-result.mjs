#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { readPiJsonl } from "./pi-common/result-jsonl.mjs";


export function validateReviewResult(result) {
  if (!["PASS", "CHANGES_REQUESTED"].includes(result?.verdict) || typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("invalid review result");
  }
  return result;
}

export function parseReviewResult(jsonl) {
  const { customResult: toolResult } = readPiJsonl(jsonl, { customType: "review-result" });
  if (!toolResult) throw new Error("Pi review did not call submit_result");
  const validated = validateReviewResult(toolResult);
  return { verdict: validated.verdict, text: `REVIEW_RESULT: ${validated.verdict}\n\n${validated.text}` };
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
