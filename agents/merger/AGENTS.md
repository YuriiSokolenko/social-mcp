# Pi Merge Gate

> Reference documentation only. Unlike the other files in `agents/`, this one is not
> loaded as a runtime prompt: Merge Gate has no model-driven stage, so no
> `stage-config.mjs` entry, workflow, or `pi-run-stage.mjs` invocation reads this file.
> It exists to record the contract `.github/workflows/pi-auto-merge.yml` and
> `scripts/pi-auto-merge.mjs` actually implement. Edit `docs/CI_RULES.md` as the
> canonical source and keep this file consistent with it.

## Mission

The merge decision is deterministic and implemented by `.github/workflows/pi-auto-merge.yml` plus `scripts/pi-auto-merge.mjs`. There is no model-driven merge agent. Read `docs/CI_RULES.md` for the canonical contract.

## Required gates

Only consider an open, non-draft PR targeting `dev`, from the same repository, with branch `pi/issue-<positive number>`, whose body closes that same issue. The linked issue must remain open with `pi:mr-created`. The PR must carry `review:passed`.

`pi:needs-human` on either the PR or linked issue blocks automation.

Reject automatic merge for PRs changing any protected control-plane path: `.github/workflows/**`, `.pi/**`, `agents/**`, `scripts/pi-*` (including `scripts/pi-common/**`), `tests/*.test.mjs`, `tests/test_runner_autoscaler.sh`, `infra/github-runner-autoscaler/**`, or the harness config itself (`.agent-harness.json`, `.agent-harness.yml`, `.agent-harness.yaml`), including protected-path renames, or when the complete changed-file list cannot be verified.

Do not require a custom review commit status, pre-merge CI on an exact dev/PR pair, captured dev SHA, or proof that the PR branch contains the current dev tip. Reviewer approves the exact PR HEAD it reviewed; GitHub's merge operation determines whether that approved HEAD can currently merge.

The ordinary PR `CI` run for the current PR head SHA must be green (pending PR CI is skipped; a known product-check failure invalidates the PASS and dispatches PR Fix; infrastructure failures get one automatic retry, then `pi:needs-human`). Push CI for the current `dev` HEAD must also be green immediately before the merge attempt.

Immediately before merge, re-read the PR and use its current head SHA only as optimistic concurrency protection for the squash merge.

## Late conflict

If GitHub reports a merge conflict, remove stale `review:*` labels, dispatch PR Fix, and stop the queue successfully. PR Fix integrates current `dev`, resolves the conflict in its live session, validates the changed tree, pushes a new HEAD, and starts a fresh Reviewer. Merge Gate never resolves conflicts itself.

## Post-merge validation

The authoritative integration check is CI on the actual merged `dev` commit. Green `dev` CI wakes Merge Gate to scan for the next eligible PR; red CI does not. Completed PR CI wakes it through `ci-terminal-wake.yml`. Reconciler is not a normal scheduler: it may issue one state-free Merge Gate wake only for a `review:passed` PR that outlived the PR recovery grace period without its normal PASS handoff.

Merge Gate never merges release PRs from `dev` to `main`.
