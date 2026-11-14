# Convergence report: an agent's own green-PR stop is the agent's to release

## ELI10 overview

An agent can now pull the auto-merge stop as its own and release it later without the operator's PIN, but only once the server itself sees that the fix is running. A stop with no such claim, including all older ones, still needs the PIN. Review changed what the release waits for, how the fix PR connects to the stop, and how a forgotten stop gets noticed.

## Iteration summary

- **Round 1.** External: codex-cli gpt-6-astra. Internal: one combined adversarial, security, integration and decision-completeness reviewer, checked against the code. Standards-Conformance Gate: unavailable: the live route refuses a spec outside the live agent's specs directory (`specPath escapes specsDir`). Result: 6 design findings.
- **Round 2.** External: codex-cli gpt-6-astra, and claude-code as a clean-door second read. Standards-Conformance Gate: unavailable, same reason. Result: 3 design findings taken.
- **Round 3.** External: codex-cli gpt-6-astra. Standards-Conformance Gate: unavailable, same reason. Result: wording corrections, plus one older gap left behind. Stopped at 80/20 on the operator's instruction. Gemini was unavailable in all rounds (not authenticated).

## What changed in review

- A merged PR, or a version number, does not prove the fix is running. The condition became containment in the running version's release tag.
- A stop is pulled before a fix exists, so the fix PR now cites the stop's marker, rather than the stop naming a PR.
- The watcher's aggregate Attention item never reaches the operator, because the hub filter holds it. Stops now have their own admitted item.
- Beacon revival is dry-run on the dev agent, so a commitment alone would strand a stop. The pass now wakes the owning topic.
- The fix could not land under its own stop by the written rules. A narrow manual-merge rule now covers it.
- Surfacing moved out of `tick()`, because an await there opened a lost-update race with `disarmAllArmed`.
- Plain stops get one notice, since a forgotten claim would otherwise reach nobody.

## Dissent and residuals

The final external read holds that §6's manual-merge rule should be enforced in `safe-merge`, not stated in text. Not taken here: `safe-merge` has no latch check today with or without this change, and it is a protected merge path needing its own review. It goes to the feedback queue. Other residuals are in spec §4.

## Decision

No constitution change and no CODEOWNERS file. Approved under the operator's direct instruction in topic 136706 and the standing rule that only constitution changes need the operator.
