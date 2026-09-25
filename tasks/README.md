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
Keep one implementation issue small enough for one implementer run. A broad
issue may still enter the queue: the dispatcher sends it to Pi Architect,
which creates smaller issues with explicit dependencies before implementation.
Clarify ambiguous ownership in the parent issue before adding the ready label.

## Label lifecycle

1. A person, or a manually triggered **Pi Triage** run (`agents/triage/AGENTS.md`), adds `dispatcher:ready` when the issue and task file are ready for consideration. Triage instead adds `pi:needs-human` with an explanatory comment when the issue or task file is unclear or incomplete.
2. On a merged PR or a manual bootstrap run, the dispatcher classifies every eligible issue for implementation or decomposition, regardless of runner capacity.
3. For a small issue, the workflow adds `pi:ready`, starts the implementer, then removes `dispatcher:ready`.
4. For a broad issue, the workflow adds `architect:ready`, explicitly starts Pi Architect, then removes `dispatcher:ready`. Architect creates child issues and `tasks/<number>.md` on `dev`, adds `dispatcher:ready` to the children, and explicitly starts the dispatcher. The parent receives `architect:epic` and closes only after all children complete.
5. Each child returns to the dispatcher. If it remains broad, the dispatcher may send it to Architect again; otherwise it follows the implementer, CI, review and merge path. Completed child epics close their parents when every sibling is completed.

If the label transition is interrupted, the workflow should repair an issue carrying both labels on retry. Never remove `dispatcher:ready` before `pi:ready` is successfully added. If validation fails, leave `dispatcher:ready` in place and report the reason. A failed or blocked issue needs human attention before it can be made eligible again.
