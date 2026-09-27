# Generated Dispatcher task snapshots

GitHub Issues are the only source of truth for task priority, dependencies, scope, and acceptance criteria.

Every pipeline issue starts with:

```md
## Task metadata
Priority: P1
Depends on: [#12, #18]
```

Use `Depends on: []` when there are no prerequisites. Priority is exactly `P0`, `P1`, or `P2`.

Dispatcher reloads GitHub issues on every run and recreates `tasks/*.md` locally in the runner workspace. These files are compatibility snapshots for agents; they must not be maintained by humans, treated as pipeline state, or committed as dependency truth.

The canonical authoring template is `.github/ISSUE_TEMPLATE/task.md`.
