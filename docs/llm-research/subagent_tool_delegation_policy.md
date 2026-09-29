# Subagent Tool Delegation Policy

Research baseline: **2026-09-28**. Simplified current model: **2026-09-29**.

This document records the rationale for delegation. It is **not** the normative runtime contract. Current rules live in:

- `docs/CI_RULES.md`
- `agents/implementer/AGENTS.md`
- `scripts/pi-common/stage-config.mjs`
- `scripts/pi-common/progress-controller.mjs`

## Principle

> Main owns mutations and terminal submission. Use a child only when deterministic evidence cannot answer the next concrete question cheaply.

The goal is not maximal delegation. A child has fixed cost: another context, model calls, tool work, and a handoff.

## Startup

Fresh Implementer work starts with one runtime-owned call:

```text
prepare_implementation
  -> implementation-planner
  -> { steps, complexity: trivial|nontrivial, reason }
```

There is no separate complexity-classifier. Dispatcher already owns IMPLEMENT-vs-ARCHITECT routing, so Implementer needs only the startup evidence class:

- `trivial` -> 2 initial evidence actions;
- `nontrivial` -> 6 initial evidence actions.

That class does not alter response budgets, workflow routing, or delegation policy.

## Direct evidence routing

Use the cheapest sufficient route:

```text
known source symbol -> semantic LSP -> exact read
known file/path     -> exact read
unknown literal/path -> indexed_repo_search or repo_search -> exact read
structural question -> Orbit -> exact read when source text matters
history/provenance  -> one narrow Git Context call after current code is known
hard semantic ambiguity -> one compact scout/advisor call
```

RepoMap is Architect-only. Implementer does not load the `pi-repomap` extension.

Main may not use direct `grep`, `find`, or `ls`; deterministic repository search tools cover that role.

## Scout

Use `scout` only when the currently missing fact requires interpretation rather than mechanical lookup, for example:

- several plausible implementations need semantic comparison;
- a stack trace/log needs analysis;
- a broad relationship cannot be resolved with LSP, Orbit, or literal search;
- one specific historical question still blocks the next safe action.

Ask one concrete question, request compact output, and stop at the first sufficient answer.

For a pre-edit scout, prefer:

1. target path;
2. a 1-based line/range plus a short marker for `safe_edit`;
3. otherwise the smallest exact `oldText` for `edit`;
4. one safety constraint, if any.

## Productive-progress interaction

Evidence is bounded by runtime state, not by a turn count.

After the initial 2/6 evidence allowance, main must mutate or submit. If one concrete missing fact still blocks that action, `need_more_evidence` unlocks exactly one evidence action. One extra unlock is allowed per productive epoch.

A successful `safe_edit`, `edit`, `write`, `rollback_last_mutation`, or `submit_result` resets the epoch according to runtime rules.

## Ownership

Main owns:

- acceptance-criteria interpretation;
- local plan adaptation;
- `safe_edit` / `edit` / `write`;
- rollback/conflict mutations;
- `submit_result`.

The planner owns only startup plan + binary startup class. Scout/advisor children own only evidence gathering. They do not become mutation owners.

## Restored work

Restored checkpoint/issue-branch work skips startup exploration:

```text
submit_result({})
  -> fix only a concrete reported failure if needed
  -> submit_result({})
```

## Historical note

Earlier revisions used RepoMap in Implementer, a special `trivial_repo_lookup`, and a separate `complexity-classifier` with `trivial | normal | complex`. Those paths were removed after the runtime had enough deterministic routing and evidence-budget controls to make them redundant.
