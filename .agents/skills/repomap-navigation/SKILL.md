---
name: repomap-navigation
description: Use when the relevant repository area is unclear and a compact structural reading order is needed before exact search, graph queries, or file reads.
metadata:
  version: 1.0.0
---

# Repo Map Navigation

Use the native `pi-repomap` context and `repomap` tool to narrow repository exploration. The map is a navigation hint, not authoritative source text.

## Trigger

Use this skill only when at least one of these is true:

- the likely target file or subsystem is not known;
- literal search would still be broad or ambiguous;
- several modules could plausibly own the requested behavior;
- a compact first reading order would avoid a scout or broad repository scan.

Skip it when the issue, prepared plan, previous evidence, or an exact search result already identifies the next file or symbol. In particular, a known source-code symbol should bypass RepoMap and go directly to semantic LSP lookup when available.

## Workflow

1. Read the injected repository map already present in context. Do not call `repomap status` merely to prove it exists.
2. Choose at most **3 likely files** or **1 likely subsystem** tied directly to the current question.
3. If one candidate needs structural detail, call `repomap outline <file>` for that file only.
4. Move immediately to the cheapest authoritative next action:
   - semantic LSP lookup when a source symbol is already known by name;
   - `read` when a likely path is known and exact source text is needed;
   - `indexed_repo_search` for literal/path discovery on indexed `dev` when the source symbol/path is not already known;
   - `repo_search` when current-worktree text is authoritative;
   - Orbit Local when imports, dependency direction, blast radius, or another structural relationship remains unresolved after semantic navigation.
5. Stop using the map once a safe next read or mutation target is known.

## Evidence contract

Treat repo-map output as discovery evidence only:

- verify exact source text with `read` before mutation;
- verify current-worktree literals with `repo_search` when freshness matters;
- use Orbit for graph claims that require precise references or dependency direction.

Do not infer implementation correctness from ranking or centrality.

## Budget

Keep navigation bounded:

- candidate files: **max 3**;
- `repomap outline`: **max 1** before the next authoritative read/search;
- no full-map rebuild unless the injected map is clearly stale for the current decision;
- do not call `repomap` repeatedly for reassurance.

A repo-map action counts as repository evidence under the Implementer productive-progress protocol.

## Tool routing

Use the cheapest sufficient layer:

Known source symbol: `semantic LSP → exact read → mutation`.

Unknown repository area/path: `repo map → indexed/literal search → exact read → Orbit if structural proof is needed → scout only if deterministic tools remain insufficient`.

Do not use repo map and scout for the same navigation question unless the map plus deterministic search failed to identify a safe next action.

## Output discipline

Do not narrate the map or list unrelated central files. Carry forward only the smallest useful result: likely path/symbol and why it answers the current navigation question.
