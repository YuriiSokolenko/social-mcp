# LLM / Agent Reliability Research

This directory collects research that is directly relevant to the reliability of the repository's Pi-based coding-agent workflows. It is intentionally separate from the normative CI documentation: files here record observations, external cases, experiments, failure modes, hypotheses, and mitigations that may evolve as models and runtimes change.

Research date for the initial corpus: **2026-09-28**.

## Contents

- [`llm_agent_looping_100_cases.md`](./llm_agent_looping_100_cases.md) — 100 external cases involving agent looping, excessive reasoning, repeated tool calls, loss of progress, failure to stop, tool/runtime protocol bugs, and related mitigations.
- [`2026-09-29-real-flow-ci-analysis.md`](./2026-09-29-real-flow-ci-analysis.md) — analysis of the first real multi-issue Dispatcher/Implementer flow after enabling real tasks, including token/model-time costs and the reasoning-to-action failure pattern.
- [`2026-09-29-productive-progress-state-machine.md`](./2026-09-29-productive-progress-state-machine.md) — follow-up analysis of Implementer #4 and Dispatcher looping, the rejected turn-counter design, the implemented `EVIDENCE_ALLOWED -> ACTION_REQUIRED` runtime protocol, and green validation.
- This README — conclusions drawn from the external corpus and from our own Pi/Laguna runs.

## Executive conclusions

### 1. "The model is looping" is not one failure mode

The 100-case corpus repeatedly splits into several distinct classes:

1. **Exact action repetition** — the same tool and arguments are issued repeatedly.
2. **Result repetition / no progress** — calls differ slightly but return effectively the same information.
3. **Sequence cycles** — `AAA`, `ABAB`, `ABCABC`, or longer recurring action patterns.
4. **Semantic reasoning loops** — the model reopens a settled question using different wording without taking a new action.
5. **Completion regression** — tests/build/review already establish completion, but the model starts checking again.
6. **State-loss loops** — retry, compaction, streaming, tool-result loss, or bad call identity causes already completed work to be rediscovered or replayed.
7. **Protocol loops** — malformed tool calls, schema mismatches, forced tool choice, missing tool results, or parser/runtime bugs keep the model in a retry cycle.

A single "same tool call N times" guard catches only the first class.

### 2. Runtime guardrails are more reliable than prompt-only rules

Across Pi, Hermes, OpenHands, Gemini CLI, AutoGen, ADK, Mastra and others, the recurring pattern is that instructions such as "do not repeat yourself" or "stop when done" are useful guidance but weak safety boundaries.

The more robust systems add deterministic runtime mechanisms such as:

- canonical tool-call fingerprints;
- tool-result / no-progress fingerprints;
- short sequence-cycle detection;
- separate limits for LLM turns and actual tool executions;
- explicit terminal states;
- bounded retry classes;
- preserved call/result identity;
- state checkpoints across compaction/retry;
- circuit breakers that stop or redirect the trajectory.

Prompt guidance should remain a secondary layer, not the only enforcement mechanism.

### 3. Output-limit hits are not proof that the model needs a larger answer budget

Our earlier policy treated a response that reached its ceiling as evidence that the next response needed more room:

```text
2048 -> 4096 -> 8192
```

That assumption is unsafe for reasoning models. A response can hit its ceiling because it is making useful progress, but it can also hit the ceiling because it is repeatedly reconsidering the same decision.

The external corpus contains multiple examples where a larger limit merely prolongs the same trajectory. Laguna-specific reports also show long self-verification / reconsideration loops where more reasoning budget does not necessarily lead to a final answer.

For this repository, budget escalation should therefore be tied to **observable progress**, not only token consumption.

### 4. Repository state must outrank model memory and reasoning text

A model may describe code in reasoning, plan a patch in detail, or carry a compaction summary that says work is complete. None of those are proof that the repository changed.

For coding workflows, the authoritative state is observable:

- actual `edit` / `write` operations;
- working-tree diff;
- committed/checkpointed state;
- test results;
- the explicit terminal result tool.

This became especially important in our #97 incident, where the model later believed it had created files that never existed.

### 5. Context compaction is a state transition and must not reset safety accounting

Compaction can legitimately reduce context size, but it must not reset:

- global turn accounting;
- exploration/orientation budgets;
- completed plan items;
- whether repository mutations actually happened;
- terminal/result state.

Several external Codex/Hermes reports show `plan -> compaction -> same plan` or stale-task resurrection. Our #97 trace showed the same family of failure: after repeated long reasoning and compaction, the model confused planned work with completed work.

### 6. "Green workflow" must mean the agent satisfied the terminal contract

A process exit code of zero is not sufficient. A coding-agent workflow should only be considered successful if its explicit terminal contract is satisfied.

For the Implementer in this repository that means a successful `submit_result`, not merely "Pi stopped running" and not merely "the worktree has no changes".

## Local incident: Implement #97

The strongest local reproduction so far is GitHub Actions run:

- `https://github.com/YuriiSokolenko/social-mcp/actions/runs/36382512849`

Observed behavior:

- 18 model responses;
- 11,284 output tokens;
- 431,259 total tokens including cache reads;
- about 2,427 seconds of model response time;
- 14 `read` operations;
- 11 `bash` operations;
- **0 `write` operations**;
- **0 `edit` operations**;
- **0 successful `submit_result`**;
- four responses reached exactly 2,048 output tokens;
- two context compactions occurred;
- Pi started four agent continuations inside the same overall job.

The model spent a long time designing the migration implementation in reasoning. After compaction/continuation it stated that it had completed the implementation and enumerated files/features it believed it had added. `git diff --stat` was empty, and a syntax check then failed because the supposedly created test file did not exist. The model subsequently recognized that it had never actually edited the repository.

This trace is evidence for a **reasoning-to-action transition failure**, amplified by long reasoning and state reconstruction after compaction. It is not evidence that 2K was simply too small.

## Laguna-specific observations

The currently used model is Laguna served directly; LiteLLM is not part of the current path.

External Laguna reports describe semantic self-verification / reconsideration loops in which the model repeatedly re-evaluates an already-developed solution and can consume the full generation budget without producing the expected final answer. One useful reference from the investigation:

- `https://huggingface.co/poolside/Laguna-S-2.1-NVFP4/discussions/16`

Our current working hypothesis is:

- Laguna has a genuine model-level attractor toward repeated verification/reconsideration on some tasks;
- preserved reasoning can be useful for normal agent work but may make an already-bad trajectory more persistent;
- our previous automatic output-budget escalation amplified that attractor;
- runtime progress/termination controls are therefore required even if prompts and sampling are later improved.

This remains a working hypothesis, not a claim that every loop is caused by Laguna itself. The corpus includes many examples where runtime, parser, state, streaming, or tool-protocol defects produce superficially similar symptoms.

## Mitigations already applied in this repository

Initial fixes were applied around commits `ad662526`, `0cfe599e`, and `bd8c67af` on `dev`.

### Progress-aware response budgets

Relevant files:

- `scripts/pi-common/progress-controller.mjs`
- `scripts/pi-agent-runtime.mjs`
- `tests/pi-progress-controller.test.mjs`

Behavior:

- a ceiling hit alone no longer earns a larger automatic response budget;
- automatic escalation is tied to a successful concrete action such as `edit`, `write`, `submit_result`, or `submit_repair`;
- reasoning-only exhaustion falls back to the short budget rather than being rewarded with a larger window;
- an explicit response-budget request is still available for genuinely larger next responses.

### Bounded pre-complexity orientation

Relevant files:

- `scripts/pi-common/progress-controller.mjs`
- `scripts/pi-common/stage-config.mjs`
- `scripts/pi-agent-runtime.mjs`
- `tests/pi-progress-controller.test.mjs`

Behavior:

- Implementer/Reviewer/Fixer orientation before `declare_task_complexity` is bounded;
- after the configured orientation budget, more `read`/`bash` exploration is blocked and the agent is directed to classify the task and move on;
- post-plan behavior remains enforced by the existing phase rules.

### Monotonic guard accounting across context compaction

Pi can reset its reported `turnIndex` after context compaction. The shared progress controller keeps an internal monotonic count, so compaction cannot reset global or pre-complexity safety limits.

### Repository-grounded completion nudge

The Implementer terminal nudge now explicitly states that repository state is authoritative and that code present only in reasoning, plans, or compaction summaries is not implemented work.

### Productive-progress state machine

Relevant files:

- `scripts/pi-common/progress-controller.mjs`
- `scripts/pi-agent-runtime.mjs`
- `scripts/pi-common/stage-config.mjs`
- `agents/implementer/AGENTS.md`
- `agents/dispatcher/AGENTS.md`
- `tests/pi-progress-controller.test.mjs`

The follow-up Implementer #4 and Dispatcher runs showed that `madeProgress=false` was being measured but only affected response-budget selection. The model could therefore continue with different reads/searches or repeated prose while product state remained unchanged.

The runtime now uses a state transition instead of a fixed "N turns without progress" counter. The **normative current policy** lives in `docs/CI_RULES.md` and `agents/implementer/AGENTS.md`; this research index intentionally does not duplicate the full state machine.

Current high-level shape:

```text
prepare_implementation
  -> one planner result: steps + trivial|nontrivial
  -> bounded evidence (2 or 6)
  -> productive action
  -> at most one explicit need_more_evidence escape per productive epoch
```

The historical incident/design record remains in `2026-09-29-productive-progress-state-machine.md`.

### Shared terminal-result gate

Relevant files:

- `scripts/pi-common/terminal-tool.mjs`
- `scripts/pi-run-stage.mjs`
- stage-specific `scripts/pi-*-result-tool.mjs`

Behavior:

- every model-driven stage must complete through its trusted terminal tool;
- the shared runner treats Pi exiting without that terminal marker as a workflow failure;
- a no-change implementation result is no longer a green GitHub Actions run;
- checkpoint/recovery logic can still preserve work where appropriate.

## What remains to investigate

The deterministic state machine closes the main open-ended exploration gap without relying on an arbitrary turn counter. Remaining research is narrower:

1. **Aggregate child-session budgets** — bound total child turns/output/wall time, not only each individual child response.
2. **Result-aware loop detection** — fingerprint `(tool, normalized args, normalized result)` where stages still permit repeated evidence cycles.
3. **Semantic blocker equivalence** — differently worded `need_more_evidence` requests may describe the same blocker; the current guard rejects only exact canonical repeats.
4. **Completion regression detection** — once objective completion evidence exists, prevent reopening already-settled questions unless new contradictory evidence appears.
5. **Compaction checkpoint quality** — explicitly persist completed plan items, actual mutations, current next action, terminal state, and productive-progress state.
6. **Laguna A/B experiments** — compare response-budget policy, sampling, reasoning preservation, and repetition penalties on identical prompts/seeds.
7. **False-positive control** — validate that legitimate debug/fix cycles can request concrete new evidence without reopening broad exploration.

## Design principles for future fixes

When adding new safeguards, prefer the following order:

1. **Measure state change first.** Distinguish repeated work from repeated-looking but productive work.
2. **Use deterministic cheap guards first.** Exact/cycle/progress checks should not require another LLM call.
3. **Use semantic judging only when needed.** A judge can help with reasoning-only loops but should be rare and bounded.
4. **Keep terminal states explicit and machine-checkable.** Do not infer success from prose.
5. **Do not silently erase state during compaction/retry.** Fail visibly if safe recovery is impossible.
6. **Treat larger reasoning budgets as a resource to earn, not an automatic retry policy.**
7. **Preserve recovery paths.** Guards should redirect or checkpoint useful work where possible, not destroy it.

## How to use this directory

When a new model/runtime problem appears:

1. capture the concrete run and metrics;
2. classify it into one or more failure modes above;
3. search the 100-case corpus for similar behavior;
4. prefer a runtime/state fix over adding another prompt sentence when possible;
5. add the new local case and the outcome of the mitigation here so future model changes can be compared against the same history.
