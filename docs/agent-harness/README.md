# Agent harness: proposed extraction design (not deployed)

> **Design proposal / non-operational.** The standalone harness and reusable-workflow layout below have **not** been deployed. The live issue pipeline is documented only in [Workflow and CI](../CI_RULES.md); follow current [workflow YAML](../../.github/workflows/) and [harness config](../../.agent-harness.json) for behavior. The layer inventory here is useful for a future extraction, not an independent runtime specification.

The agent automation (dispatcher, architect, implementer, reviewer, repair, merge gate, reconciler) is being prepared to move into a standalone, agent-agnostic harness repository. **Nothing has moved yet.** This document records the seams that make the move mostly packaging.

## Four layers

| # | Layer | Where it lives now | Rule |
|---|-------|--------------------|------|
| 1 | Harness core | `docs/agent-harness/layers.json` → `harness-core` | No project identity, default branch, label, workflow-file or path literals. Reads policy via `project-config.mjs`. |
| 2 | Agent adapters | `layers.json` → `adapter-pi`, `adapter-mini-swe` | Pi-/mini-swe-specific runtime, tools and log formats. The boundary is `StageRunSpec`/`StageRunResult`, not Pi. |
| 3 | Project config | `.agent-harness.json`, `agents/`, `.pi/` | Default branch, branch names, labels, workflow names, control-plane paths, check commands, environment steps, prompts dir, PR validation lines, git identity, model provider/endpoint/catalog (`model`), repairable CI step names (`checks.ciRepairableSteps`). |
| 4 | Infra config | workflow `runs-on`, repo variables/secrets, `infra/github-runner-autoscaler/` | Runner labels, model endpoints/provider, secrets, concurrency, autoscaling. |

`tests/harness-boundary.test.mjs` enforces that every script is classified exactly once, that core and adapter scripts contain no `social-mcp`, no configured label or workflow name, and no `origin/dev`/`'dev'` literal, and the extraction boundary described in [EXTRACTION.md](EXTRACTION.md).

## Project config (`.agent-harness.json`)

JSON (Node has no YAML parser and the control plane has no dependencies; a YAML front-end is a packaging step). Loaded by `scripts/pi-common/project-config.mjs`, validated strictly (unknown keys rejected, commands are fixed argv, never shell strings), **fails closed** (no built-in defaults). Search order: `AGENT_HARNESS_CONFIG` → `$GITHUB_WORKSPACE/.agent-harness.json` (trusted control checkout) → walking up from the module. The process cwd is never searched: agent sessions run in writable worktrees. The file itself is always a protected control-plane path, so an agent cannot widen its own permissions.

`checks.packageRoots` protects src-layout repositories from accidental duplicate top-level Python package roots. `canonicalRoots` lists trusted source roots such as `src`; a top-level directory with the same package name and Python source is treated as a structural error. Repositories that intentionally expose the same package name from multiple roots must list that package in `allowDuplicatePackages`. Because matching is directory-name based, intentional layouts such as both `src/scripts/` and top-level `scripts/` also require that explicit allow-list entry.

## Model-facing agent contracts

Model-driven stages receive one composed initial prompt:

1. `agents/AGENTS.md` — shared stable invariants for runtime authority, workflow ownership, safety, and terminal behavior.
2. `agents/<role>/AGENTS.md` — only role-specific behavior.
3. Untrusted task data when supplied directly to the model, such as an Implementer issue title/body.
4. Trusted per-run context from the harness — runtime/worktree state and trusted context-file locations.

`scripts/pi-common/stage-config.mjs` injects the shared and role contracts exactly once. Agents do not read either contract file as a startup step. Direct user-authored task text is kept outside the trusted runtime block and delimiter-safe. Dynamic state stays in runtime state, tool availability, tool results, and short state-specific steers rather than being copied into static prompt prose.

When static examples and the current tool surface disagree, runtime state and the exposed tool surface win. Tests in `tests/pi-progress-controller.test.mjs` enforce prompt composition and key transition consistency.

## pi-* occurrence audit

- **Genuinely Pi-specific (stays in the Pi adapter):** `pi-agent-runtime.mjs`, `pi-stage-backend.mjs`, `pi-*-result-tool.mjs` (Pi tool registration), `pi-log-filter.mjs`, `PI_METRIC`/`PI_TASK` stdout lines, Pi provider/base-URL forcing, `.pi/` settings.
- **Generic behaviour with a historical Pi name (rename at extraction, behaviour unchanged):** `pi-issue-agent.yml` (implementer), `pi-pr-review.yml` (reviewer), `pi-pr-fix.yml` (repair), `pi-dispatcher.yml`, `pi-architect.yml`, `pi-triage.yml`, `pi-auto-merge.yml`, `pi-reconcile.yml`, `pi-transition.mjs`, `pi-run-stage.mjs`, `pi-common/`, labels `pi:*`, branches `pi/issue-N`, variable `PI_AUTOMATION_MODE`. The names now live in `.agent-harness.json`; only the files themselves keep the old names.
- **Compat kept on purpose:** `PI_*` environment variables and `PI_METRIC` lines (the usage collector and workflows read them), workflow file names (the autoscaler matches queued runs by caller-workflow basename), label and branch names (existing open issues/PRs carry them).

## Extraction plan

The file-level boundary (move / split / stay), remaining justified literals, required variables and secrets, target repository layout, consumption model (reusable workflows pinned by tag) and the staged migration plan with rollback are in [EXTRACTION.md](EXTRACTION.md). `layers.json` is the machine-checked source for that boundary.
