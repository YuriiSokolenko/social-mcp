# Subagent Tool Delegation Policy

Research date: **2026-09-28**.

## Purpose

This document records the current Implementer boundary between the main Pi agent and native subagents.

Core principle:

> **Main handles bounded known-path operations. Subagents handle exploration.**

Subagent launches have real fixed cost: a new child context, model turns, tool work, and handoff. The goal is therefore not to maximize delegation. The goal is to keep exploratory context out of the main session when that actually saves context or reasoning.

## Task complexity

Task-level complexity is delegated before repository inspection.

- Main reads `agents/implementer/AGENTS.md`, derives acceptance criteria from the supplied issue, and writes a short plan.
- Main activates `pi-subagents` if needed.
- A project `complexity-classifier` child receives only the issue title/body plus the short plan.
- The classifier has no tools, no inherited project/global context, and no skills catalog.
- It returns exactly `trivial|normal|complex` plus one short reason.
- Main records that result through `declare_task_complexity` without re-arguing it.

The classifier rubric lives in `.pi/agents/complexity-classifier.md`, so the main Implementer prompt does not carry the detailed rubric.

## Keep in the main agent

Use direct main-agent operations when all needed context is already bounded:

- one already-known small file: one `read` call with `limit <= 200`;
- one bounded `git diff ... -- <path>` or `git status --short|--porcelain -- <path>`;
- `edit` / `write`;
- conflict-resolution mutations;
- `submit_result`.

Do not use repeated guessed reads as a substitute for discovery. If the first bounded read is insufficient, switch to delegated exploration.

## Delegate

Use `scout` when any of these are true:

- target path/symbol/test/config is unknown;
- several files must be inspected or compared;
- usages, patterns, or similar implementations must be searched;
- logs, diagnostics, stack traces, history, or broad Git state must be analyzed;
- expected output is larger than one small bounded read/diff;
- a skill or project document must be searched for relevant rules.

`grep`, `find`, and `ls` remain runtime-blocked in main. Broad `bash` is also blocked. Focused test/lint/type/compile commands can use the package-owned `run-ci` workflow.

## Scout request shape

A scout request should answer one concrete question and stop at the first sufficient answer.

Do not ask for the globally smallest/best candidate unless the issue actually requires that optimization. That wording caused exhaustive repository exploration in the #115 smoke test.

For a pre-edit scout, request in one call:

1. target path;
2. exact minimal verbatim `oldText`;
3. insertion/replacement point;
4. one safety constraint, if any.

Require compact fixed-shape output. Do not ask for whole files or broad repository dumps.

## Ownership

Main retains:

- issue interpretation and acceptance criteria;
- execution plan;
- implementation/architecture decisions;
- mutations;
- terminal submission;
- Git/GitHub state ownership remains with trusted workflow tooling.

`complexity-classifier` only classifies. `scout` only gathers evidence. `worker`/`reviewer` are not mutation owners in the Implementer flow.

## Runtime enforcement

For Implementer:

- mandatory first read remains `agents/implementer/AGENTS.md`;
- before `declare_task_complexity`, runtime allows only `subagents_enable` and the `complexity-classifier` subagent;
- a failed classifier may be retried; a successful classification is single-shot;
- after declaration, one bounded direct file read is allowed;
- direct shell access is restricted to bounded one-path Git diff/status commands;
- `grep` / `find` / `ls` stay delegated;
- `.pi/**` is control-plane and cannot be modified by Implementer.

## Response budget

`scout` and `complexity-classifier` load `scripts/pi-subagent-response-budget.mjs` as a child-only extension.

The parent publishes its current response ceiling, so selected native children mirror SHORT/NORMAL/DEEP:

- SHORT: `2048`
- NORMAL: `4096`
- DEEP: `8192`

This controls child response output, not total child usage or context size.

## Intended flow

Known target:

```text
AGENTS.md
  -> issue acceptance criteria
  -> short plan
  -> complexity-classifier
  -> declare_task_complexity
  -> one bounded direct read
  -> edit/write
  -> bounded direct git diff
  -> submit_result
```

Unknown target:

```text
AGENTS.md
  -> issue acceptance criteria
  -> short plan
  -> complexity-classifier
  -> declare_task_complexity
  -> compact scout exploration
  -> edit/write
  -> bounded direct git diff
  -> submit_result
```

## Measurement goal

The next smoke tests should compare:

- main-context tokens;
- child tokens;
- total tokens;
- model time;
- number of main responses;
- number of child runs;
- failed child runs;
- whether direct bounded operations eliminate unnecessary scout launches.

Issue #115 remains the smoke-test vehicle for this policy.
