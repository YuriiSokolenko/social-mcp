# Agent harness: layers and extraction plan

The agent automation (dispatcher, architect, implementer, reviewer, repair, merge gate, reconciler) is being prepared to move into a standalone, agent-agnostic harness repository. **Nothing has moved yet.** This document records the seams that make the move mostly packaging.

## Four layers

| # | Layer | Where it lives now | Rule |
|---|-------|--------------------|------|
| 1 | Harness core | `docs/agent-harness/layers.json` → `harness-core` | No project identity, default branch, label, workflow-file or path literals. Reads policy via `project-config.mjs`. |
| 2 | Agent adapters | `layers.json` → `adapter-pi`, `adapter-mini-swe` | Pi-/mini-swe-specific runtime, tools and log formats. The boundary is `StageRunSpec`/`StageRunResult`, not Pi. |
| 3 | Project config | `.agent-harness.json`, `agents/`, `.pi/` | Default branch, branch names, labels, workflow names, control-plane paths, check commands, environment steps, prompts dir, PR validation lines, git identity. |
| 4 | Infra config | workflow `runs-on`, repo variables/secrets, `infra/github-runner-autoscaler/` | Runner labels, model endpoints/provider, secrets, concurrency, autoscaling. |

`tests/harness-boundary.test.mjs` enforces that every script is classified exactly once and that core/mini-swe scripts contain no `social-mcp`, no configured label or workflow name, and no `origin/dev`/`'dev'` literal.

## Project config (`.agent-harness.json`)

JSON (Node has no YAML parser and the control plane has no dependencies; a YAML front-end is a packaging step). Loaded by `scripts/pi-common/project-config.mjs`, validated strictly (unknown keys rejected, commands are fixed argv, never shell strings), **fails closed** (no built-in defaults). Search order: `AGENT_HARNESS_CONFIG` → `$GITHUB_WORKSPACE/.agent-harness.json` (trusted control checkout) → walking up from the module. The process cwd is never searched: agent sessions run in writable worktrees. The file itself is always a protected control-plane path, so an agent cannot widen its own permissions.

## Model-facing agent contracts

Model-driven stages receive one composed initial prompt:

1. `agents/AGENTS.md` — shared stable invariants for runtime authority, workflow ownership, safety, and terminal behavior.
2. `agents/<role>/AGENTS.md` — only role-specific behavior.
3. Trusted per-run context from the harness — issue/PR/worktree/runtime facts that can change between runs.

`scripts/pi-common/stage-config.mjs` injects the shared and role contracts exactly once. Agents do not read either contract file as a startup step. Dynamic state stays in runtime state, tool availability, tool results, and short state-specific steers rather than being copied into static prompt prose.

When static examples and the current tool surface disagree, runtime state and the exposed tool surface win. Tests in `tests/pi-progress-controller.test.mjs` enforce prompt composition and key transition consistency.

## pi-* occurrence audit

- **Genuinely Pi-specific (stays in the Pi adapter):** `pi-agent-runtime.mjs`, `pi-stage-backend.mjs`, `pi-*-result-tool.mjs` (Pi tool registration), `pi-log-filter.mjs`, `PI_METRIC`/`PI_TASK` stdout lines, Pi provider/base-URL forcing, `.pi/` settings.
- **Generic behaviour with a historical Pi name (rename at extraction, behaviour unchanged):** `pi-issue-agent.yml` (implementer), `pi-pr-review.yml` (reviewer), `pi-pr-fix.yml` (repair), `pi-dispatcher.yml`, `pi-architect.yml`, `pi-triage.yml`, `pi-auto-merge.yml`, `pi-reconcile.yml`, `pi-transition.mjs`, `pi-run-stage.mjs`, `pi-common/`, labels `pi:*`, branches `pi/issue-N`, variable `PI_AUTOMATION_MODE`. The names now live in `.agent-harness.json`; only the files themselves keep the old names.
- **Compat kept on purpose:** `PI_*` environment variables and `PI_METRIC` lines (the usage collector and workflows read them), workflow file names (the autoscaler matches queued runs by caller-workflow basename), label and branch names (existing open issues/PRs carry them).

## Remaining extraction work

1. Turn each `pi-*.yml` into a thin caller of a role-named reusable workflow (`implementer.yml`, `reviewer.yml`, …) with `on: workflow_call`, `runner_labels` and `default_branch` inputs and `secrets: inherit`. Keep caller `name`/triggers/`concurrency`/`permissions`/`if: vars.PI_AUTOMATION_MODE…`. Callee permissions can only equal or narrow the caller's; do not reuse a concurrency group in both. Static `ref: dev`, `branches: [dev]` and `runs-on` labels are the remaining literals in workflows.
2. Add an `AGENT_HARNESS_DIR` seam so callee steps run scripts from the harness checkout while `GITHUB_WORKSPACE` stays the target repo (config is read from the target's trusted checkout).
3. Rename `scripts/pi-*.mjs` to role names once workflows call them via the harness path; keep thin re-exports if in-flight branches need them.
4. Backend selection is a two-way branch in `pi-run-stage.mjs` (`pi`, `mini-swe`); introduce a registry only when a third backend exists. Move `forcePiProviderBaseUrl`/model catalog into the Pi adapter at that point.
5. Metrics: add role-neutral `AGENT_METRIC` emission alongside `PI_METRIC` (collector accepting both) before renaming.
6. Orbit/LSP/repo-map setup steps in workflows should become optional inputs.
7. Verify `vars.*` in reusable workflows resolves against the caller repository (assumed, not testable here) with a smoke run.

## Proposed standalone repository layout

```
agent-harness/
  .github/workflows/{dispatcher,architect,implementer,reviewer,repair,merge-gate,reconcile,triage,usage,automation-control}.yml   # on: workflow_call
  core/            # layers.json harness-core (project-config, state-machine, github-api, publication, policy, run-check…)
  adapters/{pi,mini-swe}/
  infra/runner-autoscaler/
  schema/agent-harness.schema.json
  docs/  tests/
```

## Proposed target-repository integration

```yaml
# .github/workflows/agent.yml
jobs:
  implementer:
    uses: <owner>/agent-harness/.github/workflows/implementer.yml@<version>
    with: { runner_labels: '["self-hosted","linux","pi-agent"]' }
    secrets: inherit
```

plus `.agent-harness.json` (see this repository's file), `agents/AGENTS.md`, `agents/<role>/AGENTS.md`, and repository variables/secrets for infra.
