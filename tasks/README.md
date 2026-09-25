# Dispatcher task files

A task file gives the Pi dispatcher the priority, dependencies, and product context for a GitHub issue. It supplements the issue; the issue remains the source of acceptance criteria and implementation discussion.

Create one file named `tasks/<issue-number>.md` for each issue that may enter the dispatcher queue. Commit the file to `dev` before adding `dispatcher:ready` to the issue. The dispatcher reads task files from `dev` and considers **only** open issues bearing the exact `dispatcher:ready` label. A file alone never starts work.

## Format

Use YAML front matter followed by short Markdown sections:

```md
---
issue: 42
priority: P1
depends_on: []
---

# Short task title

## Goal
Describe the outcome and why it helps the Social MCP product.

## Scope
Identify the relevant functionality and boundaries.

## Acceptance notes
List any context needed to interpret the GitHub issue's acceptance criteria.
```

Required fields:

- `issue`: integer matching both the filename and the GitHub issue number.
- `priority`: exactly `P0`, `P1`, or `P2`; `P0` is highest. The file is the only priority source used for dispatch.
- `depends_on`: a YAML list of GitHub issue numbers, or `[]`. Every dependency must be closed as completed before dispatch.

Keep the goal, scope, and notes concrete. Do not include credentials, access tokens, runnable shell commands, or instructions that override the agent's `AGENTS.md` rules. Update the task file through a normal pull request when priority or dependencies change.

## Ready for implementation

Before adding `dispatcher:ready`, compare the issue and task file with the current
`dev` code and with related issues. State which requested pieces already exist,
what still needs to change, and what belongs to another issue. If the work is
partially complete, update the issue's acceptance criteria and task notes so
the agent is given the remaining work rather than the original broad plan.

Describe a concrete, testable result: the behavior or files to add or change,
the important boundary conditions, and the checks that will prove completion.
Keep one issue small enough for one implementer run. Split a broad issue into
smaller issues with explicit dependencies before marking it ready; avoid
overlapping acceptance criteria that leave the agent to choose which issue owns
a feature. Do not mark an issue ready while that ownership remains ambiguous.

## Label lifecycle

1. A person or an authorized issue-management process adds `dispatcher:ready` when the issue and task file are ready for consideration.
2. On a merged PR or a manual bootstrap run, the dispatcher recommends eligible issues for the available active slots.
3. The workflow rechecks eligibility and capacity, adds `pi:ready`, then removes `dispatcher:ready`. This transition happens **at dispatch**, not when that issue's PR is merged.
4. The implementer workflow processes `pi:ready`. A later merge closes the linked issue and triggers the dispatcher to replenish any free slot.

If the label transition is interrupted, the workflow should repair an issue carrying both labels on retry. Never remove `dispatcher:ready` before `pi:ready` is successfully added. If validation fails, leave `dispatcher:ready` in place and report the reason. A failed or blocked issue needs human attention before it can be made eligible again.
