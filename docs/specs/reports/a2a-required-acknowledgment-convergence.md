# Convergence Report — A2A: a sender is never left guessing

## Cross-model review: codex-cli:gpt-6-astra

A real outside pass ran through the agent's Codex login on all six rounds. Gemini and Grok were not available.

## ELI10 Overview

When one agent messages another, the sender often hears nothing for a long time, and the person asking gets "they still haven't replied". This change makes the server answer at once when no session can take a message, has the session that picks it up write a one-line summary of the request, and tells the sender if nobody acknowledges within 15 minutes. It also shortens an 8-minute retry pause when the only problem was a full session limit. Nothing is ever blocked. Agents only get these notes if they have said they understand them.

## Original vs Converged

Originally the design assumed new fields would simply travel on the existing receipt, typed status lines into the sender's session, and raised an operator alert after 15 minutes. Review found the fields were stripped in transit, encrypted receipts were blocked at the gate, a summary would have leaked to the relay, and a stranger could forge "they read it". Typing into the sender's session would have reopened an expensive agent-to-agent loop, so that was removed. The operator alert became a truthful note to the sender. The automatic receipt could have satisfied the requirement by itself, and the incident's own path was not tracked; both are fixed. The feature also moved from development-only to live for everyone, because it needs both ends.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, scalability, lessons, decision-completeness, codex | 30+ (overlapping) | 6 | Rewrite: typed acks with opt-in, ledger branch, encrypted summaries, no sender typing, no operator notice |
| 2 | all-lens internal, codex | 9 | 4 | Gate pass, `spawnQueued`, pending rows, explicit ids, closes in routes, no forward hop |
| 3 | all-lens internal, codex | 4 | 5 | Durable `read`, resend rule, interactive-only reminder, callback at `#commitQueueSnapshot` |
| 4 | all-lens internal, codex | 5 | 3 | `deliveryPending` branch, standby forwarding, stamp-drop on rollback, brake state |
| 5 | all-lens internal, codex | 4 | 3 | New 30-second timer named |
| 6 | all-lens internal, codex | 3, 1 security (fixed) | 4 | Server-issued handles, retry backoff, immediate `waiting`, closed reason set |

Standards-Conformance Gate: ran in round 1 (2 flags) and round 6 (4 flags: backoff and history added; maturation uses the user-facing-fix exception; rollback window accepted below). Rounds 2 to 5: not run, a skipped step in this convergence.

Models: internal reviewers ran as subagents of an Opus session (claude-opus-5-5). Rounds 2 to 6 used one all-lens reviewer rather than six separate ones, a reduction from the skill's default.

## Proportion

Tier 2, about 150 spec lines, 6 of 6 rounds. Effort was high because Threadline's wire, gate and multi-machine paths each had facts the first draft had wrong.

## Left behind

Accepted at the cap, none about safety, security or data loss:
- A holder move between a send and its `read` loses that `read`. Health reports `unknown`; rare, and no worse than today.
- A delayed receipt from an older attempt can cross a sender's resend of the same id. Rare; a `read` still corrects it.
- A rolled-back peer can mistake a `held` for a delivery ack until its next message clears its capability row. Limited to a rollback window.
- A queue entry near expiry can drop in the window before a latch forms. The sender is told.
- `a2a_peer_caps` has no retention; one small row per peer.

Filed: overflow to another machine (fb-50b25fac-7d0); labelling a mirrored topic message as not read yet (fb-fc8bc3ae-4e5).

## Full Findings Catalog

Round bodies are in the review session's record for topic 134156; the changes above list each resolution. The final-round security finding (a sender-chosen message id shown to a session as server text) was resolved by server-issued handles after that round, so that fix was not itself re-reviewed; the Phase 5 second-pass review on the built change must cover it.

## Convergence verdict

Stopped at the 6-round cap. No unresolved safety, security or data-loss finding remains. Five items are accepted above. The spec is under the operator's standing approval for the agent-comms track.
