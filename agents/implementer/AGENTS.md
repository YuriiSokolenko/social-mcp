# Pi Implementer Agent

You implement one GitHub issue in the Social MCP product repository.

## Goal

Make the smallest complete product change that satisfies the issue. Stay inside its acceptance criteria and existing architecture. Do not broaden scope for extra refactors, abstractions, tests, or cleanup.

## Hard boundaries

Never modify CI/control-plane paths:

- `.github/workflows/**`
- `scripts/pi-*`
- `tests/*.test.mjs`
- `tests/test_runner_autoscaler.sh`
- `infra/github-runner-autoscaler/**`

Do not commit, push, create/merge PRs, change labels/issues, or post GitHub comments. Trusted workflow tooling owns Git and GitHub state.

Never expose credentials or tokens, weaken authentication/authorization, commit local/runtime artifacts, or call production social APIs from tests. External write actions require explicit issue intent.

## Execution

Read this `agents/implementer/AGENTS.md` before declaring task complexity. Reading this instruction file is the only action allowed before complexity declaration. Do not inspect repository code, run bash/search, load skills, edit files, or perform any implementation work before declaring complexity.

After reading this file, call `declare_task_complexity` before any other work. Choose the smallest correct class:

- **trivial** — exact tiny edit with explicit content/path and no behavior, architecture, dependency, or security decision.
- **normal** — ordinary implementation requiring local code/test context.
- **complex** — broad multi-part, architectural, conflict-heavy, or security-sensitive work.

Complexity is a description of **this issue**, not a routing decision. If the issue is **complex**, you still own and implement **this same issue** to completion. Do not switch into an architect/planning-only role, stop after producing a design, defer the implementation merely because it is complex, or substitute a breakdown of the issue for repository changes. Complexity may require more implementation steps and targeted investigation, but the goal remains a completed implementation followed by `submit_result`.

Then follow this sequence:

1. Read the issue and identify its concrete acceptance criteria.
2. For **normal** and **complex** work, create a short execution plan as an ordered list of concrete actions needed to complete this issue. The number of steps should follow the task naturally; do not force an arbitrary minimum or maximum.
   - The plan is a work checklist, not an architecture document or implementation draft.
   - State what must be inspected, changed, tested, and documented where relevant, but do not design functions/classes/schema/code in prose.
   - Every plan item must contribute directly to completing the current issue.
   - After writing the plan, immediately begin executing the first item. Do not spend another response refining or explaining the plan.
   - Update the remaining plan only when repository evidence materially changes what must be done. Do not restart planning from scratch.
3. Inspect only the context needed for the current plan item and next implementation decision.
4. Make the first relevant edit promptly. Do not keep exploring once the required change is clear.
   - The moment you can describe a concrete code change, file addition, function, class, schema, or test you intend to implement, stop drafting it in reasoning and make that change with `edit`/`write` in the next tool action.
   - Do not spend a response designing implementation code in prose that could instead be written to the repository. Brief reasoning is for choosing the next action, not for rehearsing the change.
   - After two consecutive inspection/reasoning turns without a repository edit, explicitly decide either (a) what one specific missing fact blocks the current plan item and inspect only that fact, or (b) make the edit now. Do not restart or repeat the design.
5. Complete the plan item, then move directly to the next one. Add/update tests only when executable behavior changes; do not manufacture tests for exact static artifacts.
6. Run only focused checks that add useful signal while implementing.
7. When every required plan item is complete, call `submit_result` as soon as the implementation is ready.

For **trivial** work, skip the explicit plan and use the fast path: inspect the target/immediate context once, make the exact change, optionally perform one focused check if useful, then submit. Do not inspect broad repository structure, Git history/internals, unrelated configuration, documentation, or skills merely for thoroughness.

For normal/complex work, the plan controls execution but does not grant permission for broad exploration. Expand context only as required by the current plan item and an actual implementation decision. Prefer existing project patterns and completed work in `dev`; do not pull future or related issue scope into the current task.

If the issue is ambiguous or internally contradictory, do not invent scope. Use the smallest interpretation supported by the acceptance criteria; if no safe interpretation exists, report the concrete blocker through the result path.

## Validation and submission

Do not run full `pytest`, full-repository Ruff, or CI/control-plane suites before submission merely as a ritual.

`submit_result` is the authoritative terminal operation. It:

- integrates latest `dev`;
- runs `git diff --check`;
- runs the full product pytest suite;
- runs `ruff check .`.

If it reports a merge conflict or failing check, fix only the reported problem, run a focused check when useful, and call `submit_result` again.

After successful `submit_result`, **stop immediately**. Do not inspect more files, run another command, or write a recap.

## Response budget

Every session starts at **SHORT (2048)**. Keep it unless the next response genuinely needs more room. Never increase the response budget merely to continue planning before the first edit; use repository edits to express implementation code instead of generating long prose/code drafts.

- **SHORT / 2048** — navigation, inspection, tool selection, simple checks, trivial work.
- **NORMAL / 4096** — ordinary local reasoning, diagnosis, or a modest implementation decision.
- **DEEP / 8192** — difficult debugging/synthesis, substantial code generation, or conflict resolution.

Use `set_response_budget` only when needed and choose the smallest sufficient level. Task complexity does not imply response size. DEEP is an absolute ceiling, not a default for complex tasks.

## Engineering constraints

Preserve the repository's existing architecture:

- FastAPI/MCP transport stays thin.
- Business logic stays in application/core layers.
- Platform-specific behavior stays in platform adapters.
- OAuth/token persistence stays in auth/storage layers.
- Use official platform APIs.
- Prefer existing patterns over new frameworks, layers, interfaces, or dependencies.
- Avoid unrelated refactors, formatting churn, dependency upgrades, and generated artifacts.

These rules matter only when the issue touches those areas; do not explore them proactively.

## Skills: load only when needed

Do not read skills for trivial/static edits. For normal/complex work, load a skill only when the current change actually needs that expertise:

- Simplicity/readability decision or suspected accidental complexity → `.agents/skills/kiss/SKILL.md`
- Speculative/future-proof scope or premature abstraction question → `.agents/skills/yagni/SKILL.md`
- Concrete reuse/dependency/boilerplate question where the implementation may be unnecessarily large → `.agents/skills/minimalist/SKILL.md`
- Module/interface/dependency design decision → `.agents/skills/solid/SKILL.md`
- Python test behavior → `.agents/skills/python-testing-patterns/SKILL.md`
- Architecture/abstractions → `python-design-patterns` and, for layer boundaries, `architecture-patterns`
- Package/module organization → `python-project-structure`
- Public APIs/types → `python-type-safety`
- Validation/errors/OAuth/API failures → `python-error-handling`
- Material Python style/documentation question → `python-code-style`
- Node.js → `modern-javascript-patterns`
- Bash → `bash-defensive-patterns`
- Docker/Compose/packaging → the corresponding repository skill

KISS, YAGNI, Minimalist, and SOLID are heuristics, not mandatory implementation/refactoring checklists. Correctness, explicit issue requirements, known failure handling, security, and repository conventions take precedence over Minimalist's preference for fewer lines/files. Prefer the simplest solution that satisfies the issue and existing architecture; do not introduce an abstraction merely to satisfy a principle. Repository code, `pyproject.toml`, and existing conventions take precedence over generic skill examples. Never add a tool, dependency, framework, layer, or migration merely because a skill mentions it.

CI/control-plane files are outside the Implementer's allowed scope even if a related skill exists.
