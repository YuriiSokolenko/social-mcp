# Subagent Tool Delegation Policy

Research baseline: **2026-09-28**. Current runtime policy updated **2026-09-29**.

## Purpose

This document records the current Implementer boundary between the main Pi agent, deterministic repository tools, and native subagents.

Core principle:

> **Main owns mutations and terminal submission. Evidence gathering is bounded by runtime state, not by an arbitrary number of model turns.**

Subagent launches have real fixed cost: a new child context, model turns, tool work, and handoff. The goal is not to maximize delegation. The goal is to obtain the minimum missing evidence needed for the next safe product action.

## Startup planning and complexity

Fresh Implementer work starts from the complete operating contract embedded in the initial prompt. Main must not re-read `agents/implementer/AGENTS.md`.

The first tool action is the runtime-owned `prepare_implementation`.

Runtime then:

1. sends only issue title/body to the permanent `implementation-planner`;
2. caps the planner at **768 output tokens** and schema-validates its ordered plan;
3. sends issue title/body plus that plan to the separate `complexity-classifier`;
4. schema-validates `{ complexity, reason }`;
5. returns only the prepared plan and classification to main.

`prepare_implementation` is runtime-enforced **single-shot**. Main cannot call the planner or classifier children directly as substitutes.

Complexity remains planning metadata. It does not grant more tool calls, more response budget, or permission for broad exploration.

## Productive-progress state machine

The current runtime no longer permits an open-ended sequence of reads/searches/scouts after preparation.

```text
prepare_implementation
        |
        v
EVIDENCE_ALLOWED
        |
        | 2 bounded actions for trivial; 6 for normal/complex
        v
ACTION_REQUIRED
        |
        +--> edit
        +--> write
        +--> submit_result
        |
        +--> need_more_evidence({missing, reason})
                    |
                    v
              EVIDENCE_ALLOWED
                    |
                    | exactly one evidence action
                    v
              ACTION_REQUIRED
```

Each evidence permit is consumed when its tool call is accepted, not when it finishes. The initial allowance is complexity-aware: **2 actions for trivial work and 6 for normal/complex work**. It supports one bounded locate → inspect → anchor chain without reopening exploration indefinitely.

### Evidence actions

Examples include:

- repo-map orientation or one `repomap outline` when the target area is unclear;
- direct `read` of an already-known path;
- `indexed_repo_search` for fast literal/path/symbol discovery on indexed `dev`;
- `repo_search` for deterministic literal path/content discovery in the current worktree;
- `trivial_repo_lookup` for the special trivial unknown-target path;
- one scout/research/delegate call when semantic evidence is genuinely required;
- an allowed bounded diagnostic command.

After the complexity-specific initial evidence window is exhausted, main is back in `ACTION_REQUIRED`.

### Concrete blocker escape

If the available evidence is insufficient for a safe mutation or submission, main may call:

`need_more_evidence({missing, reason})`

The request must name one concrete missing fact and why it blocks the next safe action. Runtime then unlocks exactly one evidence action.

An exact repeated blocker request is rejected. The runtime intentionally does not use another LLM to judge semantic equivalence.

`set_response_budget` and the one-time `subagents_enable` control action do not consume an evidence permit.

## Keep in the main agent

Main retains:

- issue/acceptance-criteria interpretation;
- execution decisions after the prepared plan;
- direct reads of already-known paths when an evidence permit is available;
- deterministic `repo_search`;
- the special `trivial_repo_lookup` path;
- `safe_edit` / `edit` / `write`;
- `rollback_last_mutation` when the latest mutation is proven harmful;
- conflict-resolution mutations;
- bounded known-path `git diff` / `git status`;
- `submit_result`.

Do not use repeated guessed reads as discovery. More importantly, do not treat "another useful read exists" as sufficient reason to reopen exploration: after the current evidence action, another read requires a concrete `need_more_evidence` blocker.

## When to use scout

Use `scout` only when the one missing fact cannot be obtained cheaply with deterministic search or one direct known-path read, for example:

- a conceptual target cannot be identified by literal `repo_search`;
- several candidates were found and choosing between them requires semantic comparison;
- usages or related implementations require interpretation;
- logs, diagnostics, stack traces, or history need analysis;
- the missing evidence requires a broad repository view rather than a bounded read.

Complexity alone never justifies scout.

A scout request should answer one concrete question and stop at the first sufficient answer. Require compact fixed-shape output; do not ask for whole files or broad dumps.

For a pre-edit scout, prefer asking for:

1. target path;
2. a 1-based line/range plus a short marker suitable for `safe_edit`, when line-based mutation fits;
3. otherwise the exact minimal verbatim `oldText` needed by `edit`;
4. one safety constraint, if any.

After the scout returns, runtime is back in `ACTION_REQUIRED`.

## Tool routing constraints

When the issue or prepared plan already names a source-code symbol, use semantic LSP first; do not spend RepoMap, Zoekt, Git Context, or scout calls merely rediscovering that symbol. Main may not use direct `grep`, `find`, or `ls`. For non-semantic discovery, prefer indexed search when available and `repo_search` for authoritative current-worktree literal/path discovery.

Broad main-agent shell access remains blocked. Known-path read-only Git diff/status commands are the intended direct shell exception.

Focused test/lint/type/compile work remains owned by the existing trusted/package workflows and terminal validation path rather than broad ad-hoc shell exploration.

## Ownership

Main owns:

- mutation;
- conflict resolution;
- terminal submission.

Children do not become mutation owners in the Implementer flow.

- `implementation-planner` plans.
- `complexity-classifier` classifies.
- `scout` gathers evidence.
- `delegate`, `reviewer`, `oracle`, and `researcher` are optional focused advisors/evidence sources when the current blocker genuinely needs them.
- `worker` is not the mutation owner for Implementer.

Git/GitHub state ownership remains with trusted workflow tooling.

## Restored work

Restored checkpoint/issue-branch work does not enter the fresh exploration path.

It starts in `ACTION_REQUIRED` and should call:

`submit_result({})`

immediately.

If submission reports a concrete conflict or validation failure, main fixes only that problem and retries. Restored work must not use `already_satisfied`.

## Response budgets

Selected child agents load `scripts/pi-subagent-response-budget.mjs` and mirror the parent's current per-response ceiling. The implementation planner is separately capped at 768 output tokens.

The normal main response levels remain:

- SHORT: 2048
- NORMAL: 4096
- DEEP: 8192

Automatic promotion after hitting a ceiling occurs only when the turn made concrete progress. A reasoning-only ceiling hit does not earn a larger next response.

These limits apply to individual responses. They are **not** a hard aggregate child-session token/turn/wall-time budget. Aggregate child-session cost remains an open reliability item.

## Current intended flows

Known source symbol:

```text
embedded contract
  -> prepare_implementation
  -> lsp_start_server when a cold name-only lookup needs it
  -> lsp_find_symbol
  -> read exact source
  -> safe_edit/edit/write
  -> submit_result
```

Known file/path without a semantic lookup:

```text
embedded contract
  -> prepare_implementation
  -> read known target
  -> safe_edit/edit/write
  -> submit_result
```

Literal discovery:

```text
embedded contract
  -> prepare_implementation
  -> repo map orientation when useful
  -> indexed_repo_search or repo_search
  -> read discovered target
  -> read exact anchor when needed
  -> safe_edit/edit/write
  -> submit_result
```

Semantic blocker:

```text
embedded contract
  -> prepare_implementation
  -> first evidence action
  -> need_more_evidence("one concrete semantic fact")
  -> one compact scout/advisor call
  -> safe_edit/edit/write
  -> submit_result
```

Already satisfied in current `dev`:

```text
embedded contract
  -> prepare_implementation
  -> evidence establishing exact requested end state
  -> submit_result(already_satisfied=true, changes=[])
```

## Historical successful reference — issue #139

GitHub Actions run `36468466648`, job `109084405617`, was the first confirmed successful known-target run for the planner/classifier architecture before the productive-progress state machine was added.

The task was deliberately minimal: append one exact line to already-known `tasks/README.md`.

Observed behavior:

- main called `prepare_implementation` once;
- planner output: 195 tokens;
- classifier output: 62 tokens, `trivial`;
- no scout or generic subagent discovery;
- one direct target read supplied the edit anchor;
- main performed one `edit`;
- bounded diff confirmed one line added;
- `submit_result` validated and published PR #140;
- 6 main responses;
- 1,825 main output tokens;
- 71,015 total reported tokens;
- about 154.7 seconds model response time.

The run also exposed a remaining inefficiency at that time: the model spent 1,188 output tokens and about 80.5 seconds reasoning about a trivial newline/edit anchor after the read had already supplied enough evidence.

That observation directly motivated the later productive-progress design: once evidence is sufficient, the runtime should move the trajectory toward action rather than merely asking the prompt to be less verbose.

## 2026-09-29 reasoning-to-action follow-up

Implementer #4 and a Dispatcher run later reproduced the same class more strongly: both had sufficient evidence but continued reasoning/research without mutation or terminal submission.

The resulting state-machine implementation is documented in:

`docs/llm-research/2026-09-29-productive-progress-state-machine.md`

Validated implementation commits:

- `064a78a89e08401f425eae71073d35c87c75b707`
- `6da3bc652a84fcfda2949aaf0b170d0a9e2ec134`

Final CI run `36537093235` succeeded.

## Measurement goals

Future real-flow runs should compare:

- time from `prepare_implementation` completion to first mutation;
- number of evidence actions;
- number of `need_more_evidence` calls;
- attempts blocked while in `ACTION_REQUIRED`;
- main-context tokens;
- planner/classifier tokens;
- exploratory child tokens;
- total child-session time;
- total model time;
- mutation-to-`submit_result` delay;
- whether differently worded blockers become a new loop surface.

The current priority is no longer "add a productive-progress watchdog"; it is to validate this state machine under real tasks and add an aggregate child-session budget if child cost remains the dominant failure mode.
