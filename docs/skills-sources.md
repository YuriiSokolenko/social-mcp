# Vendored agent skill sources

Skills under `.agents/skills/` are found by Pi's normal skill discovery
(Implementer Main sees a compacted catalog, and the Planner and coding-session
children do not inherit skills; see
[IMPLEMENTER_SKILLS](agent-harness/IMPLEMENTER_SKILLS.md)). They are reference
methods; `agents/AGENTS.md`, the role overlays under `agents/<role>/AGENTS.md`,
and repository policy control what an agent may do.

## Upstream skills

The source column records the pinned upstream location as written in the
skill itself (or, for the first three, in this index). Each directory carries
the upstream license unless noted.

| Local skill | Upstream pinned source | License |
| --- | --- | --- |
| `breakdown-epic-arch/` | [github/awesome-copilot @ 6c4d33b](https://github.com/github/awesome-copilot/blob/6c4d33b9cfca967a28bb2962ef4d55e4a384c88c/skills/breakdown-epic-arch/SKILL.md) | MIT, `LICENSE.txt` |
| `breakdown-test/` | [github/awesome-copilot @ 6c4d33b](https://github.com/github/awesome-copilot/blob/6c4d33b9cfca967a28bb2962ef4d55e4a384c88c/skills/breakdown-test/SKILL.md) | MIT, `LICENSE.txt` |
| `writing-plans/` | [obra/superpowers @ 5bf4e78](https://github.com/obra/superpowers/blob/5bf4e78011075bcfc0dc295f0724994cd123ee71/skills/writing-plans/SKILL.md) | MIT, `LICENSE.txt` |
| `github-actions-hardening/`, `multi-stage-dockerfile/` | github/awesome-copilot @ 1f56440 (URL at the end of each `SKILL.md`) | MIT, `LICENSE.txt` |
| `mcp-release-qa/` | github/awesome-copilot, blob `3d42ef3` (adapted; see its "Source and license" section) | MIT, embedded in `SKILL.md` |
| `architecture-patterns/`, `bash-defensive-patterns/`, `modern-javascript-patterns/`, `python-code-style/`, `python-design-patterns/`, `python-error-handling/`, `python-project-structure/`, `python-testing-patterns/`, `python-type-safety/` | wshobson/agents @ 4236bb9 (URL at the end of each `SKILL.md`) | MIT, `LICENSE.txt` |
| `docker-compose/` | magnus919/agent-skills @ 61e411c (URL in `SKILL.md`) | MIT, `LICENSE.txt` |
| `python-packaging/` | Paldom/python-skills @ 70aa0cf (URL in `SKILL.md`) | MIT, `LICENSE.txt` |
| `kiss/`, `solid/`, `yagni/` | Upstream URL not recorded | MIT, `.agents/skills/codingskills-LICENSE` (© Jordan Coin Jackson) |
| `minimalist/` | Upstream URL not recorded | MIT, `.agents/skills/minimalist-LICENSE` (© Alireza Rezvani) |

## Repository-authored skills

| Local skill | Purpose |
| --- | --- |
| `issue-repair/` | Focused repair of an issue, reviewer blocker or failing check in an existing PR. |
| `repomap-navigation/` | Architect-only use of the `pi-repomap` navigation hint. |

When adding or updating an upstream skill, pin a commit, record the source URL
in the skill or in this index, keep its license file, review its instructions
against the repository's trust and CI rules, and update this index.
