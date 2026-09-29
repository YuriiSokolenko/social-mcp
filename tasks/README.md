# GitHub Issue task metadata

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


## Acceptance criteria rule

Every executable task must contain a `## Acceptance criteria` section with **3–15 concrete, testable list items**.

- Fewer than 3 criteria usually means the task is underspecified.
- More than 15 criteria usually means the task should be narrowed or decomposed.
- Architect revisions and child issues must obey the same 3–15 range.
- Triage must not mark an issue ready when the section is missing or outside the range.
