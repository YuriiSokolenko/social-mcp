---
name: repomap-navigation
description: Architect-only navigation skill for narrowing an unclear repository area before exact code inspection.
metadata:
  version: 1.1.0
---

# Repo Map Navigation

Use this skill only in **Architect**. Implementer does not load the `pi-repomap` extension; its routing is LSP for known symbols, indexed/current-worktree search for literal/path discovery, Orbit for structural questions, and direct `read` for authoritative source.

The map is a navigation hint, never authoritative source text.

## Trigger

Use RepoMap only when Architect needs a compact reading order because the likely subsystem is unclear or several modules could plausibly own the requested behavior. Skip it when the issue or existing evidence already identifies the next file or symbol.

## Workflow

1. Read the injected repository map already present in Architect context.
2. Choose at most **3 likely files** or **1 likely subsystem** tied directly to the architecture question.
3. If one candidate needs structural detail, call `repomap outline <file>` at most once.
4. Move to authoritative evidence: exact source `read`, semantic navigation, indexed/literal search, or Orbit when a graph relationship is the actual question.
5. Stop using RepoMap once the architecture decision has enough evidence.

## Evidence contract

- verify exact source text before relying on it;
- use Orbit for precise dependency/blast-radius claims;
- do not infer correctness from ranking or centrality;
- do not use RepoMap repeatedly for reassurance.
