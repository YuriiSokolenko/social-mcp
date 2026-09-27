---
name: issue-repair
description: Diagnose and repair a concrete issue, reviewer blocker, failing product check, or stale expectation in an existing PR. Use when a repair requires establishing expected vs actual behavior, reproducing or confirming the failure, finding the root cause, making the smallest correct change, and verifying it.
---

# Issue Repair

Use this skill for localized repair work inside an existing PR. Git/GitHub publication, labels, comments, workflow dispatch, and final full-suite validation belong to trusted workflow tooling, not this skill.

## Repair loop

1. **Read the original issue and state the contract.** Treat its title, description, acceptance criteria, and explicit scope as the source of intended behavior. Extract only:
   - expected behavior;
   - actual failing behavior;
   - concrete blocker/error;
   - directly relevant current `dev` behavior.
   Inspect the PR diff only if a concrete diagnostic question requires knowing what the PR changed.

2. **Confirm the failure with the cheapest useful evidence.**
   - Prefer an already failing focused test/check or the supplied reviewer/CI evidence.
   - Reproduce manually only when existing evidence is insufficient to locate the cause.
   - Do not create a reproduction ritual when the failure is already deterministic and explained by repository evidence.

3. **Find one root cause.**
   - Trace only the files, symbols, tests, and immediate data flow needed to explain the mismatch.
   - Distinguish implementation defects from stale tests/expectations caused by newer `dev` behavior.
   - Do not search history or unrelated architecture unless one specific missing fact requires it.

4. **Cross the diagnosis gate.**
   Once you can say:
   - "The blocker happens because <root cause>."
   - "The smallest correct repair is <specific edit>."

   diagnosis is complete. The next tool call must be `edit` or `write`. Do not compare alternatives or re-prove the diagnosis.

5. **Make the smallest complete repair.**
   - Preserve current `dev` behavior that is unrelated to the blocker.
   - Preserve valid existing PR intent.
   - Never weaken a valid test just to make it pass.
   - A stale assertion may be updated when current repository evidence proves the expected behavior changed independently of this PR.
   - Add regression coverage only when it protects the repaired behavior or no existing focused test covers it.

6. **Verify narrowly.**
   Run the smallest focused test/check that can disprove the repair. If it passes, proceed to `submit_repair`.

7. **React only to new evidence.**
   If verification fails, use that concrete failure as the new blocker, update the diagnosis once, edit immediately, and verify again. Do not restart broad exploration.

8. **Submit.**
   Call `submit_repair`. Let it perform integration with current `dev` and authoritative full validation. On success, stop.

## Decision rules

- Existing deterministic failure + obvious cause: do not spend turns reproducing it again.
- Stale test vs current `dev`: preserve current valid product behavior; update only the stale expectation and its misleading comment.
- Product code bug: repair product code first; keep/add a focused regression test that would fail without the fix.
- Multiple unrelated findings: repair only the primary blocker; do not expand scope.
- Ambiguous evidence: identify the single missing fact needed to decide, inspect it, then return to the diagnosis gate.
- A proposed repair that requires redesign, broad refactoring, or unrelated cleanup is not a minimal repair.

## Source adaptation

Adapted for this repository from the issue-fix workflow patterns in `tomzx/agents` (`fix-issue` and `reproduce-issue`): expected-vs-actual extraction, focused reproduction, regression-oriented implementation, minimal fix, and verification. Repository-specific trusted workflow boundaries take precedence.
