# Implementer Main skill catalog compression — implementation note (#593)

> **Implementation/measurement note, not a live workflow contract.** Issue #593 is closed. For current behavior use the [workflow guide](../CI_RULES.md), `scripts/pi-implementer-skill-index.mjs`, and its tests.

For #593, the Implementer Main `pi` process kept Pi's normal skill discovery and tool registration. Its trusted `pi-implementer-skill-index.mjs` extension uses the supported `before_agent_start` hook to replace only the recognized `<skills>` XML portion of the generated system prompt with a short catalog. All original skill **names** and absolute **SKILL.md locations** remain listed, in discovery order. The summary of each description is limited to 144 characters. Main can still call `read` on any listed file and load its complete content when appropriate; no task-name or language-based filtering is used. Normal Pi skill commands and registration are not disabled.

The same extension, now extended by #685, is loaded explicitly only for the Implementer Main `buildPiInvocation` path. The prompt-less Planner bootstrap is a separate process; #590 owns the `implementation-planner` skill policy. The coding-session child uses its own explicit extension allowlist and `inheritSkills: false`. Reviewer, Architect and all other stages are unchanged.

**Compatibility guard:** the compression only occurs if exactly one Pi `<skills>` section and one `<available_skills>` catalog contain parseable `<skill><name>...<description>...<location>...` entries, with no unrecognized entry text. The parser also requires the number of fully parsed entries to equal the number of opening `<skill>` tags, so a missing `<location>` cannot silently merge two skills. Unrecognized formats, duplicates, empty catalogs or a compression that would increase size preserve the original prompt, rather than risk losing skills or other system content. The hook does not edit project/role contracts, original issue or `planText` handoff, runtime steering, resolved targets, security policy, available tools or tool schemas.

## Follow-on curation — issue #685

Issue #593 originally shortened descriptions but kept all 31 full XML entries. The
Main-only #685 hook now uses the actual Pi `before_agent_start` event's `prompt`
to rank skills by relevant name/topic and list **at most five** task-relevant
summaries in `<available_skills>`. Every other discovered skill remains in
`<skill_discovery_index>` as its original, exact `name<TAB>SKILL.md path`.
This changes prompt advertising only: Pi still registers the complete local and
repository skill set, and a skill path must be inspected using a tool **actually
serialized on that request**. Neither the featured entries nor the index grant
capabilities or override #683/#684 phase restrictions.

Unknown or cross-domain tasks retain all paths in the index; selection is not an
authorization boundary. Malformed, ambiguous and duplicated catalogs fail open.
The hook is unchanged for Planner, Reviewer, Architect and isolated coding sessions.
The selected catalog is stable across Main phase transitions and does not require
one new tool call for discovery. Log `PI_MAIN_SKILLS` gives featured/indexed/total
counts and system-byte savings; provider-boundary `PI_MAIN_PROMPT` also reports
`skillCount` (featured), `indexedSkillCount`, `discoverableSkillCount`,
`skillCatalogBytes`, total system text bytes and request schema size.

### Validation still needed on live Pi

Run the #677 Python smoke (or a disposable equivalent) and a JS/Docker
specialized-skill task. Compare the first and later real outgoing provider
payloads with the 31-entry / 10,398-byte #677 reference. In particular, confirm
that the `before_agent_start` hook's replacement survives Pi's final prompt
composition, no tool is falsely offered by text, the model can inspect an indexed
SKILL.md using an eligible read capability, token counts/cache telemetry are
reported without inventing missing values, and the tasks complete correctly.
Synthetic tests and green CI alone are not live completion evidence.

## Measurement and validation

- **Reference baseline**: issue #583, [run 37772392770](https://github.com/YuriiSokolenko/social-mcp/actions/runs/37772392770), original model trace. The issue reports approximately **15.1 KB** of skill descriptions/listing across **31 skills** in the Main system prompt; this is a reported baseline, not a byte-exact value independently reproduced by this change.
- The unit fixture models 31 long-description skills and asserts at least 35% reduction of the complete system text, with every skill name/location preserved, while covering malformed format, XML escapes, idempotence, other-role gating, and no Planner bootstrap injection. **Synthetic fixture measurements are not live provider measurements.**
- At runtime the hook logs `PI_MAIN_SKILLS` with before/after system bytes, saved bytes, count and catalog names. The existing `PI_MAIN_PROMPT` provider-boundary log includes `systemTextBytes`, `skillCatalogBytes` and `skillCount` for every Main request (without repeating all names), alongside the original fingerprint/contract/tool telemetry. This checks first and later turns independently, rather than trusting source-code projections.
- **Live follow-up required:** collect actual before/after provider traces from an Implementer smoke task and a specialized-skill task (for example, a Docker/CI task). Compare first and later Main system message bytes/tokens, skill names and full `planText` propagation; inspect coding-session requests for unwanted skills and confirm CI/E2E success. Provider token reduction and skill usage in real runs are **not yet measured**. This was the measurement status when the note was written; do not infer the current issue status or live measurements from it.

Trade-off: shortening descriptive text reduces the semantic matching detail available before reading a skill. Skill names, first 144 description characters, and paths remain visible for targeted exploration. If that proves insufficient for a complex task, adjust the conservative description limit using recorded live evidence rather than hiding skills by task category.
