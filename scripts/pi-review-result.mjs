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

export function parseReviewResult(jsonl) {
  let finalText = "";
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      finalText = finalAssistantText([event.message]).trim();
    }
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      const assistant = [...event.messages].reverse().find((message) => message?.role === "assistant");
      if (assistant) finalText = finalAssistantText([assistant]).trim();
    }
  }

  if (!finalText) throw new Error("Pi review did not produce a final assistant response");
  // A completed review can include its verdict after the evidence or as a
  // Markdown heading. Only read the last assistant message and reject an
  // ambiguous response containing more than one verdict line.
  const verdicts = [...finalText.matchAll(/^[ \t]*(?:#{1,6}[ \t]+)?REVIEW_RESULT:[ \t]*(PASS|CHANGES_REQUESTED)[ \t]*$/gm)];
  if (verdicts.length !== 1) throw new Error("Pi review final response must contain exactly one REVIEW_RESULT: PASS|CHANGES_REQUESTED line");
  return { verdict: verdicts[0][1], text: finalText };
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
