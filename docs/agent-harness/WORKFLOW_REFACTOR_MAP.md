# Workflow automation refactor map (#736)

Inventory and prioritized duplication/complexity map for the Pi/CI workflow
code. #736 is executed in small, behavior-preserving slices; this file records
what each slice consolidated, what is still a candidate, and what duplication
is intentional. Update it when a slice lands.

## Entry points → scripts

| Workflow | Scripts invoked directly |
| --- | --- |
| `pi-dispatcher.yml` | `pi-dispatcher.mjs`, `pi-issue-reconcile.mjs`, `pi-run-stage.mjs` |
| `pi-triage.yml` | `pi-triage.mjs`, `pi-run-stage.mjs` |
| `pi-architect.yml` | `pi-architect.mjs`, `pi-run-stage.mjs`, `pi-transition.mjs`, `pi-usage-summary.mjs`, `orbit-context-preflight.sh` |
| `pi-issue-agent.yml` (Implementer) | `pi-run-stage.mjs`, `pi-transition.mjs`, `pi-labels.mjs`, `pi-issue-summary.mjs`, `pi-usage-summary.mjs`, `orbit-context-preflight.sh`; `pi-common/` `issue-context`, `issue-worktree`, `issue-publication`, `prepare-environment`, `runtime-failure` |
| `pi-pr-review.yml` | `pi-run-stage.mjs`, `pi-review-result.mjs`; `pi-common/` `pr-guard`, `prepare-environment`, `product-checks`, `review-state` |
| `pi-pr-fix.yml` | `pi-run-stage.mjs`; `pi-common/` `pr-guard`, `issue-context`, `prepare-environment`, `finalize-product-tree`, `repair-publication` |
| `pi-auto-merge.yml` (Merge Gate) | `pi-auto-merge.mjs` |
| `pi-reconcile.yml` | `pi-reconcile.mjs`, `pi-common/review-state.mjs` |
| `pi-review-invalidate.yml` | `pi-common/review-state.mjs` |
| `pi-automation-control.yml` | `pi-common/automation-control.mjs` |
| `ci.yml` | `pi-post-merge.mjs`, `pi-common/run-check.mjs`, `pi-common/workflow-dispatch.mjs` |
| `ci-terminal-wake.yml` | `pi-common/workflow-dispatch.mjs` |
| `pi-usage.yml` | `pi-usage-collect.mjs` |
| `verify-run-check-beelink.yml` | `pi-agent-runtime.mjs`, `pi-common/run-check.mjs` |
| `control-runner-watch.yml` | inline shell only |

`pi-run-stage.mjs` selects a backend (`pi-common/pi-stage-backend.mjs` or
`mini-swe-stage-backend.mjs`), which loads `pi-agent-runtime.mjs` and the
stage's `pi-*-result-tool.mjs`.

## Complexity hotspots (lines, `dev` at the start of #736)

| File | Lines | Note |
| --- | --- | --- |
| `scripts/pi-agent-runtime.mjs` | 5733 | Pi extension: tool registration, steering, budgets, recovery, observability in one module. Highest-value split target; must go incrementally because every provider-facing tool contract lives here. |
| `scripts/pi-common/progress-controller.mjs` | 1226 | Pure state machine; already well tested, split only with a concrete reason. |
| `scripts/pi-common/semantic-loop-guard.mjs` | 881 | Pure detection logic. |
| `scripts/pi-common/run-check.mjs` | 791 | Contract + sandbox backends; Docker backend is already separate. |
| `scripts/pi-planner-evidence.mjs`, `scripts/pi-log-filter.mjs` | ~780 each | Diagnostic/presentation scripts. |
| `scripts/pi-common/implementation-planner.mjs` | 731 | |
| `scripts/pi-implementer-result-tool.mjs` | 674 | Mixes terminal-tool contract, git inspection and issue context. |

## Slice 1 (this PR): stage-level GitHub state and linkage helpers

| Duplication | Before | After |
| --- | --- | --- |
| Fresh read → `validateIssueTransition` → CAS label replace | identical private `transitionIssue` in `pi-dispatcher.mjs`, `pi-triage.mjs`, `pi-architect.mjs` | `transitionIssueState()` in `pi-common/github-state.mjs` |
| Plain issue `load`/`patch` pair for `replaceIssueState` | spelled out in each of the above plus `pi-reconcile.mjs` | `issueStateIo(api)` in `pi-common/github-state.mjs` |
| PR → closing-issue linkage (`<prefix>N` branch, same repo, base branch, `closes/fixes/resolves #N`) | `pi-auto-merge.mjs` and `pi-post-merge.mjs` each had a copy | `closingIssueNumber()` in `pi-common/pr-guard.mjs`; Merge Gate keeps its extra draft refusal on top |
| `architect-parent` / `architect-children` marker parsers | `pi-architect.mjs` and `pi-architect-plan-validator.mjs` | exported once from the validator, re-exported by `pi-architect.mjs` |
| Hand-rolled 100-per-page loops | two loops in `pi-architect.mjs` | the existing `githubClient().pages()` (same requests) |

Public exports are preserved (`linkedIssueNumber` from both merge scripts,
`parentOf`/`childNumbers` from `pi-architect.mjs`). Stage concurrency error
text is unchanged, including Dispatcher's default `pipeline` context.

One intentional tightening: post-merge's linkage now also rejects an issue
branch number that is not a safe integer (20+ digit branch names), as Merge
Gate already did. No real issue can have such a number.

## Remaining candidates (not yet done)

1. **`pi-agent-runtime.mjs` split** — extract cohesive, already-pure clusters
   (tool-schema builders, steering text, budget arithmetic) into
   `pi-common/` modules one at a time with characterization tests first.
2. **Fetch-style `api` adapters** — `pi-dispatcher.mjs` and `pi-triage.mjs`
   wrap `githubClient().api` with an `{ method, body: JSON.stringify(...) }`
   shim that is immediately `JSON.parse`d back. Callers can use the client
   signature directly; mechanical but touches many call sites.
3. **Run-title contracts** — `pi-reconcile.mjs` parses live runs by
   `run-name` prefixes (`🤖 Implement #`, `🏗 Architect #`, `🔬 Review PR #`,
   `🔧 Fix PR #`/`Repair`) that are defined independently in the workflows.
   A shared constant plus a workflow-contract test would keep them in sync.
4. **Small crypto/fs helpers** — `sha256` (`candidate-revision`,
   `terminal-receipt`, `mutation-journal`), `atomicWrite` (`safe-edit`,
   `structural-edit`), worktree `canonicalPath` (`accepted-mutation-scope`,
   `mutation-journal`). Low value individually; the copies differ in error
   codes/messages and temp-file prefixes, so a shared helper must take those as
   parameters.
5. **Backend process helpers** — `wait(child, name)` in both stage backends,
   `changedPathsAgainstBase`/`issueContext` in `mini-swe-stage-backend.mjs`
   and `pi-implementer-result-tool.mjs`.

## Intentional duplication / left alone

- **`positiveInteger`** in `progress-controller`, `semantic-loop-guard` and
  `zoekt-search` validates different env/option sources with different
  fallback semantics (`zoekt-search` takes a fallback).
- **`semantic-loop-guard` `digest`** truncates to 16 hex chars; it is a
  fingerprint, not the same contract as the full sha256 elsewhere.
- **`redact`** in `pi-log-filter.mjs` (key-aware, recursive) vs
  `model-trace-proxy.mjs` (header redaction) serve different inputs.
- **Architect split-phase `replaceIssueState` calls** keep their custom
  `validateCurrent`/`patch` (body + epic label); they are not plain
  transitions.
- Workflow YAML: the stage workflows share runner labels
  (`[self-hosted, linux, x64, n150, pi-agent]`) but differ in job permissions
  and concurrency groups (per-issue / per-PR vs singleton). Those must stay
  visible per workflow, so no reusable workflow or composite action was
  introduced in slice 1.
