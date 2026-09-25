#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

function finalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  const message = [...messages].reverse().find((candidate) => candidate?.role === "assistant");
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function validateReviewResult(result) {
  if (!["PASS", "CHANGES_REQUESTED"].includes(result?.verdict) || typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("invalid review result");
  }
  return result;
}

export function parseReviewResult(jsonl) {
  let finalText = "";
  let toolResult = null;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "entry_appended" && event.entry?.type === "custom" &&
        event.entry?.customType === "review-result") {
      toolResult = event.entry.data;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      finalText = finalAssistantText([event.message]).trim();
    }
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      const assistant = [...event.messages].reverse().find((message) => message?.role === "assistant");
      if (assistant) finalText = finalAssistantText([assistant]).trim();
    }
  }

  // Prefer the structured result from the submit_result tool
  // (pi-reviewer-result-tool.mjs). The REVIEW_RESULT text line is kept only
  // as a fallback while that tool is still a prototype. The posted PR comment
  // still needs a leading REVIEW_RESULT line: pi-pr-fix.yml finds the most
  // recent "changes requested" review by scanning past comment bodies for
  // that exact marker, so it is reconstructed deterministically here rather
  // than asked of the model.
  if (toolResult) {
    const validated = validateReviewResult(toolResult);
    return { verdict: validated.verdict, text: `REVIEW_RESULT: ${validated.verdict}\n\n${validated.text}` };
  }

  if (!finalText) throw new Error("Pi review did not produce a final assistant response");
  // A completed review can include its verdict after the evidence or as a
  // Markdown heading. Only read the last assistant message. The model can
  // restate the same verdict more than once (e.g. a draft then a final
  // line); that is fine as long as every line agrees. Genuinely conflicting
  // verdicts (PASS and CHANGES_REQUESTED both present) stay rejected.
  const verdicts = [...finalText.matchAll(/^[ \t]*(?:#{1,6}[ \t]+)?REVIEW_RESULT:[ \t]*(PASS|CHANGES_REQUESTED)[ \t]*$/gm)];
  const distinct = new Set(verdicts.map((verdict) => verdict[1]));
  if (distinct.size !== 1) throw new Error("Pi review final response must contain exactly one REVIEW_RESULT: PASS|CHANGES_REQUESTED line");
  return { verdict: verdicts.at(-1)[1], text: finalText };
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
    process.exit(error.message.includes("did not produce") ? 3 : 4);
  }
}
