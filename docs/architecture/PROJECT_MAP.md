# Project Architecture Map

This document is the human- and agent-readable text map of the current Social MCP architecture. It describes current dev plus explicitly tracked open work. It is not generated from code and is not a substitute for GitHub issue acceptance criteria.

## Status legend

    DONE     = implemented in current dev
    OPEN     = tracked by an open GitHub issue
    BLOCKED  = cannot proceed until an external condition is satisfied
    EPIC     = grouping issue; implementation belongs to child issues

## Product architecture

    Social MCP
    |
    +-- Interfaces
    |   |
    |   +-- Web Admin / FastAPI
    |   |   +-- Dashboard / Accounts ......................... DONE
    |   |   +-- Admin authentication ......................... DONE
    |   |   +-- Threads OAuth connect/reconnect .............. DONE #16
    |   |   +-- TikTok OAuth connect/reconnect ............... OPEN #79
    |   |
    |   +-- MCP Server
    |       +-- Capability discovery ......................... DONE #18
    |       +-- Threads profile/posts read tools ............. DONE #3
    |       +-- Threads insights ............................. OPEN #4
    |       +-- Threads replies/search/mentions .............. OPEN #5
    |       +-- Threads publishing ........................... OPEN #6
    |       +-- Threads reply/content actions ................ OPEN #71-#74
    |       +-- TikTok profile/video read tools .............. OPEN #21
    |       +-- TikTok draft upload .......................... OPEN #22
    |       +-- TikTok Direct Post ........................... BLOCKED #23
    |
    +-- Shared Application Boundaries
    |   |
    |   +-- Connected-account/application wiring ............. DONE
    |   +-- Capability discovery model ....................... DONE #18
    |   +-- Granted-capability enforcement ................... OPEN #95
    |   +-- External-write intent/safety boundary ............ OPEN #96
    |   +-- Normalized platform errors ....................... DONE #94
    |
    +-- Platform Adapters
    |   |
    |   +-- Threads
    |   |   +-- OAuth authorization/callback ................. DONE #16
    |   |   +-- Token lifecycle / connection status .......... OPEN #17
    |   |   +-- Profile/posts adapter ........................ DONE #3
    |   |   +-- Insights adapter behavior .................... OPEN #4
    |   |   +-- Replies/search/mentions ...................... OPEN #5
    |   |   +-- Publishing/write operations .................. OPEN #6, #71-#74
    |   |
    |   +-- TikTok
    |       +-- OAuth/capability contract .................... DONE #78
    |       +-- OAuth execution through Web Admin ............ OPEN #79
    |       +-- Read operations .............................. OPEN #21
    |       +-- Draft upload ................................. OPEN #22
    |       +-- Direct Post .................................. BLOCKED #23
    |
    +-- Shared Provider Infrastructure
    |   |
    |   +-- HTTP timeout/retry/rate-limit policy ............. DONE #93
    |   +-- Provider error normalization ..................... DONE #94
    |
    +-- Persistence
    |   |
    |   +-- SQLite connected-account storage ................. DONE
    |   +-- Encrypted token-at-rest boundary ................. DONE
    |   +-- Schema versioning / migrations ................... OPEN #97
    |   +-- Backup / restore / recovery ...................... OPEN #98
    |
    +-- Verification
        |
        +-- Unit / adapter / route tests ...................... DONE / ongoing
        +-- Cross-layer MCP -> app -> adapter contracts ....... OPEN #99

## Key product relationships

    AI client
       |
       v
    MCP Server ------------------------------+
       |                                     |
       v                                     |
    Shared application boundaries            |
       |                                     |
       +--> capability enforcement (#95)     |
       +--> write safety (#96)               |
       +--> normalized errors (DONE #94)     |
       |                                     |
       v                                     |
    Platform adapter                         |
       |                                     |
       +--> shared HTTP reliability (DONE #93)
       |
       v
    Official Threads / TikTok API


    Browser
       |
       v
    Web Admin / FastAPI
       |
       +--> OAuth state / token handling
       |        |
       |        v
       |     encrypted persistence
       |        |
       |        v
       +----> SQLite
       |
       +--> connected-account state
                |
                +--> MCP capability + operation decisions

## Pi development pipeline

    GitHub Issue
       |
       v
    Triage
       |
       +-- invalid / unclear / bad AC -----------------------> pi:needs-human
       |
       v
    Dispatcher
       |
       +-- read prepared candidate context
       +-- classify scope
       +-- submit_result
       |
       +-- coherent task ------------------------------------+
       |                                                     |
       +-- genuine decomposition needed --> Architect        |
                                          |                  |
                                          +-- keep -----------+
                                          +-- revise ---------+
                                          +-- split --> child issues --> Dispatcher
                                                               |
                                                               v
                                                         Implementer
                                                               |
                                              +----------------+----------------+
                                              |                                 |
                                              v                                 v
                                   prepare_implementation                 restored work
                                              |                                 |
                                       planner                                  |
                                              |                                 |
                                              v                                 |
                                       EVIDENCE_ALLOWED                          |
                                              |                                 |
                            2 trivial / 6 nontrivial evidence actions           |
                                              |                                 |
                                              v                                 |
                                       ACTION_REQUIRED <-------------------------+
                                        /      |      \
                           need_more_evidence  |       +--> submit_result
                                  |            |
                                  v            +--> safe_edit / edit / write
                          one evidence action          |
                                  |                    |
                                  +----> ACTION_REQUIRED
                                                       |
                                                       v
                                                 submit_result
                                                       |
                                                       v
                                                  Pull Request
                                                       |
                                                       v
                                                    Reviewer
                                                   /        \
                                                PASS       CHANGES_REQUESTED
                                                 |               |
                                                 v               v
                                            Merge Gate         Repair
                                                 ^               |
                                                 |               v
                                                 +----------- Reviewer
                                                 |
                                                 v
                                                dev

## Implementer productive-progress / repository-access hierarchy

    prepare_implementation (single-shot)
       |
       +--> planner infrastructure failure after configured retry
       |      +--> PREPARATION_FALLBACK (no planner output or complexity)
       |             +--> ACTION_REQUIRED (normal scoped budget / mutation / check / submit rules)
       |                    +--> need_more_evidence -> one read/search -> ACTION_REQUIRED
       |
       v
    EVIDENCE_ALLOWED (planner estimate 0-6; fallback 2 trivial / 6 nontrivial)
       |
       +--> known path .......................... read directly
       |
       +--> known source symbol ................. LSP first
       |      +--> cold + language known: lsp_start_server -> lsp_find_symbol
       |      +--> active/unknown-language name lookup: lsp_find_symbol
       |      +--> position-based LSP when file/line is known
       |
       +--> initial literal/path discovery
       |      +--> indexed_repo_search (Zoekt, when configured)
       |      +--> repo_search (current worktree / fallback)
       |
       +--> structural graph question ........... Orbit Local
       |
       +--> historical intent/provenance ......... Git Context MCP
       |
       +--> semantic missing fact after deterministic tools
              +--> scout/advisor
       |
       v
    ACTION_REQUIRED
       |
       +--> safe_edit / edit / write
       |
       +--> delegate_mutation (large already-decided payload)
       |      +--> mutation-writer subagent (16K, no repo tools) -> {operation, path, content}
       |      +--> runtime validates + applies (snapshot / no-op / rollback / run_check permit)
       |
       +--> submit_result
       |
       +--> one concrete fact still missing
               |
               +--> need_more_evidence
                         |
                         +--> exactly one evidence action
                         |
                         +--> ACTION_REQUIRED

## Component ownership

| Area | Status | Owning issue(s) |
| --- | --- | --- |
| Threads profile/posts reads | DONE | #3 |
| Threads insights | OPEN | #4 |
| Threads replies/search/mentions | OPEN | #5 |
| Threads publishing | OPEN | #6 |
| Threads reply/content actions | EPIC / OPEN | #7, #71-#74 |
| Threads token lifecycle | OPEN | #17 |
| TikTok OAuth contract | DONE | #78 |
| TikTok OAuth implementation | OPEN | #79 |
| TikTok reads | OPEN | #21 |
| TikTok draft upload | OPEN | #22 |
| TikTok Direct Post | BLOCKED | #23 |
| Shared HTTP reliability | DONE | #93 |
| Normalized platform errors | DONE | #94 |
| Granted-capability enforcement | OPEN | #95 |
| External-write safety boundary | OPEN | #96 |
| SQLite schema migrations | OPEN | #97 |
| Backup / restore / recovery | OPEN | #98 |
| Cross-layer contract tests | OPEN | #99 |

## Maintenance rule

Update this file in the same PR when a change does at least one of the following:

- adds or removes a high-level product/application/platform/persistence component;
- changes which layer owns a responsibility;
- introduces or removes a meaningful dependency/relationship between architectural components;
- completes or materially changes an architecture-tracked item represented in this map.

Do not update this file for ordinary local implementation changes, bug fixes, refactors, tests, naming changes, or behavior that does not alter the architecture represented above.

When an issue represented here is completed, update its status from OPEN to DONE in the same PR when that PR actually establishes the mapped architectural capability. External conditions remain BLOCKED until they are genuinely satisfied.

Current code and merged behavior remain authoritative. If this map conflicts with dev, correct the map rather than changing code merely to match the document.
