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

## Slice 2 (#741): pure provider wire-policy extraction

This slice starts from `dev` commit `a42e0ab9ff98` and changes no workflow YAML,
agent prompt, registered tool, mutable counter or provider call order.

| Responsibility | Before | After / owner |
| --- | --- | --- |
| Coding thinking on outbound messages | `pi-agent-runtime.mjs` | `pi-common/provider-wire-policy.mjs`: `applyCodingThinkingPolicy`, `disableThinkingInPayload` |
| Final serialized `tool_choice` enforcement and zero/named-tool safety | runtime | `provider-wire-policy.mjs`: `requireToolChoiceInPayload`, `withoutProviderTools`, `implementerToolChoiceDecision` |
| Parsing and retry classification of provider HTTP failures | runtime | `provider-wire-policy.mjs`: `providerErrorStatus`, `retryableProviderErrorStatus` |

**Counts:** runtime 5734 → 5622 lines; one new pure module (118 lines), seven existing named exports preserved at the original runtime entry point. Dependency direction is
`pi-agent-runtime → provider-wire-policy → session-state.providerToolNames`;
there is no reverse dependency or runtime state in the extracted module. Runtime
still owns on-payload hooks, request phase, available/deferred capabilities,
tool registrations, coding child and terminal/recovery wiring.

**Characterization:** Existing `tests/pi-coding-session.test.mjs` tests the
runtime's public named exports, provider status shapes and live Main/coding
request forcing/compatibility fallbacks. New `tests/pi-provider-wire-policy.test.mjs`
tests thinking, payload identity, serialized tool constraints, named/stale tools,
HTTP parsing and retryability in isolation. Other focused coverage:
`pi-provider-tool-boundary`, `pi-provider-tool-recovery`, `pi-session-state-runtime`,
`pi-main-tool-profile-runtime`. CI/full harness checks remain authoritative.

**Intentional non-extractions:** session mutation/progress ledgers, live tool
registration, provider-event callbacks and child-session orchestration remain
in runtime; moving them requires separate stateful lifecycle characterization.

## Slice 3 (#741): Coding Session input admission

Move only pure `begin_coding_session` argument parsing, validation and handoff normalization out of the runtime. Keep the lifecycle, correction/abort routing, tool registry, provider hook and child launch unchanged.

| Responsibility | Before | After / owner |
| --- | --- | --- |
| Unicode-safe handoff trim and truncation | runtime-private `normalizedCodingSessionHandoff` | `pi-common/coding-session-input.mjs` |
| Optional-field validation and diagnostics | runtime public `codingSessionArgumentValidation` | input module, re-exported unchanged by runtime |
| Serialized tool-call argument admission | runtime-private `codingSessionArgumentFailure` | input module, preserving JSON precedence and diagnostics |
| Shared handoff upper bound | runtime-local constant | `CODING_SESSION_HANDOFF_MAX_LENGTH` from input module |

**Counts:** runtime 5622 → 5576 lines; one new pure module (55 lines). Dependency is `runtime → coding-session-input`; module has no imports, session state, registration side effects or IO. Public export, error text, 1,200-codepoint bound and tool visibility gating are unchanged.

**Characterization:** existing `pi-coding-session.test.mjs` covers prepared/fallback child launch, handoff truncation, invalid-argument correction, repeated-invalid fail-closed abort, and terminal results. New `pi-coding-session-input.test.mjs` checks missing/hidden tools, input envelopes and precedence, exact errors and astral Unicode boundaries. Runtime retains session orchestration, stateful correction policy and trusted fork construction.

## Slice 4 (#741): pure runtime tool guidance

Two string-rendering functions have moved to `pi-common/runtime-tool-guidance.mjs`, with zero IO or mutable state. The runtime keeps thin call-site wrappers that inject the current stage, coding-child status, live profile counter and request-local executable surface.

| Guidance responsibility | Before | After |
| --- | --- | --- |
| Hidden/forbidden Main tool messages | `profileHiddenToolAdvice` in runtime | pure text function in `runtime-tool-guidance.mjs`, using existing `main-tool-profile` constants |
| Stage-specific action hints (Reviewer, Implementer and coding child) | `taskSpecificToolGuidance` in runtime | pure function injected with phase, tool visibility and verified current limit/tool names |

**Counts:** runtime 5576 → 5534 lines; extracted 72-line module with one dependency on `main-tool-profile.mjs` (no cycle), and new `pi-runtime-tool-guidance.test.mjs` characterization tests. Exact strings, hint order, tool admission, state reads, steer timing and callbacks are unchanged.

Existing `pi-main-tool-profile-runtime`, `pi-provider-tool-boundary`, `pi-runtime-steering` and `pi-coding-session` integration tests retain end-to-end coverage. The one raw-source coding guidance assertion now follows the authoritative new source.

## Slice 5 (#741): pure response budget and runtime telemetry

Move lazy, pure log-record iterators for the Planner preparation and Coding Session
into `pi-common/runtime-budget-telemetry.mjs`. Yield exact log levels/strings in the original emission sequence;
the runtime is still the emitter and retains event registration, sequencing and
all mutable session/progress state. Extract active response-cap precedence,
output-ceiling comparison and the turn-start budget record without changing the
controller's selection or enforcement of budgets.

| Concern | Before | After |
| --- | --- | --- |
| Planner `PI_PLAN` / `PI_COMPLEXITY` / `PI_PREPARATION_FALLBACK` records | inline runtime `console.*` formatting | pure `plannerTelemetryRecords`, runtime emits in original order |
| Coding Session readable and JSON metrics | inline runtime `codingSessionLog` formatting | pure `codingSessionTelemetryRecords`, runtime emits on unchanged log channels |
| Response cap precedence and ceiling-hit decision | inline in turn hooks | pure `activeResponseCeiling` / `responseHitOutputCeiling` |
| `PI_BUDGET` turn-start metric field projection | inline turn hook | pure `turnStartBudgetTelemetry`, runtime keeps authoritative live reads |

**Counts:** runtime 5534 → 5507 lines (including follow-up review fixes), plus new `scripts/pi-common/runtime-budget-telemetry.mjs`
(82 lines); zero imports into the pure helper. Mutation authorization,
large-mutation grants, output budget application, retry guard, provider
usage ledger and hook order are unchanged. The two previously inline
`requested_budget` projections now call `activeResponseCeiling` at the same
runtime points, eliminating the remaining duplicated precedence rule. The
log emitter explicitly accepts only `log` and `warn` records.

**Characterization:** `tests/pi-runtime-budget-telemetry.test.mjs` pins
numeric boundary cases, field/key order, exact log strings, Unicode UTF-8
byte counts, absent usage as unknown (not zero), warning channels, and
the runtime's live-state wiring. Existing `pi-progress-controller`,
`pi-coding-session` and `pi-implementation-planner-bootstrap` suites
continue to exercise runtime behavior.

## Remaining candidates (not yet done)

1. **Continue `pi-agent-runtime.mjs` split** — after pure provider wire policy,
   extract separate cohesive schema/steering/budget clusters one at a time with
   characterization tests first; defer stateful orchestration until safe.
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
