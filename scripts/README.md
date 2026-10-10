# Scripts

Index of the top-level scripts. Everything named `scripts/pi-*` (including
[`pi-common/`](pi-common/README.md)) is protected control-plane code: agents
cannot change it and PRs touching it need human review. The pipeline itself is
described in [Workflow and CI](../docs/CI_RULES.md); the file-level harness
boundary is classified in [`docs/agent-harness/layers.json`](../docs/agent-harness/layers.json).

## Stage entry points (called from workflows)

| Script | Used by | Purpose |
| --- | --- | --- |
| `pi-triage.mjs` | `pi-triage.yml` | `prepare` the open-issue snapshot, `apply` the Triage result. |
| `pi-dispatcher.mjs` | `pi-dispatcher.yml` | `prepare` the queue snapshot, `apply` the Dispatcher classification. |
| `pi-architect.mjs` | `pi-architect.yml` | `prepare`/`publish` Architect decisions (child issues, task-file revisions). |
| `pi-architect-plan-validator.mjs` | `pi-architect.mjs` | Validates an Architect decomposition plan before publication. |
| `pi-run-stage.mjs` | all model stages | Thin model runner: selects backend/model and wires runtime, extensions and the stage result tool. |
| `pi-implementer-bootstrap.mjs` | `pi-common/pi-stage-backend.mjs` | Fresh Implementer session A: hosts the Planner child and writes `PreparedImplementation`, before Main starts. |
| `pi-review-result.mjs` | `pi-pr-review.yml` | Extracts the Reviewer verdict from the Pi JSON log. |
| `pi-auto-merge.mjs` | `pi-auto-merge.yml` | Merge Gate: selects and squash-merges an eligible reviewed PR. |
| `pi-post-merge.mjs` | `ci.yml` (`wake-merge-gate`) | Finalizes the linked issue after green CI on the merged `dev` SHA. |
| `pi-reconcile.mjs` | `pi-reconcile.yml` | Orphan/stranded-ownership recovery after the grace period (`--apply`). |
| `pi-issue-reconcile.mjs` | `pi-dispatcher.yml` (issue closed) | Closes an `architect:epic` parent once all its children are completed. |
| `pi-transition.mjs` | issue/architect workflows | Applies a validated issue state transition plus comment. |
| `pi-labels.mjs` | `pi-issue-agent.yml` | Ensures pipeline labels exist (names from `.agent-harness.json`). |
| `pi-issue-summary.mjs` | `pi-issue-agent.yml` | Writes the issue/PR stage summary to the job summary. |
| `pi-usage-summary.mjs` | model-stage workflows | Summarizes `PI_METRIC` usage for the job. |
| `pi-usage-collect.mjs` | `pi-usage.yml` | Rebuilds the usage CSV from completed workflow job logs. |

## Pi runtime extensions and result tools

Loaded as Pi extensions by `pi-common/pi-stage-backend.mjs` (or, for subagent-only extensions, through `.pi/settings.json`).

| Script | Purpose |
| --- | --- |
| `pi-agent-runtime.mjs` | Runtime policy: tool surface, progress controller, request policy, terminal handling. |
| `pi-log-filter.mjs` | Not an extension: a separate process the backend pipes Pi's JSONL through; renders the Actions log and appends the diagnostics artifact. |
| `pi-bash-timeout.mjs` | Bash tool timeout policy. |
| `pi-implementer-skill-index.mjs` | Implementer Main skill-catalog compaction ([note](../docs/agent-harness/IMPLEMENTER_SKILLS.md)). |
| `pi-planner-evidence.mjs` | Read-only tool gate inside the Planner subagent. |
| `pi-subagent-response-budget.mjs` | Mirrors the parent's response ceiling into selected subagents. |
| `pi-triage-result-tool.mjs`, `pi-dispatcher-result-tool.mjs`, `pi-architect-result-tool.mjs`, `pi-implementer-result-tool.mjs`, `pi-reviewer-result-tool.mjs`, `pi-repair-result-tool.mjs` | Per-stage terminal result tools, selected per stage in `pi-common/stage-config.mjs`. |

## Host and research scripts

| Script | Purpose |
| --- | --- |
| `orbit-context-preflight.sh` | Orbit Local context preflight run by Architect/Implementer workflows ([runner README](../infra/github-runner-autoscaler/README.md#gitlab-orbit-local-for-pi)). |
| `beelink-update-restart.sh` | N150 host update/restart ([guide](../docs/beelink-update-restart.md)). |
| `upgrade-n150-docker-client.sh` | Pins/upgrades the N150 host Docker client packages ([runner README](../infra/github-runner-autoscaler/README.md#n150-setup)). |
| `research/tool-call-boundary-probe.mjs` | Standalone model tool-call boundary probe ([README](research/README.md)). |
