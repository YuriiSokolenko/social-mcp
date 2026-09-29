# LLM Agent Looping & Verbosity — 100 Cases

Collected for later analysis of model verbosity, repetitive reasoning, repeated tool calls, failure-to-stop, context-loss and runtime loop behavior.

> Note: this is a working research corpus. Links point to the original issue/discussion/repository where the behavior or mitigation was reported.

## 1. Pi #6158

Repeated `ls`/inspection calls with unchanged results; proposal: repeat-call/output detector, limits, pause.

Source: https://github.com/earendil-works/pi/issues/6158

## 2. Claude Code #59318

Repeated `grep` 30–50+ times after enough evidence; suggested detecting identical calls and ending exploration.

Source: https://github.com/anthropics/claude-code/issues/59318

## 3. Claude Code #19699

Same failing `make` command repeated; avoid retrying identical action after identical error.

Source: https://github.com/anthropics/claude-code/issues/19699

## 4. Hermes #99743

Production loops with dozens of identical `comm`/`grep`; SHA fingerprint and block on repeated call.

Source: https://github.com/NousResearch/hermes-agent/issues/99743

## 5. Hermes #89069

Successful tool call re-executed 3–20+ times; stall guard on `(tool,args,result)`.

Source: https://github.com/NousResearch/hermes-agent/issues/89069

## 6. Hermes #37255

Reasoning says stop while action keeps calling tools, 100+ calls; hard iteration guard / avoid redundant verification.

Source: https://github.com/NousResearch/hermes-agent/issues/37255

## 7. Hermes #18076

Many similar `git log` calls return same results; dedupe successful calls across turns.

Source: https://github.com/NousResearch/hermes-agent/issues/18076

## 8. IronClaw #2240

Same failing tool may repeat until `max_iterations`; duplicate detection before execution.

Source: https://github.com/nearai/ironclaw/issues/2240

## 9. Agent Zero #1690

Model ignored prompt warnings about repetition; hard stop needed, user also reported temperature change helping.

Source: https://github.com/agent0ai/agent-zero/issues/1690

## 10. OpenHands #8269

Browser agent repeats actions in long sessions; runtime loop detection requested.

Source: https://github.com/OpenHands/OpenHands/issues/8269

## 11. OpenHands Cloud #198

Agent keeps testing after successful verification; missing explicit testing-complete condition.

Source: https://github.com/OpenHands/OpenHands-Cloud/issues/198

## 12. CrewAI #6414

Delegation ping-pong / repeated tool calls; deterministic guardrail instead of relying on model self-stop.

Source: https://github.com/crewAIInc/crewAI/issues/6414

## 13. OpenHands #15087

Prompt-based “you are looping” costs more turns; trajectory hashing proposed instead.

Source: https://github.com/OpenHands/OpenHands/issues/15087

## 14. OpenHands SDK #4331

Same bad tool call repeated with same error; nudge after N failures then terminal STUCK.

Source: https://github.com/OpenHands/software-agent-sdk/issues/4331

## 15. OpenHands SDK #762

Hardcoded stuck thresholds caused false positives; thresholds should be configurable.

Source: https://github.com/OpenHands/software-agent-sdk/issues/762

## 16. OpenHands #5355

Legitimate polling misdetected as loop; distinguish static no-progress from externally changing state.

Source: https://github.com/OpenHands/OpenHands/issues/5355

## 17. OpenHands Goal #4380

Stuck detector can kill valid goal loops; completion/progress judge should outrank simple repeat count.

Source: https://github.com/OpenHands/software-agent-sdk/issues/4380

## 18. Cline #5625

Gemini repeats a long plan instead of acting; model-level repetition around tool execution.

Source: https://github.com/cline/cline/issues/5625

## 19. Cline #7585

Tool/checkpoint spam can hang VS Code; bound repeated execution cycles.

Source: https://github.com/cline/cline/issues/7585

## 20. Cline #11542

Hundreds of provider requests before timeout; need bounded completion/tool cycle.

Source: https://github.com/cline/cline/issues/11542

## 21. Cline #9846

Framework requires a tool while model keeps returning text; protocol mismatch creates retry loop.

Source: https://github.com/cline/cline/issues/9846

## 22. Cline #9920

Tool XML truncated by max output, framework says no tool used, retry truncates again; distinguish truncation from no-call.

Source: https://github.com/cline/cline/issues/9920

## 23. Cline #9684

Framework-only `task_progress` leaks into MCP args and repeatedly fails schema validation.

Source: https://github.com/cline/cline/issues/9684

## 24. Cline #9848

Raw tool XML printed as text instead of executed; parser/protocol fix required.

Source: https://github.com/cline/cline/issues/9848

## 25. Cline #11328

Repeated malformed reasoning instead of valid action; compatibility/format guard needed.

Source: https://github.com/cline/cline/issues/11328

## 26. Gemini CLI #6897

Nonexistent MCP tool repeatedly called with name variants; errors should expose valid alternatives.

Source: https://github.com/google-gemini/gemini-cli/issues/6897

## 27. Gemini CLI #5273

Editing failure leads to repeated attempts along same path; detect semantically similar retries.

Source: https://github.com/google-gemini/gemini-cli/issues/5273

## 28. Gemini CLI discussion #23240

Custom agent calls same API tool 10–15 times; community guidance: max turns + per-tool counter + prompt only as extra layer.

Source: https://github.com/google-gemini/gemini-cli/discussions/23240

## 29. Codex CLI #27759

Provider repeats identical tool-call and Codex keeps executing it; dedupe/bound client-side calls.

Source: https://github.com/openai/codex/issues/27759

## 30. Codex Desktop #42444

Connection/status MCP action repeats many times; timeout/error should become terminal or recoverable state.

Source: https://github.com/openai/codex/issues/42444

## 31. Mastra #14720

Gemini Flash repeats one tool with same args until maxStep; circuit breaker around duplicate calls.

Source: https://github.com/mastra-ai/mastra/issues/14720

## 32. Mastra #6827

Intermittent duplicate mutating calls; maxSteps limits damage but dedupe is needed before side effects.

Source: https://github.com/mastra-ai/mastra/issues/6827

## 33. Mastra #5782

Tool-call state not persisted so next turn repeats action; persist tool state immediately.

Source: https://github.com/mastra-ai/mastra/issues/5782

## 34. Mastra #13190

Tool result lost / empty to model, causing repeat; preserve call-result pairing.

Source: https://github.com/mastra-ai/mastra/issues/13190

## 35. Mastra #24110

Token limiter removes current tool result; never trim current action/result pair, fail loudly instead.

Source: https://github.com/mastra-ai/mastra/issues/24110

## 36. PydanticAI #5178

Validation error hides bad input so model resends invalid `{}`; return original bad input for correction.

Source: https://github.com/pydantic/pydantic-ai/issues/5178

## 37. PydanticAI #2311

Retry counter semantics break under parallel tools; track retry limits correctly per call.

Source: https://github.com/pydantic/pydantic-ai/issues/2311

## 38. LangChain #20693

Chain finished but `AgentExecutor` invokes same tool again; terminal state must stop executor.

Source: https://github.com/langchain-ai/langchain/issues/20693

## 39. LangChain #26019

Agent repeatedly asks flight-status tool; explicit routing/termination after sufficient observation.

Source: https://github.com/langchain-ai/langchain/issues/26019

## 40. LangGraph #6731

SQL agent keeps querying until recursion limit; recursion limit is only a safety net, not a stop condition.

Source: https://github.com/langchain-ai/langgraph/issues/6731

## 41. Continue #6506

Two tool calls merged incorrectly; proper sequential execution/serialization needed.

Source: https://github.com/continuedev/continue/issues/6506

## 42. Continue #6509

MCP calls leave infinite progress state; lifecycle must close pending action.

Source: https://github.com/continuedev/continue/issues/6509

## 43. Roo Code #10322

Final text exists but framework still requires `attempt_completion`; final-answer state should be terminal.

Source: https://github.com/RooCodeInc/Roo-Code/issues/10322

## 44. Roo Code #11337

Agent finishes task and then loops; explicit post-completion stop required.

Source: https://github.com/RooCodeInc/Roo-Code/issues/11337

## 45. Google ADK #4868

Structured argument turns into `{}` and tool repeats; fix schema serialization.

Source: https://github.com/google/adk-python/issues/4868

## 46. Google ADK #3413

`output_schema + tools` causes tool calls instead of final structured output; separate tool and final-output phases.

Source: https://github.com/google/adk-python/issues/3413

## 47. Google ADK #5463

Internal response tool conflicts with real tools; provider-independent structured-output termination needed.

Source: https://github.com/google/adk-python/issues/5463

## 48. Google ADK #4179

`FunctionCallingConfig(mode=ANY)` forces tools after result; distinguish “at least once” from “every turn”.

Source: https://github.com/google/adk-python/issues/4179

## 49. Google ADK #5684

`SCRIPT_NOT_FOUND` treated as normal observation causes hundreds of LLM calls; classify non-retryable errors.

Source: https://github.com/google/adk-python/issues/5684

## 50. Google ADK #5652

Model keeps inventing new nonexistent resource paths; count failures at tool/category level, not exact args only.

Source: https://github.com/google/adk-python/issues/5652

## 51. Google ADK #6281

Unavailable tool remains in model path; do not expose impossible tools.

Source: https://github.com/google/adk-python/issues/6281

## 52. Google ADK #1944

OAuth token lost between calls so every call reauthenticates; persist session/tool state.

Source: https://github.com/google/adk-python/issues/1944

## 53. Google ADK #137

Web-search agent lacks a sufficient-search stop; use search budget + synthesis phase.

Source: https://github.com/google/adk-python/issues/137

## 54. Dify #23187

Runtime injects “continue” after correct subagent result; observation should close the user turn.

Source: https://github.com/langgenius/dify/issues/23187

## 55. Dify official plugins #2735

Plugin regression causes repeated tool calls to max iterations; protocol/runtime fix rather than prompt.

Source: https://github.com/langgenius/dify-official-plugins/issues/2735

## 56. Codex #16556

Code review has enough evidence but rereads same files; stop exploration and move to synthesis.

Source: https://github.com/openai/codex/issues/16556

## 57. Gemini CLI #14887

Build already succeeded but agent continued; potential-loop detector stops request.

Source: https://github.com/google-gemini/gemini-cli/issues/14887

## 58. OpenClaw #9912

Tool succeeds instantly, model thinks for minutes, then repeats; separate maxTurns/maxToolCalls.

Source: https://github.com/openclaw/openclaw/issues/9912

## 59. AutoGen #133

Text `TERMINATE` is unreliable; deterministic terminate function proposed.

Source: https://github.com/microsoft/autogen/issues/133

## 60. AutoGen discussion #5869 / issue #5831

Swarm handoff loops when handoff target/state is wrong; termination conditions and disabling parallel handoff calls.

Source: https://github.com/microsoft/autogen/discussions/5869

## 61. AutoGen #6268

Functional tool loop still needs bounded iterations; configurable max iteration count.

Source: https://github.com/microsoft/autogen/issues/6268

## 62. AutoGen discussion #8135

Step counters too coarse; canonical `(tool,args)` hash, sliding window, circuit-breaker observation, idempotency keys.

Source: https://github.com/microsoft/autogen/discussions/8135

## 63. AutoGen discussion #7814

Agents repeat conversational cycle; fingerprint payload and sequence patterns.

Source: https://github.com/microsoft/autogen/discussions/7814

## 64. ZeroClaw #6036

Tool action lacks terminal result and repeats; bound executions and return clear failure.

Source: https://github.com/zeroclaw-labs/zeroclaw/issues/6036

## 65. Hermes #481

`max_iterations` alone misses behavioral loops; pattern detection + escalation.

Source: https://github.com/NousResearch/hermes-agent/issues/481

## 66. OpenClaw #67399

Hallucinated unavailable tool repeats; circuit breaker after repeated failures.

Source: https://github.com/openclaw/openclaw/issues/67399

## 67. arxiv-research-agent #3

HTTP 429 retried repeatedly causing huge context growth; backoff / terminal rate-limit handling.

Source: https://github.com/ashishpagote/arxiv-research-agent/issues/3

## 68. smolagents #2458

`max_steps=0` ignored due to truthiness bug; explicit `is not None` check.

Source: https://github.com/huggingface/smolagents/issues/2458

## 69. smolagents #2566

Full history replay makes long loops O(n²) in input cost; compaction + low step ceiling.

Source: https://github.com/huggingface/smolagents/issues/2566

## 70. agent-loop project

Reference implementation for AAAAA / ABABAB detection with max iterations.

Source: https://github.com/AlessandroAnnini/agent-loop

## 71. Codex #31351

`plan → compaction → same plan` repeatedly; persist execution checkpoint, not just goal.

Source: https://github.com/openai/codex/issues/31351

## 72. Codex #28925

After compaction model restarts from “read files”; preserve progress across compaction.

Source: https://github.com/openai/codex/issues/28925

## 73. Codex #29354

Hours of repeated pre-write analysis; preserve phase/checkpoint across compaction.

Source: https://github.com/openai/codex/issues/29354

## 74. Codex #35935

Near-complete task regresses after compaction; checkpoint completed work + next action.

Source: https://github.com/openai/codex/issues/35935

## 75. Codex #35226

Large context and repeated rereads after compaction; detect loops using reads/plans plus working-tree progress.

Source: https://github.com/openai/codex/issues/35226

## 76. Codex #35032

Post-compaction context remains too full, triggering another compaction; guarantee headroom.

Source: https://github.com/openai/codex/issues/35032

## 77. Codex #35669

Many compactions lose active action; if state cannot be restored, fail visibly instead of continuing.

Source: https://github.com/openai/codex/issues/35669

## 78. Hermes #11475

Compression resurrects stale active task; checkpoint the current task explicitly.

Source: https://github.com/NousResearch/hermes-agent/issues/11475

## 79. n8n #37779

Generic retry after maxIterations resets history and starts over; preserve agent trace and do not reset run.

Source: https://github.com/n8n-io/n8n/issues/37779

## 80. vLLM #54337

`content=null` serialized as literal `None`, degrading repeated tool turns; fix chat template serialization.

Source: https://github.com/vllm-project/vllm/issues/54337

## 81. Mastra #8830

Assistant message duplicated after client tool calls; correct merge/dedup.

Source: https://github.com/mastra-ai/mastra/issues/8830

## 82. Codex #38333

Static developer instruction becomes repetition attractor; avoid reinjecting/echoing unchanged high-priority context.

Source: https://github.com/openai/codex/issues/38333

## 83. OpenClaw #73781

Runtime replays old tool call even when model did not request it; fix state machine rather than prompt.

Source: https://github.com/openclaw/openclaw/issues/73781

## 84. Microsoft Agent Framework #5394

Completed background response polled repeatedly, causing many duplicate calls; make state transition idempotent.

Source: https://github.com/microsoft/agent-framework/issues/5394

## 85. Semantic Kernel #12943

Pagination returns same page while `has_more=true`; use no-progress pagination guard.

Source: https://github.com/microsoft/semantic-kernel/issues/12943

## 86. Google ADK #5947

Streaming progress `yield` interrupts model and retriggers tool; progress events must not count as completion/new turn.

Source: https://github.com/google/adk-python/issues/5947

## 87. Google ADK #3974

Progressive SSE creates many parallel duplicate tools; dedupe partial tool events / disable broken streaming path.

Source: https://github.com/google/adk-python/issues/3974

## 88. Google ADK #6566

Streaming + transfer causes tool repeats with varying args; fix aggregation and transfer lifecycle.

Source: https://github.com/google/adk-python/issues/6566

## 89. Codex #36814

Subagent event desync causes repeated inspection; preserve subagent/event identity and dedupe.

Source: https://github.com/openai/codex/issues/36814

## 90. Codex #33999

`wait(noop)` repeats with no active exec; invalid wait target should be terminal/recoverable error.

Source: https://github.com/openai/codex/issues/33999

## 91. AutoGen #5317

Adding a second agent breaks state isolation and loops; isolate state per agent/runtime.

Source: https://github.com/microsoft/autogen/issues/5317

## 92. Langflow #13636

Type mismatch causes repeated unsuccessful build until recursion limit; validate types before invoking agent/build.

Source: https://github.com/langflow-ai/langflow/issues/13636

## 93. Langflow #14182

Tool error loses call ID and prevents correction; preserve/null-safe ToolMessage identity.

Source: https://github.com/langflow-ai/langflow/issues/14182

## 94. Microsoft Agent Framework #6788

One call ID reused for multiple identical tools; unique identity per invocation.

Source: https://github.com/microsoft/agent-framework/issues/6788

## 95. Microsoft Agent Framework #2329

`max_iterations` counts model rounds but one round can launch many tools; count actual executions separately.

Source: https://github.com/microsoft/agent-framework/issues/2329

## 96. Codex #27757

Stale result for a tool call ID is resent; dedupe stale tool result by call ID.

Source: https://github.com/openai/codex/issues/27757

## 97. Codex #39774

Malformed tool call rejected, model regenerates same shape indefinitely; parser error needs bounded recovery.

Source: https://github.com/openai/codex/issues/39774

## 98. Mastra #9704

Parallel tools + human-in-loop suspend create race/resume problems; sequentialize approval/suspend path.

Source: https://github.com/mastra-ai/mastra/issues/9704

## 99. Hermes #93464

`skill_manage create` repeatedly omits required `content`; pre-tool schema validation with concrete repair hint.

Source: https://github.com/NousResearch/hermes-agent/issues/93464

## 100. Hermes tool guardrails

Current guardrails cover exact failures, same-tool failures, identical-result/no-progress, ABAB cycles, per-turn caps and hard stops.

Source: https://github.com/NousResearch/hermes-agent/blob/main/agent/tool_guardrails.py

---

## Preliminary recurring mitigation patterns

- Exact duplicate-call fingerprinting: `(tool, normalized args)`.
- No-progress fingerprinting: `(tool, normalized args, normalized result)`.
- Sequence-cycle detection: `AAA`, `ABAB`, `ABCABC`.
- Separate counters for LLM turns and actual tool executions.
- Terminal classification for non-retryable failures.
- Explicit completion states after tests/build/review succeed.
- Search/exploration phases should have a deterministic transition to action rather than relying only on a large `max_iterations` counter.
- Preserve tool-call/result identity and execution checkpoints across retries/compaction.
- Never silently trim the current tool-call/result pair from context.
- Circuit breaker should be runtime-enforced; prompt reminders are a secondary layer only.

### Local application in Social MCP

The 2026-09-29 Implementer #4 and Dispatcher reproductions showed a semantic no-progress loop that exact-call and turn-count guards did not capture. Social MCP therefore implemented a transition-based guard:

`EVIDENCE_ALLOWED -> one evidence action -> ACTION_REQUIRED`

From `ACTION_REQUIRED`, Implementer must mutate/submit or declare one concrete `need_more_evidence` blocker, which unlocks exactly one additional evidence action. Dispatcher becomes terminal-only after its prepared context is loaded. This intentionally constrains **legal transitions**, not the number of turns a difficult task is allowed to use.

Detailed report: `2026-09-29-productive-progress-state-machine.md`.