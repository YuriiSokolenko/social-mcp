# Subagent Tool Delegation Policy

Research date: **2026-09-28**.

## Purpose

This document records the current Implementer boundary between the main Pi agent and native subagents.

Core principle:

> **Main handles bounded known-path operations. Subagents handle exploration.**

Subagent launches have real fixed cost: a new child context, model turns, tool work, and handoff. The goal is therefore not to maximize delegation. The goal is to keep exploratory context out of the main session when that actually saves context or reasoning.

## Planning and task complexity

Planning and task-level complexity are delegated before repository inspection.

- Main reads `agents/implementer/AGENTS.md`.
- Main calls the runtime-owned `prepare_implementation` action exactly once.
- Runtime sends only the issue title/body to the permanent project `implementation-planner`.
- The planner owns the top-level implementation plan and is capped at **768 output tokens**.
- Runtime then sends issue title/body plus that plan to the separate `complexity-classifier`.
- The classifier returns exactly `trivial|normal|complex` plus one short reason.
- Runtime schema-validates `{ complexity, reason }` and gives main only the prepared plan and classification.
- Main does not manually invoke either child and does not repeat task-level planning/classification.

The planner/classifier split keeps exploratory planning and the complexity rubric out of the main implementation context while preserving a structured execution contract.

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
- before complexity is recorded, runtime allows only `classify_task_complexity`; direct `subagents_enable` / `subagent` classification is not exposed to main;
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
  -> prepare_implementation
     -> implementation-planner
     -> complexity-classifier
  -> one bounded direct read
  -> edit/write
  -> bounded direct git diff
  -> submit_result
```

Unknown target:

```text
AGENTS.md
  -> prepare_implementation
     -> implementation-planner
     -> complexity-classifier
  -> compact scout exploration
  -> edit/write
  -> bounded direct git diff
  -> submit_result
```

## Confirmed successful run — issue #139

GitHub Actions run: `36468466648`, job `109084405617`.

Test issue: **#139 — known-target implementer smoke test rerun**.

Target operation was deliberately minimal: append exactly one line to the already-known file `tasks/README.md` and change nothing else.

### Successful steps

1. **Mandatory contract read stayed in main.**
   - Main read `agents/implementer/AGENTS.md` first.
   - It did not perform repository exploration before the contract was loaded.

2. **Preparation was delegated through one runtime entry point.**
   - Main called `prepare_implementation` once.
   - Main did not manually call planner or classifier children.

3. **The planner produced a small, usable plan.**
   - Planner ceiling: **768 output tokens**.
   - Actual planner output: **195 tokens**.
   - The plan identified the exact known target, idempotency check, one-line edit, bounded diff, and terminal submission.
   - No repository search was needed to create the plan.

4. **Complexity classification stayed separate and cheap.**
   - Classifier output: **62 tokens**.
   - Result: `trivial`.
   - Reason correctly described the task as a single-file static README append with no architecture, dependency, migration, security, or conflict decision.

5. **Main respected the known-target fast path.**
   - No `trivial_repo_lookup`.
   - No `scout`.
   - No generic subagent discovery/listing.
   - The issue already supplied `tasks/README.md`, so main went directly to one bounded read.

6. **The bounded read was sufficient evidence for mutation.**
   - Main read only `tasks/README.md`.
   - The requested line was absent, so the task was not already satisfied.
   - The existing final line provided a safe edit anchor.

7. **Mutation ownership stayed in main.**
   - Main performed the single `edit`.
   - Exactly one line was added:
     `Subagent edit-ready delegation test passed.`
   - No existing text was changed.

8. **Verification stayed bounded.**
   - Main ran `git diff -- tasks/README.md`.
   - Diff confirmed one file changed, one line added, zero unrelated edits.

9. **Terminal result and publication completed correctly.**
   - `submit_result` completed.
   - Validation reported `pytest`, `ruff check .`, and `git diff --check` passed.
   - Workflow created PR **#140** from `pi/issue-139`.
   - PR diff was exactly one added line and the PR was mergeable.
   - Issue #139 transitioned to `pi:mr-created`.
   - The checkpoint branch was removed after publication.
   - The overall job completed successfully.

### Measured usage

Main/model totals for the run:

- **6 main responses**
- **11,958 input tokens**
- **1,825 output tokens**
- **57,232 cache-read tokens**
- **71,015 total reported tokens**
- **154.7 s model response time**
- **6 tool calls**

Child preparation work:

- implementation planner: **195 output tokens**
- complexity classifier: **62 output tokens**

This confirms that the planner/classifier split is working as intended: both preparation children stayed compact and main avoided exploratory subagent overhead for a known target.

### Remaining inefficiency found by the successful run

The flow was correct, but the main agent was still too verbose immediately before the simple edit.

The edit-preparation response used:

- **1,188 output tokens**
- about **80.5 s** response time

Most of that response repeatedly reasoned about the trailing newline and whether the final-line anchor should include `\n`. The bounded read had already supplied enough evidence, so this reasoning added no safety value.

For this run, that single response accounted for roughly **65% of all main output tokens**.

Follow-up optimization target:

> When a known-target bounded read yields a unique, obvious edit anchor and the mutation is mechanically specified, main should invoke `edit` immediately instead of narrating alternative anchor/newline strategies.

This is now a more important optimization target than planner/classifier token cost for trivial known-target tasks.

### Secondary parser observation

After terminal submission the log contained an `Unparsed Pi event` for a pytest progress line (`tests/server/test_errors.py ... [81%]`). It did not affect execution: tests passed, publication succeeded, and the job conclusion was `success`. Treat this as a log-parser cleanup item rather than an implementation-flow failure.

## Measurement goal

Future smoke tests should continue comparing:

- main-context tokens;
- planner/classifier tokens;
- exploratory child tokens;
- total tokens;
- model time;
- number of main responses;
- number of child runs;
- failed child runs;
- edit-preparation verbosity;
- whether bounded known-target operations eliminate unnecessary scout/lookup launches.

Issue #139 is the first confirmed successful known-target reference run for the current `prepare_implementation -> planner -> classifier -> main` architecture.
