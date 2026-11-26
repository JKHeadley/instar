# Convergence Report — Live credentials are redacted where the agent keeps text, part 1 of 2 (SEC-164)

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran in all six rounds through the agent's Codex login, alongside the clean-door Anthropic reader (`clean-door-anthropic-review: claude-code:claude-fable-5-2`, not counted as cross-family).

## ELI16 Overview

Keys sometimes end up in the agent's records. A command prints one, an error message includes one, or someone pastes one into a chat. Justin asked for a sturdy way to clean them out, so he stops being told about them. This design makes the agent blank such keys out by itself: in its logs before they are written, in every new incoming message before it is stored, in copies sent between its computers, and in session records shortly after they are written. Only the key's characters change, so everything stays readable, and a team member whose key was removed gets a one-tap link to send it safely instead. The agent never touches its own settings or vault, and nobody is asked to change a key.

It rolls out carefully. The development agent goes first, and the part that rewrites other programs' session records starts by only noting what it would change. It switches on after real cases are reviewed. It reaches every agent only after a week of evidence and Justin's yes. Cleaning the message history that already exists is part 2 (CMT-029). Saving pasted keys into the vault is its own later design (CMT-030).

## Original vs Converged

- **Originally** one pass scanned raw lines. **The converged version** scans each JSON string value on its own and never crosses a field. The raw scan missed most keys inside session records and could rename JSON fields.
- **Originally** it swept every Claude Code folder on the machine. **The converged version** sweeps only this agent's own project folders, matched exactly, and never follows links.
- **Originally** it scrubbed copies between machines on arrival with a marker that changed the text's length. **The converged version** masks copies inside the existing copy writer before hashing, and after verification on arrival, at the same length.
- **The message history entered scope** through the Chief of Staff's decision (d2060363). It was then split (19aa907f): part 1 masks every new incoming message at its very first write, so its author record and the app's verified origin both cover the masked text; part 2 cleans what already exists.
- **Saving a team member's key into the vault** was designed over three rounds. It kept producing safety findings, so the Chief of Staff chose to take it out of part 1 (3d4ab7c7). A team member now gets a fixed notice with a one-tap Secret Drop link instead.
- **The rollout** gained a dry run that records only counts, a reviewed-event floor before masking, and Justin's decision on an evidence packet for the fleet.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | all five | about 33 | about 28 | rewrote the scanning unit, the reach, the copies and the brakes; message history added |
| 2 | all five | about 25 | about 25 | inbound masking, store writers, quarantine (later removed) |
| 3 | all five | about 12 | about 15 | split into part 1 and part 2; every way in listed; the lifeline rule |
| 4 | four of five | about 9 | about 12 | team check, naming key, lock, PEM across lines |
| 5 | three of five | about 9 | about 10 | the failed-save spool, the operator channel failing toward delivery |
| 6 | two of five (vault-save only) | 5 vault-saving, 3 other | about 10 | at the cap: the Chief of Staff chose option A; the three other findings were fixed (crash-safe write intent, the error-log trim kept in place, the outbound wall kept broad) |

Standards-Conformance Gate: ran every round (0 flags at the end). Lessons-aware and decision-completeness reviewers ran every round. Internal reviewers ran on the authoring session's model (claude-opus-5-5), with no tier escalation.

## Proportion

Tier 2, security-sensitive. Six rounds, which is the cap. The large number of findings came from one feature (vault saving), which was taken out of part 1 at the cap by the Chief of Staff's decision.

## Left behind

- Vault saving of keys from messages: CMT-030, after part 2.
- The existing message history, the coherence journal's checkpoint entries, the replicated streams and received agent-to-agent envelopes: part 2, CMT-029, due 2026-11-26.
- A string from an outside sender that matches a wall pattern without being a key loses those characters. This is the accepted residual of the Chief of Staff's decisions, measured by the dry run.
- Integrity-bound fields (signed thinking blocks, encrypted reasoning) are reported, not masked, and raised to the security queue. A deterministic end state for them is a follow-up item.
- The wrapper loses up to 1 second or 64 KB of output on SIGKILL. This is listed with its other known bypasses.
- Rendering `[credential removed]` as a friendlier label in the app is a nicety, not required.
- The 15-second interval is a polling interval, not an exposure bound. The oldest-unchecked age is reported.

## Full Findings Catalog

Each round's findings, with what was done about each, are kept in the security session's working notes. The six round copies of the spec are in the session scratchpad (`sec164-spec-r1.md` to `sec164-spec-r6.md`), and the external reviews are in `ext164-*.json`. The six internal reviewers' round reports covered security, adversarial, integration, scalability, decision-completeness and lessons-aware lenses.

## Convergence verdict

The review reached the Tier 2 cap at round 6. The only design findings left were in vault saving, which the Chief of Staff removed from part 1 (3d4ab7c7, option A). The other three round-6 design findings were fixed in the spec. The standards gate reports 0 flags on the final text. The spec is accepted for building on the Chief of Staff's decision, with the items above left behind and tracked.
