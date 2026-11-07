# Convergence Report — Attribution paper trail

**Spec:** [docs/specs/attribution-paper-trail.md](../attribution-paper-trail.md)
**Slug:** `attribution-paper-trail`
**Iterations:** 5

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra read rounds 1 through 5 through Echo's Codex login. A clean-door Claude Opus 5.5 read ran in round 1 (not cross-family). Gemini was not signed in.

**No round came back quiet.** The outside reader still reported design findings in round 5, each narrower than the last. This work's brief set a cut after about 3 rounds that keep finding design problems. Round 5's findings were fixed in the spec and not re-read. That is a judgment to stop, not a clean pass.

## ELI10 Overview

An agent wrote "Justin corrected me" in a note with no link to what he said. Copies of the note got firmer until it told him it had broken "his standing rule", and it refused work because of it. He had not said it. A check of 190 notes crediting him found 50 that had drifted from his words.

This adds a rule with teeth: anything credited to a person points to the logged message and quotes their words, or says plainly it has no source. The check runs when a note is saved and when a message is sent. A history file keeps every version of a claim, so you can see how it changed. It uses the agent's own subscription, within a daily limit. It is off for other agents until it has proven itself on Echo, and an update never adds a refusal to an existing agent.

## Original vs Converged

- **The system no longer edits notes.** The draft had a sweep writing sources and labels into notes. A fast model could have stamped a wrong source that looked checked, and written peers' text into always-loaded instructions. Now it only reports, and a session makes each fix, passing the same check.
- **Each channel has its own proof of who wrote a message.** The draft assumed a field that only Telegram logs hold, so every other channel would have failed. A display name alone never counts.
- **"Could not check" is separate from "does not exist".** A down machine, a date older than a log, or a record gap is never called a false citation. Markers now hold a date so this works after a row rotates out.
- **A label has to remove the credit.** "Justin's rule: X [source unknown]" still credits him, so it is refused.
- **Lineage is explicit.** Claims have ids and parents, so a reworded copy with no source is still linked, and inferred links are marked.
- **Refusals name more cases.** "That's a standing rule, so no" is caught even with no person named. Messages to peers get a warning and a record.
- **Maturation.** The draft enforced on new agents at once. Now it follows test agent, Echo watching for 72 hours, then Echo enforcing, then the fleet recording, against numbers.
- **Its own queue and budgets**, because the first numbers could not cover real traffic and shared calls could be aborted.

## Iteration Summary

| Iteration | Reviewers | Design findings | Spec changes |
|---|---|---|---|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, codex, clean-door | about 50, many shared | Rewrite |
| 2 | three combined internal, codex | 16 + 3 | Identity, budgets, queue, find, modes, lineage |
| 3 | one combined internal, codex | 4 + 4 | Latency, app messages, retries, unconfirmed citations |
| 4 | codex | 4 | Origin vs support, audit budget split |
| 5 | codex | 3 | Evidence requirements, refused attempts, send-gate conditions |

Standards-Conformance Gate: ran round 1 (8 flags), ran round 2 (7 flags); later rounds not re-run.

## Proportion

Tier 2, about 240 spec lines, 5 rounds against a cap of 6. ⚠ Five rounds with no quiet one; stopped by the brief's cut rule.

## Left behind

See `## Left behind` in the spec. Also: the audit's cheap filter, the app row's weaker proof, and `apply_patch` firing PreToolUse all need live confirmation during the test-agent rung.

## Convergence verdict

Stopped at round 5 by judgment, with no safety or data-loss finding open. Everything found was fixed in the spec or recorded above.
