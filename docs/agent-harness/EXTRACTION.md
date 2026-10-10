# Agent harness extraction: boundary, target layout and migration plan

> **Status: step 1 (#710), isolation inside `social-mcp`.** Nothing has moved. This document is the reviewed boundary: what moves to a standalone harness repository, what stays, and what must split. The authoritative per-file list is [`layers.json`](layers.json). The inventory below is rendered from it, and `tests/harness-boundary.test.mjs` keeps the two in sync.

## How the boundary is enforced

| Guarantee | Enforced by |
| --- | --- |
| Every `scripts/*.mjs` and `scripts/pi-common/*.mjs` file is in exactly one code layer (`harness-core`, `adapter-pi`, `adapter-mini-swe`). | `harness-boundary.test.mjs`: *every control-plane script is classified…* |
| Every tracked file matched by `extraction.scope` (workflows, scripts, infra, prompts, `.pi/`, harness tests, docs, reports, fixtures, shared root files) is classified exactly once as **move**, **split** or **stay**. A new harness file without a classification fails CI. | *every workflow-related file is classified exactly once…* |
| Every split/stay entry has a reason, and every entry appears in this document. | *split and stay entries carry a reason…* |
| Harness code (all three code layers) imports only harness code; relative imports never leave `scripts/`. It does not name the product package (`social_mcp`), the repository (`YuriiSokolenko/social-mcp`) or a private-network host. | *harness code imports only harness code…* |
| Core and adapter code contain no `social-mcp`, configured label, configured workflow file name, `origin/dev` or `'dev'` literal. Before this change the check covered only core and mini-swe; it now covers `adapter-pi` too. | *harness scripts (core and adapters) hardcode no project identity…* |
| Tracked workflow/harness shell entrypoints in `scripts/` and `infra/` contain no executable hardcoded reference to configured `git.defaultBranch`. | *tracked harness shell entrypoints respect configured git.defaultBranch*; shell lexer and mutation tests in `harness-boundary.test.mjs` |
| Product code (`src/`), `Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example` and unclassified product tests reference no harness file. | *product code, image, compose and product tests reference no harness file* |

### Shell entrypoint boundary (#743)

The shell guard uses **tracked** files from `git ls-files` and includes every `*.sh`
under `scripts/` or `infra/`, with exactly one extraction classification
required per file. The current seven entrypoints are:
`scripts/beelink-update-restart.sh`, `scripts/orbit-context-preflight.sh`,
`scripts/upgrade-n150-docker-client.sh`,
`infra/github-runner-autoscaler/manager.sh`,
`infra/github-runner-autoscaler/control-runner-entrypoint.sh`,
`infra/github-runner-autoscaler/worker-entrypoint.sh`, and
`infra/zoekt/update-index.sh`. Shell files under `tests/` are **test fixtures**
rather than deployed workflow entrypoints; their intended grep/assertion literals
do not belong in the production-code guard.

The rule takes `git.defaultBranch` from `.agent-harness.json` through
`projectConfig()`, not a literal default value. It checks Git tracking and
remote refs (`origin/<branch>`, `refs/heads/<branch>`,
`refs/remotes/origin/<branch>`), GitHub API query arguments (`base=`,
`head=`, `ref=`), branch flags (`--base`, `--head`, `--ref`,
`--branch`, `-branches=`), and literal Git checkout/switch/clone/fetch/pull
and related commands. It honors whole branch boundaries, including names with
slashes, and recognizes continued lines ending in a backslash.

The lexical check removes line/inline comments only outside single/double quotes,
preserves quoted command arguments, skips `<<EOF`, `<<'EOF'`, and `<<-EOF`
here-document **bodies** (treated as data), and ignores simple diagnostic
`echo`/`printf`/`log` lines. This is not a complete Bash interpreter:
dynamically constructed/evaluated shell (`eval`, `bash -c`, and executable
shell passed via heredocs), arithmetic/process substitution and unusual
heredoc syntax must be reviewed separately. The guard does not claim coverage
of those forms. It deliberately does not ban project-specific infra wiring
such as image tags, volume names or deployment host paths.

Previously hardcoded Beelink staging Git commands and the Zoekt index refresh
now read `git.defaultBranch` from the checkout config with `jq` and
validate it with `git check-ref-format --branch`. Beelink's explicit
deployment-repository identity and Zoekt's repository URL remain
project-specific infrastructure, not branch-policy violations.

## Coupling found and removed in this step

| Coupling | Direction | Resolution |
| --- | --- | --- |
| `pi-run-stage.mjs` hardcoded the model host `http://192.168.8.184:4001/v1`, the provider `hp-laguna` and the model catalog. | harness → infra | Moved to `.agent-harness.json` `model` (`provider`, `baseUrl`, `choices`), validated strictly by `project-config.mjs` and read through `modelConfig()`, which fails closed. The `PI_PROVIDER` and `PI_MODEL_BASE_URL` overrides are unchanged. The values are identical, so runtime behaviour does not change. |
| `pi-auto-merge.mjs` hardcoded the CI step names whose failure PR Fix may repair (`PRODUCT_CI_STEPS`). | harness → project CI | Moved to `.agent-harness.json` `checks.ciRepairableSteps`. The list gains `Harness Python checks` because those tests previously ran inside `Pytest`, so their failures stay repairable. |
| `ci.yml` ran product and harness checks in the same jobs, and its `test` job installed the product to run harness tests. | shared file | Split into product jobs `test` and `docker` and harness jobs `harness` and `harness-images`. The `harness` job installs only tools and runs harness Python tests with `--noconftest` (the product `tests/conftest.py` imports `social_mcp`). Step names are unchanged, so Merge Gate classification is unchanged. `harness-images` waits for `docker` so two image builds never run at once on the small `general` pool. |
| The README "CI and local checks" section and the `docs/CI_RULES.md` CI paragraph mixed product and harness checks. | shared file | Each is split into product and harness parts that can be removed independently. |
| Error text in `pi-run-stage.mjs` named a host and an infra path (`nano`, `infra/llama-gguf-experimental`). | harness → infra | Made generic. |

Product → harness: **none found.** `src/`, `Dockerfile`, `compose.yaml` and product tests do not reference harness files; the new test keeps it that way. `pyproject.toml` needs no split (see the stay table).

## Remaining hardcoded values (justified)

| Where | Value | Why it remains | Removed by |
| --- | --- | --- | --- |
| Caller workflows `.github/workflows/pi-*.yml`, `ci.yml`, `ci-terminal-wake.yml` | `ref: dev`, `branches: [dev]` | GitHub Actions does not allow expressions in `on.push.branches`, and these files are the **caller** layer, which stays project-owned after extraction. The checkout `ref` becomes a `default_branch` input of the reusable workflow. | Follow-up D |
| Same | `runs-on: [self-hosted, linux, x64, n150, pi-agent \| general]`, `[self-hosted, n150, control]` | Runner labels are infra (layer 4). The autoscaler matches queued jobs by caller workflow file name and labels, so they move to a `runner_labels` input that the caller sets. | Follow-up D |
| `ci.yml`, `ci-terminal-wake.yml` | `pi-auto-merge.yml` passed to `workflow-dispatch.mjs` | A caller-layer file name, matching `.agent-harness.json` `workflows.mergeGate`. | Follow-up D |
| `scripts/pi-run-stage.mjs` | `.pi/default-model`, `tests/acceptance_probes/manifest.json` (read from the trusted control checkout) | Project-layer files at conventional paths: no project name and no product import. Making the paths configurable belongs with the `AGENT_HARNESS_DIR` seam, which also changes how the control checkout is located. | Follow-up C |
| `scripts/pi-common/implementation-planner.mjs` | `src/`, `tests/` | A Python src-layout heuristic that no-ops when either directory is missing. It is language convention, not product coupling. | Follow-up C (read `checks.packageRoots.canonicalRoots`) |
| `run-check.mjs`, `product-checks.mjs`, `ruff-spec.mjs`, `validation-ledger.mjs`, `coding-session-validation.mjs` | `python_compile`, `ruff`, `pytest`, `node_test` check kinds; `pyproject.toml` as the Ruff config | A built-in language pack for Python and Node projects. It runs tools against whatever repository it is pointed at and imports nothing from it. Which checks run is already project config (`checks.final`, `checks.profiles`). | Not planned; a language-pack registry only if a third language arrives |
| `run-check-docker-backend.mjs`, `model-trace-proxy.mjs` | `127.0.0.1:17343`, `127.0.0.1` | Loopback addresses of components the harness itself starts (trusted executor, trace proxy). The executor URL is already overridable (`RUN_CHECK_EXECUTOR_URL`). | Not planned |
| `.pi/settings.json` (stay) | `./scripts/pi-subagent-response-budget.mjs`, `./scripts/pi-planner-evidence.mjs` | Project config pointing at harness extensions by repository-relative path. | Follow-up C |
| `infra/github-runner-autoscaler/**`, `infra/zoekt/**` | `/opt/social-mcp`, Docker labels `social-mcp.pi-runner` / `social-mcp.run-check`, volume names `social-mcp-*`, `GITHUB_REPOSITORY` / `PI_ZOEKT_REPOSITORY` defaults `YuriiSokolenko/social-mcp`, `/home/yurasik/zoekt-social-mcp`, `n150/*` image tags | Live deployed infra. Renaming Docker labels or volumes would orphan running containers and evidence volumes, and the issue excludes infra changes from this step. Every value except the Docker labels, `/opt/social-mcp` and the Zoekt clone URL is already an environment override. | Follow-up B (one coordinated redeploy) |
| `PI_*` environment variables, `PI_METRIC` lines, `pi-*` file names, `pi:*` labels, `pi/issue-*` branches | Historical Pi naming | Compatibility: open issues and PRs carry the labels and branches, and the usage collector and autoscaler read the names. Label and branch names already come from `.agent-harness.json`. | Follow-up G (after cutover) |

## Inventory

The table is generated from `layers.json`. Directory entries (ending in `/`) are data-only trees and are listed with their file counts.

### Move to the harness repository

<details><summary><b>Harness core scripts</b> — layer <code>harness-core</code>, 54 files</summary>

`scripts/pi-architect-plan-validator.mjs`, `scripts/pi-architect.mjs`, `scripts/pi-auto-merge.mjs`, `scripts/pi-common/accepted-mutation-scope.mjs`, `scripts/pi-common/agent-change-policy.mjs`, `scripts/pi-common/automation-control.mjs`, `scripts/pi-common/candidate-revision.mjs`, `scripts/pi-common/control-plane-policy.mjs`, `scripts/pi-common/diagnostics-artifact.mjs`, `scripts/pi-common/finalize-product-tree.mjs`, `scripts/pi-common/git.mjs`, `scripts/pi-common/github-api.mjs`, `scripts/pi-common/github-state.mjs`, `scripts/pi-common/implementer-result.mjs`, `scripts/pi-common/issue-context.mjs`, `scripts/pi-common/issue-publication.mjs`, `scripts/pi-common/issue-worktree.mjs`, `scripts/pi-common/mutation-journal.mjs`, `scripts/pi-common/planner-request-budget.mjs`, `scripts/pi-common/pr-guard.mjs`, `scripts/pi-common/pr-labels.mjs`, `scripts/pi-common/prepare-environment.mjs`, `scripts/pi-common/process.mjs`, `scripts/pi-common/product-checks.mjs`, `scripts/pi-common/project-config.mjs`, `scripts/pi-common/queue-context.mjs`, `scripts/pi-common/recovery-policy.mjs`, `scripts/pi-common/repair-publication.mjs`, `scripts/pi-common/result-jsonl.mjs`, `scripts/pi-common/review-state.mjs`, `scripts/pi-common/ruff-spec.mjs`, `scripts/pi-common/run-check-docker-backend.mjs`, `scripts/pi-common/run-check.mjs`, `scripts/pi-common/runtime-failure.mjs`, `scripts/pi-common/stage-config.mjs`, `scripts/pi-common/stage-run-contract.mjs`, `scripts/pi-common/stage-validation-recovery.mjs`, `scripts/pi-common/state-machine.mjs`, `scripts/pi-common/task-metadata.mjs`, `scripts/pi-common/terminal-receipt.mjs`, `scripts/pi-common/validation-ledger.mjs`, `scripts/pi-common/workflow-dispatch.mjs`, `scripts/pi-dispatcher.mjs`, `scripts/pi-issue-reconcile.mjs`, `scripts/pi-issue-summary.mjs`, `scripts/pi-labels.mjs`, `scripts/pi-post-merge.mjs`, `scripts/pi-reconcile.mjs`, `scripts/pi-review-result.mjs`, `scripts/pi-run-stage.mjs`, `scripts/pi-transition.mjs`, `scripts/pi-triage.mjs`, `scripts/pi-usage-collect.mjs`, `scripts/pi-usage-summary.mjs`

</details>

<details><summary><b>Pi adapter scripts</b> — layer <code>adapter-pi</code>, 45 files</summary>

`scripts/pi-agent-runtime.mjs`, `scripts/pi-architect-result-tool.mjs`, `scripts/pi-bash-timeout.mjs`, `scripts/pi-common/bash-timeout-policy.mjs`, `scripts/pi-common/coding-session-capability.mjs`, `scripts/pi-common/coding-session-input.mjs`, `scripts/pi-common/coding-session-outcome.mjs`, `scripts/pi-common/coding-session-validation.mjs`, `scripts/pi-common/implementation-planner.mjs`, `scripts/pi-common/main-prompt-observability.mjs`, `scripts/pi-common/main-tool-profile.mjs`, `scripts/pi-common/model-trace-proxy.mjs`, `scripts/pi-common/mutation-snapshot.mjs`, `scripts/pi-common/mutation-target.mjs`, `scripts/pi-common/package-root-check.mjs`, `scripts/pi-common/pi-stage-backend.mjs`, `scripts/pi-common/planner-orbit.mjs`, `scripts/pi-common/progress-controller.mjs`, `scripts/pi-common/provider-wire-policy.mjs`, `scripts/pi-common/repo-search.mjs`, `scripts/pi-common/restored-work.mjs`, `scripts/pi-common/runtime-steering.mjs`, `scripts/pi-common/runtime-tool-guidance.mjs`, `scripts/pi-common/safe-edit.mjs`, `scripts/pi-common/semantic-loop-guard.mjs`, `scripts/pi-common/session-state.mjs`, `scripts/pi-common/structural-edit.mjs`, `scripts/pi-common/structured-subagent.mjs`, `scripts/pi-common/terminal-recovery-controller.mjs`, `scripts/pi-common/terminal-session-binding.mjs`, `scripts/pi-common/terminal-tool.mjs`, `scripts/pi-common/usage-ledger.mjs`, `scripts/pi-common/worktree-baseline.mjs`, `scripts/pi-common/worktree-recovery.mjs`, `scripts/pi-common/zoekt-search.mjs`, `scripts/pi-dispatcher-result-tool.mjs`, `scripts/pi-implementer-bootstrap.mjs`, `scripts/pi-implementer-result-tool.mjs`, `scripts/pi-implementer-skill-index.mjs`, `scripts/pi-log-filter.mjs`, `scripts/pi-planner-evidence.mjs`, `scripts/pi-repair-result-tool.mjs`, `scripts/pi-reviewer-result-tool.mjs`, `scripts/pi-subagent-response-budget.mjs`, `scripts/pi-triage-result-tool.mjs`

</details>

<details><summary><b>mini-swe adapter scripts</b> — layer <code>adapter-mini-swe</code>, 1 files</summary>

`scripts/pi-common/mini-swe-stage-backend.mjs`

</details>

<details><summary><b>Workflows (body moves; a thin caller stays, see consumption model)</b> — <code>extraction.move.workflows</code>, 14 entries</summary>

`.github/workflows/ci-terminal-wake.yml`, `.github/workflows/control-runner-watch.yml`, `.github/workflows/pi-architect.yml`, `.github/workflows/pi-auto-merge.yml`, `.github/workflows/pi-automation-control.yml`, `.github/workflows/pi-dispatcher.yml`, `.github/workflows/pi-issue-agent.yml`, `.github/workflows/pi-pr-fix.yml`, `.github/workflows/pi-pr-review.yml`, `.github/workflows/pi-reconcile.yml`, `.github/workflows/pi-review-invalidate.yml`, `.github/workflows/pi-triage.yml`, `.github/workflows/pi-usage.yml`, `.github/workflows/verify-run-check-beelink.yml`

</details>

<details><summary><b>Harness tests</b> — <code>extraction.move.tests</code>, 100 entries</summary>

`tests/ci/pi-implementer-typebox-schema-contract.test.mjs`, `tests/harness-boundary.test.mjs`, `tests/helpers/fake-github-preload.mjs`, `tests/helpers/fake-github.mjs`, `tests/helpers/reconcile-fake-github.mjs`, `tests/helpers/orchestration-coverage.mjs`, `tests/helpers/orchestration-scenarios.mjs`, `tests/helpers/resolved-source.mjs`, `tests/n150_docker_upgrade/test_transaction.py`, `tests/pi-accepted-mutation-scope.test.mjs`, `tests/pi-active-tool-guidance.test.mjs`, `tests/pi-architect-e2e.test.mjs`, `tests/pi-architect-plan-validator.test.mjs`, `tests/pi-architect.test.mjs`, `tests/pi-auto-merge-e2e.test.mjs`, `tests/pi-auto-merge-recovery.test.mjs`, `tests/pi-auto-merge.test.mjs`, `tests/pi-bash-timeout.test.mjs`, `tests/pi-candidate-revision.test.mjs`, `tests/pi-coding-session-capability.test.mjs`, `tests/pi-coding-session-input.test.mjs`, `tests/pi-coding-session-outcome.test.mjs`, `tests/pi-coding-session.test.mjs`, `tests/pi-coding-tool-truncation.test.mjs`, `tests/pi-control-plane-scenarios.test.mjs`, `tests/pi-dispatcher-e2e.test.mjs`, `tests/pi-dispatcher.test.mjs`, `tests/pi-git.test.mjs`, `tests/pi-implementation-planner-bootstrap.test.mjs`, `tests/pi-implementer-skill-index.test.mjs`, `tests/pi-implementer-submit-result-contract.test.mjs`, `tests/pi-implementer-terminal-transport.test.mjs`, `tests/pi-issue-publication-gate.test.mjs`, `tests/pi-issue-summary.test.mjs`, `tests/pi-log-filter.test.mjs`, `tests/pi-main-prompt-observability.test.mjs`, `tests/pi-main-tool-profile-runtime.test.mjs`, `tests/pi-main-tool-profile.test.mjs`, `tests/pi-model-trace.test.mjs`, `tests/pi-mutation-journal.test.mjs`, `tests/pi-mutation-snapshot.test.mjs`, `tests/pi-orchestration-edges.test.mjs`, `tests/pi-orchestration-faults.test.mjs`, `tests/pi-orchestration-flow.test.mjs`, `tests/pi-orchestration-mutants.test.mjs`, `tests/pi-planner-evidence.test.mjs`, `tests/pi-planner-orbit-new-files.test.mjs`, `tests/pi-planner-orbit-symlink.test.mjs`, `tests/pi-post-merge.test.mjs`, `tests/pi-preparation-fallback.test.mjs`, `tests/pi-progress-controller.test.mjs`, `tests/pi-provider-returned-tool-contract.test.mjs`, `tests/pi-provider-tool-boundary.test.mjs`, `tests/pi-provider-tool-recovery.test.mjs`, `tests/pi-provider-wire-policy.test.mjs`, `tests/pi-publication-candidate.test.mjs`, `tests/pi-queue-context.test.mjs`, `tests/pi-reconcile-observability.test.mjs`, `tests/pi-reconcile-pr-recovery.test.mjs`, `tests/pi-recovery-policy.test.mjs`, `tests/pi-result-jsonl.test.mjs`, `tests/pi-review-ci-contract.test.mjs`, `tests/pi-review-failure.test.mjs`, `tests/pi-review-result.test.mjs`, `tests/pi-reviewer-text-terminal.test.mjs`, `tests/pi-run-check.test.mjs`, `tests/pi-run-stage.test.mjs`, `tests/pi-runtime-steering.test.mjs`, `tests/pi-runtime-tool-guidance.test.mjs`, `tests/pi-safe-edit.test.mjs`, `tests/pi-searxng-preflight.test.mjs`, `tests/pi-semantic-loop-guard.test.mjs`, `tests/pi-session-state-runtime.test.mjs`, `tests/pi-session-state.test.mjs`, `tests/pi-shared-workflow-helpers.test.mjs`, `tests/pi-state-machine.test.mjs`, `tests/pi-structural-edit.test.mjs`, `tests/pi-structured-subagent-usage.test.mjs`, `tests/pi-subagents-planner-terminal-patch.test.mjs`, `tests/pi-terminal-receipt.test.mjs`, `tests/pi-terminal-recovery-controller.test.mjs`, `tests/pi-terminal-result.test.mjs`, `tests/pi-transition.test.mjs`, `tests/pi-triage-e2e.test.mjs`, `tests/pi-triage.test.mjs`, `tests/pi-usage-collect.test.mjs`, `tests/pi-usage-ledger.test.mjs`, `tests/pi-usage-summary.test.mjs`, `tests/pi-validation-ledger.test.mjs`, `tests/pi-worktree-recovery.test.mjs`, `tests/pi-zoekt-search.test.mjs`, `tests/prepare-environment.test.mjs`, `tests/product-checks.test.mjs`, `tests/project-config.test.mjs`, `tests/run-check-docker-executor.test.mjs`, `tests/test_beelink_update_restart.sh`, `tests/test_run_check_sandbox_exec.py`, `tests/test_runner_autoscaler.sh`, `tests/tool-call-boundary-probe.test.mjs`, `tests/workflow_smoke/test_expense_report.py`

</details>

<details><summary><b>Runner and search infrastructure</b> — <code>extraction.move.infra</code>, 27 entries</summary>

`infra/github-runner-autoscaler/.env.example`, `infra/github-runner-autoscaler/.gitignore`, `infra/github-runner-autoscaler/README.md`, `infra/github-runner-autoscaler/check-pi-searxng-mcp.mjs`, `infra/github-runner-autoscaler/compose.yaml`, `infra/github-runner-autoscaler/control-runner-entrypoint.sh`, `infra/github-runner-autoscaler/control-runner.Dockerfile`, `infra/github-runner-autoscaler/lsp-mcp-server-wrapper.mjs`, `infra/github-runner-autoscaler/manager.Dockerfile`, `infra/github-runner-autoscaler/manager.sh`, `infra/github-runner-autoscaler/model-status-samples/tensorfold-2026-10-10.md`, `infra/github-runner-autoscaler/patch-pi-mcp-adapter.mjs`, `infra/github-runner-autoscaler/pi-models-add-swift.py`, `infra/github-runner-autoscaler/patch-pi-subagents-planner-terminal.mjs`, `infra/github-runner-autoscaler/run-check-executor.mjs`, `infra/github-runner-autoscaler/run-check-sandbox-exec.py`, `infra/github-runner-autoscaler/run-check-sandbox-probe.py`, `infra/github-runner-autoscaler/run-check-sandbox.Dockerfile`, `infra/github-runner-autoscaler/worker-entrypoint.sh`, `infra/github-runner-autoscaler/worker-general.Dockerfile`, `infra/github-runner-autoscaler/worker.Dockerfile`, `infra/zoekt/compose.yaml`, `infra/zoekt/repo.meta.json`, `infra/zoekt/update-index.sh`, `scripts/beelink-update-restart.sh`, `scripts/orbit-context-preflight.sh`, `scripts/upgrade-n150-docker-client.sh`

</details>

<details><summary><b>Default role contracts (no product content)</b> — <code>extraction.move.prompts</code>, 3 entries</summary>

`agents/AGENTS.md`, `agents/merger/AGENTS.md`, `agents/triage/AGENTS.md`

</details>

<details><summary><b>Harness documentation</b> — <code>extraction.move.docs</code>, 11 entries</summary>

`scripts/README.md`, `scripts/pi-common/README.md`, `docs/agent-harness/` (4 files), `docs/llm-research/` (5 files), `docs/infra/ORBIT_ROLLOUT_CODEX.md`, `docs/pi-model-traces.md`, `docs/github-actions-logs.md`, `docs/beelink-update-restart.md`, `docs/ISSUE_430_INFRA_RECOVERY.md`, `docs/releases/v0.1.0-workflow-smoke-report.md`, `tasks/README.md`

</details>

<details><summary><b>Research tools and generated artifacts</b> — <code>extraction.move.research</code>, 3 entries</summary>

`scripts/research/README.md`, `scripts/research/tool-call-boundary-probe.mjs`, `reports/` (356 files)

</details>

<details><summary><b>Workflow smoke fixtures</b> — <code>extraction.move.fixtures</code>, 1 entries</summary>

`examples/workflow-smoke/` (8 files)

</details>

### Split

| File | How it splits |
| --- | --- |
| `.github/workflows/ci.yml` | Product jobs `test` and `docker` stay; harness jobs `harness` and `harness-images` move as one block and become a reusable-workflow call. `wake-merge-gate` is the harness continuation and moves with them. |
| `README.md` | The product checks section stays; the harness checks section moves to the harness README. |
| `docs/CI_RULES.md` | Everything except the product CI paragraph describes the harness pipeline and moves; the product CI paragraph is duplicated in README.md. |
| `.github/ISSUE_TEMPLATE/task.md` | The harness ships the canonical task template; GitHub reads templates only from the consuming repository, so the project keeps a copy. |
| `tests/ci/test_workflow_integrity.py` | A generic workflow parse/script-reference check. Each repository keeps its own copy for its own workflows. |
| `agents/dispatcher/AGENTS.md` | The role contract moves as a harness default; the product name line stays as a project overlay. |
| `agents/architect/AGENTS.md` | The role contract moves as a harness default; the product name line stays as a project overlay. |
| `agents/implementer/AGENTS.md` | The role contract moves as a harness default; product identity and the "no production social APIs" rule stay as a project overlay. |
| `agents/repair/AGENTS.md` | The role contract moves as a harness default; product identity and the Python skill routing stay as a project overlay. |
| `agents/reviewer/AGENTS.md` | The role contract moves as a harness default; the FastAPI/MCP review rules and Python skill routing stay as a project overlay. |
| `.pi/agents/implementation-planner.md` | The subagent definition moves as a harness default; the product name line stays as a project overlay. |
| `.gitignore` | The `.pi/cache/` entry belongs to the harness; every other entry is product. |

### Stay in the product repository

| File | Why it stays |
| --- | --- |
| `.agent-harness.json` | Project config (layer 3): the harness reads it, the project owns it. |
| `.pi/default-model` | Project config: the default model alias for this repository. |
| `.pi/repomap.json` | Project config: the repo-map budget for this repository. |
| `.pi/settings.json` | Project config. It names harness extension paths (`./scripts/pi-*.mjs`), which must become harness-relative at cutover (EXTRACTION.md, stage 3). |
| `.mcp.json` | Project config: the MCP servers available to agent sessions in this repository. |
| `.lsp-mcp.json` | Project config: the language servers for this repository. |
| `.agents/skills/` (64 files) | The project skill library; the harness indexes whatever skills the project ships. |
| `docs/skills-sources.md` | Provenance of the project skill library. |
| `tests/acceptance_probes/manifest.json` | The project's trusted acceptance probes (product module targets); the harness reads them at a conventional path. |
| `tests/acceptance_probes/test_acceptance_probes.py` | Runs the project's trusted acceptance probes against product modules. |
| `pyproject.toml` | No harness content: harness CI jobs install their own tools and do not install the product package. |

Notes:

- `src/social_mcp/diagnostics/smoke_*.py` and `tests/diagnostics/test_smoke_*.py` were produced by harness smoke runs (#427) but are product code with product tests now, so they **stay** and are outside the scope. The trusted probes that target them (`tests/acceptance_probes/`) stay with the project for the same reason.
- `.agents/skills/` stays because skills are the project's choice. `pi-implementer-skill-index.mjs` indexes whatever skills the consuming project ships.

## Repository variables, secrets, labels and runners the harness requires

| Kind | Name | Used by | Configured in |
| --- | --- | --- | --- |
| Repository variable | `PI_AUTOMATION_MODE` (name from `.agent-harness.json` `automation.modeVariable`) | `if:` gates of `pi-architect`, `pi-dispatcher`, `pi-auto-merge`, `pi-issue-agent`, `pi-reconcile`, `pi-pr-fix`, `pi-pr-review`, `pi-triage` | GitHub repository settings → Variables; written by `pi-automation-control.yml` |
| Repository secret | `PI_CONTROL_TOKEN` | `pi-automation-control.yml` (writes the mode variable; `GITHUB_TOKEN` cannot) | GitHub repository settings → Secrets |
| Workflow token | `GITHUB_TOKEN` (`github.token`) | Every stage, with per-workflow `permissions:` | Implicit |
| Host secret | `GH_ADMIN_TOKEN` | Autoscaler manager: runner registration and queued-job polling | `infra/github-runner-autoscaler/.env` on the N150 host |
| Host settings | `GITHUB_REPOSITORY`, `WORKFLOW_FILES`, `GENERAL_WORKFLOW_FILES`, `RUNNER_LABELS`, `GENERAL_RUNNER_LABELS`, `CONTROL_RUNNER_LABELS`, `MODEL_STATUS_URL`, `MODEL_MAX_CONCURRENCY`, `PI_HOME_HOST`, `PI_ZOEKT_URL`, `PI_ZOEKT_REPOSITORY`, `RUN_CHECK_*`, image tags | Autoscaler pools and the trusted run_check executor | `infra/github-runner-autoscaler/.env` (see `.env.example`) |
| Model endpoint | `.agent-harness.json` `model.baseUrl` / `PI_MODEL_BASE_URL`; Pi provider config `~/.pi/agent/models.json` (`PI_AGENT_CONFIG_DIR`) | `pi-run-stage.mjs` | Project config; Pi home on the runner host (`PI_HOME_HOST`) |
| Issue labels | `dispatcher:ready`, `triage:ready`, `pi:ready`, `pi:running`, `pi:mr-created`, `pi:needs-human`, `pi:blocked`, `architect:ready`, `architect:epic` | State machine | Names in `.agent-harness.json` `labels`; created idempotently by `scripts/pi-labels.mjs` and stage scripts (`ensureLabel`) |
| PR labels | `review:passed`, `review:changes-requested` | Reviewer, Merge Gate, PR Fix | Names in `.agent-harness.json` `labels`; created when the reviewer first applies them |
| Runner labels | `[self-hosted, linux, x64, n150, pi-agent]` (7 workflows), `[self-hosted, linux, x64, n150, general]` (`ci.yml` test/harness/harness-images/docker, `pi-auto-merge`, `pi-reconcile` ×2, `pi-usage`), `[self-hosted, n150, control]` (`ci.yml` wake-merge-gate, `ci-terminal-wake`, `pi-automation-control`), `ubuntu-latest` (`control-runner-watch`, `pi-review-invalidate`) | Job placement | Workflow `runs-on` (caller); runner registration labels in the autoscaler `.env` |
| Branches | `dev` (default), `pi/issue-<n>`, `pi/issue-<n>-checkpoint` | Publication, merge, reconciliation | `.agent-harness.json` `git` |

## Target repository layout

```
agent-harness/
  .github/workflows/
    dispatcher.yml architect.yml implementer.yml reviewer.yml repair.yml   # on: workflow_call
    merge-gate.yml reconcile.yml triage.yml usage.yml automation-control.yml
    review-invalidate.yml ci-wake.yml control-runner-watch.yml
    harness-ci.yml                       # on: workflow_call — today's ci.yml `harness` + `harness-images` jobs
    self-test.yml                        # the harness repo's own CI
  core/                                  # layers.json harness-core
  adapters/pi/  adapters/mini-swe/       # layers.json adapter-*
  prompts/AGENTS.md prompts/<role>/AGENTS.md   # default role contracts (move + split "prompts")
  templates/ISSUE_TEMPLATE/task.md  templates/agent-harness.example.json
  schema/agent-harness.schema.json
  infra/runner-autoscaler/ infra/zoekt/
  tests/  docs/  research/  reports/  fixtures/workflow-smoke/
```

The consuming repository keeps `.agent-harness.json`, `.pi/`, `.mcp.json`, `.lsp-mcp.json`, `.agents/skills/`, `agents/<role>/AGENTS.md` **overlays** (project-specific lines only), `tests/acceptance_probes/`, `.github/ISSUE_TEMPLATE/task.md`, and one thin caller workflow per role. The callers keep today's file names (`pi-issue-agent.yml`, …) because the autoscaler watches queued runs by caller file name.

### Role prompts and project overrides

The harness ships `prompts/AGENTS.md` and `prompts/<role>/AGENTS.md`. `stage-config.mjs` composes: harness shared contract → harness role contract → **project overlay** `<agents.promptsDir>/<role>/AGENTS.md` if present → untrusted task data → trusted run context. Overlays may add product rules (identity, "never call production social APIs", review rules, skill routing). They cannot remove harness invariants, because the harness text is composed first and is control plane in the harness repository. (Follow-up A.)

## Consumption model: reusable workflows, pinned by tag

**Chosen:** each role is a reusable workflow (`on: workflow_call`) in the harness repository. The consumer calls it from a thin caller and pins a version:

```yaml
# social-mcp/.github/workflows/pi-issue-agent.yml (caller, project-owned)
on:
  workflow_dispatch: { inputs: { issue: { required: true }, model: { default: default } } }
concurrency: { group: pi-issue-${{ inputs.issue }}, cancel-in-progress: false }
permissions: { contents: write, issues: write, pull-requests: write, actions: write }
jobs:
  implementer:
    if: vars.PI_AUTOMATION_MODE == 'RUNNING'
    uses: <owner>/agent-harness/.github/workflows/implementer.yml@v0.1.0
    with:
      harness_ref: v0.1.0
      default_branch: dev
      runner_labels: '["self-hosted","linux","x64","n150","pi-agent"]'
      issue: ${{ inputs.issue }}
      model: ${{ inputs.model }}
    secrets: inherit
```

The callee checks out the consumer at `default_branch` into `GITHUB_WORKSPACE` (where `.agent-harness.json` is read, as today) and the harness at `harness_ref` into `AGENT_HARNESS_DIR`, then runs `node "$AGENT_HARNESS_DIR/core/…"`.

**Why reusable workflows:**

- Stages are multi-job workflows with `runs-on`, `permissions`, `concurrency`, `timeout-minutes` and artifacts. A **composite action** can hold none of these, so every caller would re-declare the orchestration and drift.
- **Copying** files has no version pin and no single place to fix a bug. The current setup is effectively a copy, and its failure mode is the drift this task removes.
- Reusable workflows keep triggers, `vars.*` gates, concurrency groups and permissions in the caller, where GitHub requires them anyway. The callee's permissions can only narrow the caller's. The concurrency group must not be repeated in the callee.

**Pinning:** `uses: …@vX.Y.Z` pins the workflow YAML, and the `harness_ref` input pins the scripts checkout. They must be equal: `harness-ci.yml` in the harness repository asserts that the scripts checkout ref matches the tag it was called at, and release notes give both. Pinning a commit SHA is also allowed (both values become the SHA). Upgrading is a one-line PR per caller, which the harness can open itself.

**Open questions to verify with a smoke before cutover (follow-up D):** that `vars.*` in the callee resolves against the caller repository, and the access settings needed if the harness repository is private (Settings → Actions → Access).

## Migration plan

Each stage is one PR (or one infra change) and leaves the pipeline working on `dev`. No stage depends on a later one for safety.

| # | Stage | Done when | Rollback |
| --- | --- | --- | --- |
| 0 | **This PR (#710).** Boundary manifest, enforcement tests, model/CI config extraction, `ci.yml` / README / CI_RULES split. | CI green on `dev`; one full Pi issue run completes on `dev`. | Revert the PR. All values are unchanged, so revert is behaviour-neutral. |
| 1 | **A: prompt overlays.** Harness default contracts plus project overlays; product lines move into overlays. | Composed prompts are byte-identical before and after (golden test). | Revert. `stage-config.mjs` falls back to single-file composition. |
| 2 | **B: infra literals.** Neutral, env-driven defaults for `/opt/<name>`, Docker labels, volumes and Zoekt paths. The current values are set explicitly in the N150 `.env`. | Autoscaler redeployed; runner churn, run_check and Zoekt smoke pass. | Redeploy the previous manager and runner image tags with the previous `.env`; the labels and volumes it expects still exist because B keeps the old values in `.env`. |
| 3 | **C: `AGENT_HARNESS_DIR` seam.** Scripts resolve harness files from `AGENT_HARNESS_DIR` (default: the module's own checkout, i.e. today). Project files (`.pi/default-model`, acceptance manifest, `.pi/settings.json` extension paths, planner source roots) come from config. | Pipeline green with `AGENT_HARNESS_DIR` unset **and** set to a second checkout of the same commit. | Unset `AGENT_HARNESS_DIR`; the default path is today's behaviour. |
| 4 | **D: reusable workflows in-repo.** Move each `pi-*.yml` body to `.github/workflows/harness-<role>.yml` (`on: workflow_call`) and make `pi-*.yml` a thin caller using `uses: ./.github/workflows/harness-<role>.yml`. Smoke `vars.*` resolution. | Full pipeline smoke (dispatch → implement → review → merge) on a throwaway issue. | Revert the caller PR. Bodies are unchanged, so it returns to inline workflows. |
| 5 | **E: create the harness repository.** Fresh-start import of the **move** and harness halves of **split** files at a recorded `social-mcp` SHA, laid out as above, with its own `self-test.yml`. Tag `v0.1.0`. | Harness self-test green. | Nothing in `social-mcp` changed; archive the repository. |
| 6 | **F: cut over.** Callers switch `uses: ./…` → `<owner>/agent-harness/…@v0.1.0` and `harness_ref: v0.1.0`; `ci.yml` harness jobs → `harness-ci.yml@v0.1.0`. **The in-repo copies stay** in this PR. Runner labels, `PI_AUTOMATION_MODE`, `PI_CONTROL_TOKEN`, label names and `WORKFLOW_FILES` are unchanged because caller file names are unchanged. | Two consecutive full pipeline smokes green on the pinned harness. | Revert the caller PR (one commit). In-repo copies are still present and current. |
| 7 | **F2: delete moved files** from `social-mcp`, a separate PR once stage 6 has been stable for a week of real runs. `layers.json` shrinks to the project-side manifest. | Product CI green; boundary test updated to "no harness files present". | Revert the deletion PR; stage 6 callers are unaffected. |
| 8 | **G: renames** (`pi-*` → role names, `AGENT_METRIC` alongside `PI_METRIC`) inside the harness repository, released as `v0.2.0`. | Consumers upgrade by bumping the tag. | Stay on `v0.1.x`. |

**History:** stage 5 uses a fresh start that records the source SHA in its first commit message, not `git filter-repo`. The harness files have heavy rename and move history interleaved with product commits; a filtered history would be large and misleading for `blame`, and the full history stays readable in `social-mcp` at the recorded SHA. If maintainers later want `blame` continuity, `git filter-repo --paths-from-file` with the move list from `layers.json` can still be run against that SHA; the decision does not block any stage.

**Runner cutover order:** runners are registered to the **repository**, and workflow placement depends only on caller `runs-on` labels and file names. Stages 4–7 therefore need no runner, label or secret change. If the harness repository later runs its own self-test on self-hosted runners, it gets a separate, disjoint label pool, registered after stage 5 and never shared with `social-mcp`.

## Follow-up tasks (drafted, not filed)

These are ready to paste as issues. They are **not filed and must not be labelled executable** until a maintainer approves each one; filing them unlabelled would make them visible to the manual Triage agent.

<details><summary><b>A — [P2] Harness default role contracts with project overlays</b></summary>

```md
## Task metadata
Priority: P2
Depends on: [#710]

## Goal
Role prompts are composed from harness default contracts plus optional project overlays, so `agents/**` can split along the extraction boundary.

## Acceptance criteria
- [ ] `stage-config.mjs` composes harness shared → harness role → optional `<agents.promptsDir>/<role>/AGENTS.md` overlay → task data → run context, each exactly once.
- [ ] Product-specific lines (Social MCP identity, production-API rule, FastAPI/MCP review rules, Python skill routing) live only in overlays.
- [ ] A golden test proves the composed prompt for every role is byte-identical before and after.
- [ ] An overlay cannot remove or reorder harness text (test).
- [ ] `layers.json` reclassifies the five split `agents/*/AGENTS.md` files and `.pi/agents/implementation-planner.md`.
- [ ] PR states control-plane files changed and need human review.
```
</details>

<details><summary><b>B — [P2] Neutral, env-driven names in runner infrastructure</b></summary>

```md
## Task metadata
Priority: P2
Depends on: [#710]

## Goal
`infra/github-runner-autoscaler/**` and `infra/zoekt/**` contain no repository name, product path or product-named Docker label; every value comes from the host `.env`.

## Acceptance criteria
- [ ] `/opt/social-mcp` → `${HARNESS_ROOT:-/opt/agent-harness}` in manager image, `manager.sh` and `run-check-executor.mjs`.
- [ ] Docker labels `social-mcp.pi-runner` / `social-mcp.run-check` and volume names come from env, with the current values set explicitly in the N150 `.env`.
- [ ] Zoekt clone URL, repository name and root path come from env.
- [ ] `GITHUB_REPOSITORY` and `PI_ZOEKT_REPOSITORY` have no repository default (fail closed when unset).
- [ ] `tests/test_runner_autoscaler.sh` covers the env overrides.
- [ ] Rollout and rollback commands are in the runner README; redeploy is one coordinated change.
- [ ] `harness-boundary.test.mjs` extends the product/repository-name check to `infra/**`.
```
</details>

<details><summary><b>C — [P2] AGENT_HARNESS_DIR seam and config-located project files</b></summary>

```md
## Task metadata
Priority: P2
Depends on: [#710]

## Goal
Harness scripts can run from a checkout separate from the project checkout.

## Acceptance criteria
- [ ] `AGENT_HARNESS_DIR` (default: the module's own checkout) locates harness files; `GITHUB_WORKSPACE` stays the project checkout.
- [ ] `.pi/default-model`, the trusted acceptance manifest and planner source/test roots are read from `.agent-harness.json` (with today's paths as the committed values).
- [ ] `.pi/settings.json` extension paths resolve against `AGENT_HARNESS_DIR`.
- [ ] Pipeline tests pass with `AGENT_HARNESS_DIR` unset and set to a second checkout.
- [ ] The "remaining hardcoded values" table in EXTRACTION.md shrinks accordingly.
```
</details>

<details><summary><b>D — [P2] Reusable role workflows inside social-mcp</b></summary>

```md
## Task metadata
Priority: P2
Depends on: [C]

## Goal
Every `pi-*.yml` and the `ci.yml` harness jobs are thin callers of local `workflow_call` workflows.

## Acceptance criteria
- [ ] `harness-<role>.yml` (`on: workflow_call`) holds each body; callers keep triggers, `concurrency`, `permissions`, `vars.*` gates and file names.
- [ ] Inputs: `harness_ref`, `default_branch`, `runner_labels`, role inputs; `secrets: inherit`.
- [ ] No `ref: dev`, `branches: [dev]` or `runs-on` label literal remains in callee files (test).
- [ ] A smoke proves `vars.PI_AUTOMATION_MODE` resolves against the caller.
- [ ] One full pipeline smoke (dispatch → implement → review → merge) on a throwaway issue is green.
- [ ] The autoscaler `WORKFLOW_FILES` lists need no change (caller names unchanged).
```
</details>

<details><summary><b>E — [P2] Create the agent-harness repository</b></summary>

```md
## Task metadata
Priority: P2
Depends on: [A, B, D]

## Goal
A standalone harness repository with the layout in EXTRACTION.md, tagged `v0.1.0`.

## Acceptance criteria
- [ ] Fresh-start import of every `move` entry and the harness half of every `split` entry from `layers.json` at a recorded social-mcp SHA.
- [ ] Layout matches EXTRACTION.md (core/, adapters/, prompts/, templates/, schema/, infra/, tests/, docs/).
- [ ] `self-test.yml` runs the harness tests without any product checkout.
- [ ] `schema/agent-harness.schema.json` matches `project-config.mjs` validation.
- [ ] `harness-ci.yml` asserts that `harness_ref` equals the called tag.
- [ ] Tag `v0.1.0` with release notes listing the pinned values.
```
</details>

<details><summary><b>F — [P2] Switch social-mcp to the pinned harness</b></summary>

```md
## Task metadata
Priority: P2
Depends on: [E]

## Goal
social-mcp runs the pipeline from `agent-harness@v0.1.0`, then deletes its in-repo copies.

## Acceptance criteria
- [ ] PR 1: callers use `<owner>/agent-harness/...@v0.1.0` with `harness_ref: v0.1.0`; in-repo copies untouched.
- [ ] Two consecutive full pipeline smokes are green on the pinned harness.
- [ ] Rollback (revert PR 1) is rehearsed once on a throwaway branch.
- [ ] PR 2 (after a week of real runs): delete moved files; `layers.json` becomes the project-side manifest; boundary test asserts no harness file remains.
- [ ] Runner labels, secrets, `PI_AUTOMATION_MODE`, label names and autoscaler `.env` are unchanged (checklist in PR body).
```
</details>

<details><summary><b>G — [P3] Role-neutral names in the harness repository</b></summary>

```md
## Task metadata
Priority: P3
Depends on: [F]

## Goal
Rename `pi-*` scripts and workflows to role names and emit role-neutral metrics, without breaking consumers.

## Acceptance criteria
- [ ] Role-named entry points; `pi-*` kept as thin re-exports for one minor version.
- [ ] `AGENT_METRIC` emitted alongside `PI_METRIC`; the collector accepts both.
- [ ] Released as `v0.2.0` with an upgrade note; consumers stay on `v0.1.x` until they bump.
```
</details>

## Verification for this step

See the PR description for the commands run and their results, including failures that also occur on clean `dev` locally (named, not hidden).
