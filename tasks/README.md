# Generated Dispatcher task snapshots

GitHub Issues are the only source of truth for task priority, dependencies, scope, and acceptance criteria.

Every pipeline issue starts with:

```md
## Task metadata
Priority: P1
Depends on: [#12, #18]
```

Use `Depends on: []` when there are no prerequisites. Priority is exactly `P0`, `P1`, or `P2`.

Dispatcher reloads GitHub issues on every run and reads this metadata directly. No per-issue task files are generated or maintained.

The canonical authoring template is `.github/ISSUE_TEMPLATE/task.md`.
