#!/usr/bin/env node

import fs from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: pi-review-result.mjs <pi-json-log>");
  process.exit(2);
}

function finalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  const message = [...messages].reverse().find((candidate) => candidate?.role === "assistant");
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

let finalText = "";
for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.type === "agent_end") {
    const text = finalAssistantText(event.messages);
    if (text.trim()) finalText = text.trim();
  }
}

if (!finalText) {
  console.error("Pi review did not produce a final assistant response");
  process.exit(3);
}

const match = finalText.match(/^REVIEW_RESULT:\s*(PASS|CHANGES_REQUESTED)\s*$/im);
if (!match) {
  console.error("Pi review final response is missing REVIEW_RESULT: PASS|CHANGES_REQUESTED");
  process.exit(4);
}

process.stdout.write(JSON.stringify({
  verdict: match[1],
  text: finalText,
}));
