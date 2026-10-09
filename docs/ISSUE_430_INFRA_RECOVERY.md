# Historical incident findings: smoke-pack infrastructure and recovery (#430)

> **Historical incident report, not current recovery instructions.** For deployed N150 quarantine/evidence/recovery behavior, use [the runner/autoscaler README](../infra/github-runner-autoscaler/README.md) and current manager scripts.

## Evidence and root-cause limits

PR #415, CI run [37069737717, attempt 2](https://github.com/YuriiSokolenko/social-mcp/actions/runs/37069737717/attempts/2),
shows successful Buildx/BuildKit initialization (containerd worker, overlayfs
snapshotter), followed by `failed to retrieve container list: rw layer snapshot not
found` for container `37d2be901d24abae3f37d471a9a531d45331a6b8da459ac8d395b89a06a84761`.
The error occurs in the BuildKit setup diagnostic block before Compose starts.
The product test job passed. The job metadata and reproduced diagnostic failure
remain infrastructure failures under Merge Gate's existing classification.

This proves inconsistent daemon container/snapshot metadata, but does not prove
that commit 10b9969 or ephemeral cleanup created it. The repository uses `--rm`
for workers and Docker API cleanup, not direct snapshot-directory removal.
Historical host journals/containerd state are needed to identify whether shutdown,
external storage cleanup or daemon lifecycle caused the lost snapshot. The patch
does not claim a live N150 storage repair or a real corruption reproduction.
PR #410's failed setup is separately covered by job-metadata classification; its
unavailable historical log cannot establish the same root cause.

## Runtime contract and recovery

- Coding-session registration intersects the configured tools with the executable
  registry, including tools temporarily hidden by action policy.
- Tool-surface logs use the actual list returned after `setActiveTools`; provider
  schemas are filtered against that list. Hidden tools remain governed by the
  existing evidence/mutation state machine.
- Executor `Tool ... not found` errors abort as `PI_TOOL_CONTRACT_FAILURE` with
  infrastructure provenance. A private per-fork artifact propagates that failure
  to the parent before it can consume another coding session. Workflow messages
  use fixed trusted text, preserving the provenance file's advisory status.
- Planner timeout is 45 seconds rather than 120 seconds (with the existing 5-second
  transport grace). Timeout still falls back without retrying the planner. This
  bounds the observed delay; it does not assert an unobserved model-server cause.
  After deployment, compare `PI_PREPARATION_FALLBACK` timeout frequency and planner
  latency with the previous baseline; slow-model deployments may need a longer
  deadline. Keep the fallback and its bounded evidence budget intact.
- `recover_worktree` deletes one untracked regular file or restores a regular file
  from HEAD, including staged changes/deletion. It refuses symlinks, hard links,
  ignored files, directories, embedded repositories, escapes and Git/ignore-policy
  mutation. Each successful cleanup appends a mutation record to the validation
  ledger and immediately compares the changed-file set with `expected_files`.
  A mismatch returns the remaining changed files so another direct cleanup can
  finish. Recovery records never count as passing product checks.
- #438 bounds `delete_untracked` by ownership evidence. The runtime records the
  run-start untracked set once (`PI_WORKTREE_BASELINE_FILE`, exclusive create, shared by
  parent and fork). A path is deletable only if it is absent from that baseline, not
  journaled (use `undo_mutation`), not in the accepted scope and not a control-plane
  path; otherwise the call is refused with a code (`recovery_preexisting_path`,
  `recovery_baseline_unavailable`, `recovery_use_undo_mutation`,
  `recovery_accepted_scope_path`, `recovery_protected_path`). `revert_tracked` also
  refuses control-plane, journaled and run-start-dirty paths, and additionally requires the
  current bytes to equal the post-state the runtime observed right after a bounded `bash`
  call (`<baseline>.observed.json`). A path that changed between observed actions is tainted
  permanently (`recovery_externally_modified`); an unobserved change is
  `recovery_unobserved_change`. A file-set mismatch lists each remaining path in
  `file_set.drift` as `journaled`, `unjournaled_restorable`, `unjournaled_cleanable`
  or `unknown`, with the exact action to call.
- Known `.probe.txt`/`.probe2.txt` and `.pi-tmp-*` artifacts cannot enter fresh,
  restored or repair result metadata. Existing exact file-set checks continue to
  reject other undeclared files at submission and publication.

The #399 two-file recovery requires two direct tool calls, no new coding session,
no shell, and no ignore changes. #396's placeholder cannot become a successful
candidate even when restored/repair metadata would otherwise derive from the diff.
Focused-check sandbox permissions, read-only workspace and disabled network remain
unchanged; there is no new unrestricted shell fallback.
