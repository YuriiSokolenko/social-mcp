# Subagent Tool Delegation Policy

Research date: **2026-09-28**.

## Purpose

This document records the proposed boundary between the main Pi coding agent and its subagents.

The main goal is to keep raw repository exploration, long tool output, logs, and repeated read-only inspection out of the main agent context. The main agent should retain ownership of the task, decisions, repository mutations, and terminal result.

Core principle:

> **Main acts. Subagents gather facts.**

A stricter operational formulation:

> **The main agent does not read repository context directly. It asks a subagent for the repository knowledge it needs.**

This applies even when the missing context is only one small file immediately before an edit.

## Always delegate to a subagent

The following work should be delegated whenever repository/tool access is needed for it.

### Repository reads

- Read any repository file, including one small file needed immediately before an edit.
- Read several related files.
- Extract only the signatures, constants, contracts, types, or behavior needed for the current decision.
- Read configuration files.
- Read existing tests.
- Read project documentation.
- Read repository skills and return only the rules relevant to the current task.

The subagent should return a compact answer rather than raw file contents whenever possible.

Example:

Instead of the main agent reading `FooRepository`, it asks:

> Read `FooRepository` and return only the signatures and behavior needed to implement X.

### Code search and navigation

Delegate:

- `grep` / `rg`;
- symbol/usages search;
- TODO/FIXME search;
- search for similar implementations;
- search for relevant tests;
- `find`;
- `ls`;
- locating a module, adapter, config, interface, or implementation;
- bounded inspection of a directory.

### Existing-pattern research

Delegate questions such as:

- How is X already implemented in this repository?
- Which interface is normally used for Y?
- Which layer owns this behavior?
- Which of several existing implementations is the closest pattern?
- Is there already a helper/abstraction that should be reused?

The main agent should receive the conclusion, relevant paths/symbols, and only the evidence necessary to make the next decision.

### Logs and diagnostics

Delegate:

- CI logs;
- runtime logs;
- test output;
- stack traces;
- long exception chains;
- failed-command output;
- comparison of repeated failures.

Preferred return shape:

1. root cause;
2. evidence;
3. affected path/symbol;
4. recommended next action.

### Focused verification

Delegate read-only or verification-oriented commands such as:

- focused `pytest`;
- focused lint checks;
- focused type checks;
- compile/check commands for the affected area;
- diagnostic scripts;
- analysis of the resulting failures.

The subagent reports the result to the main agent. It does not turn a failed check into an unbounded investigation.

### Read-only Git inspection

Delegate:

- `git diff`;
- `git show`;
- `git log` when history is genuinely required;
- branch/diff inspection;
- determining where a relevant change was introduced;
- comparison with current `dev`.

This does not grant permission to mutate Git state.

### PR/review analysis

For Reviewer-like work, subagents may inspect independent parts of a PR, for example:

- production code;
- tests;
- API/schema/config changes;
- focused behavioral concerns.

The main Reviewer remains responsible for synthesizing findings and making the final review decision.

### External technical research

Delegate narrow research into:

- library/API documentation;
- signatures and behavior of a dependency;
- migration notes;
- version-specific behavior;
- known failure modes relevant to the current task.

The result should answer a concrete question, not produce broad background research unless the task explicitly requires it.

### Post-change inspection

Delegate:

- reading the resulting diff;
- checking whether changed code appears to satisfy acceptance criteria;
- detecting obvious omissions;
- inspecting focused verification output.

The subagent reports findings. It does not take ownership of the task.

## May be delegated

The default direction is to delegate all repository reading and investigation. Some higher-level analysis can also be delegated when useful, but ownership stays with the main agent.

Examples:

- compare two or three implementation approaches already present in the repository;
- isolate the cause of a difficult bug;
- analyze one independent portion of a large PR;
- verify whether a proposed edit matches an existing project convention;
- investigate one exact architectural question and report evidence.

These should be bounded questions with a concrete expected result.

## Never delegate

The main agent retains ownership of the task lifecycle and all authoritative state-changing decisions.

Do not delegate:

- ownership of the GitHub issue;
- final interpretation of the issue;
- final acceptance criteria;
- top-level execution plan;
- `declare_task_complexity`;
- final architecture/implementation decision for the issue;
- `edit`;
- `write`;
- conflict resolution;
- `submit_result`;
- commit;
- push;
- merge;
- PR creation or mutation;
- labels;
- comments;
- workflow dispatch;
- other GitHub or external state mutations.

Subagents may provide evidence that informs these actions, but the main agent performs and owns them.

## Intended execution model

```text
Main
  |
  |-- read AGENTS.md
  |-- receive issue / acceptance criteria
  |-- create top-level plan
  |-- declare task complexity
  |
  |-- need repository fact?
  |       |
  |       +--> Subagent
  |              |-- read
  |              |-- grep / rg
  |              |-- find / ls
  |              |-- focused bash/check
  |              |-- docs / skills / git inspection
  |              |
  |              +--> compact factual result
  |
  |-- make implementation decision
  |-- edit / write
  |-- repeat bounded fact requests as needed
  |-- submit_result
```

The main context should therefore contain primarily:

- issue requirements;
- execution plan;
- compact facts returned by subagents;
- implementation decisions;
- mutations;
- focused verification conclusions;
- terminal result.

It should not contain large quantities of raw repository content or exploratory tool output.

## Delegation granularity

Delegate a **question or research objective**, not a mechanical tool call.

Bad:

> Run grep for `OAuthClient`.

Better:

> Find the existing OAuth token refresh pattern. Inspect only relevant files and return the reusable functions/types, their paths, and any constraints that affect this change.

One bounded subagent task may absorb many internal `read`, `grep`, `find`, or diagnostic calls while returning only the useful result to the main context.

## Guard against over-delegation

Moving exploration to subagents must not replace one failure mode with another.

Rules:

- A subagent request must answer one concrete question.
- Do not launch a subagent when the needed fact is already available in the main context.
- Do not ask multiple subagents the same question unless conflicting evidence requires independent verification.
- Do not delegate ownership of a plan item merely because the item is complex.
- Do not let subagents recursively create an uncontrolled research tree.
- Return concise conclusions and references rather than raw transcripts.
- The main agent must proceed to mutation once it has enough evidence for the next concrete edit.

The objective is not to maximize subagent use. The objective is to keep exploratory context isolated while preserving forward progress.

## Expected benefits

This design is intended to reduce:

- main-context growth from raw file reads;
- repeated repository inspection;
- long reasoning chains caused by large tool outputs;
- loss of task state after compaction;
- accidental re-reading of already inspected context;
- reasoning loops where the model keeps gathering information instead of editing.

It also makes the main trajectory easier to reason about:

```text
issue -> plan -> compact facts -> edits -> verification -> submit_result
```

rather than:

```text
issue -> read -> grep -> read -> bash -> read -> reasoning
      -> more grep -> more read -> compaction -> rediscovery -> ...
```

## Status

This is a **research/design conclusion**, not yet a normative runtime or agent rule.

Implementation should be handled separately by updating the relevant agent prompts/runtime/tool permissions and validating the behavior on dedicated test issues.
