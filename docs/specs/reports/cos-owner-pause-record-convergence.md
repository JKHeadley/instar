# Convergence Report — Chief of Staff owner-pause record

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass (codex CLI, `gpt-6-astra`) ran on every one of the six rounds. A clean-door Anthropic second read (`claude-code:claude-opus-5-5`, not cross-model) also ran every round. The Standards-Conformance Gate ran every round: round 1 ran (3 flags), round 2 ran (4 flags), round 3 ran (8 flags), round 4 ran (7 flags), round 5 ran (5 flags), round 6 ran (5 flags).

## ELI10 Overview

Justin told the agent to pause the Instar 2.0 work until the throughput problems are fixed. The Chief of Staff, which watches tracked projects and restarts stuck ones, had no way to write that down, so it could have restarted the very work he paused. This change gives every tracked project an owner pause.

The important part is who can pause. The agent itself must never be able to stop work and claim the owner asked. So the agent can only ask: when the owner says "pause X" in chat, the agent cites that exact message, and the owner gets one Telegram button showing their whole message. Only the owner's tap on that button pauses or resumes the project. While paused, the Chief of Staff doesn't check it, restart it, nudge it or revive it, and every note that goes out reminds the owner what is paused.

The trade-off: the owner taps once more than they talked, and the pause path is Telegram-only for now (an Instar-app path is tracked as fb-0ac4fffb-148).

## Original vs Converged

- **Originally**, a pause was written straight from the owner's cited chat message (checked against the logs), with a PIN dashboard tap as a second way in. **Review showed** a cited message proves who wrote words, not that they still mean this action now: an old "pause" could be re-cited after the owner said "go again"; a model judge reading one message couldn't see that; and the PIN is readable by any session with the API token. **Now** the owner's own Telegram tap is the only authority; the cited message only lets the agent ask.
- **Originally** any button labelled "pause" would do. **Now** each ask is a server-written record with a one-time id, and the tap must land on the exact message the server sent; one ask can decide only once, even after a crash or a replayed button.
- **Originally** the agent chose a quote. **Now** the owner's whole message is shown and recorded, so a fragment can't be cut out of "don't pause 2.0 yet".
- **Originally** the pause only stopped planning. **Now** it also stops an action inside the execution lock and stops reviving a Chief-of-Staff-started run.
- **Originally** a revert was the rollback. **Review found** older builds reject the new record and freeze their whole Chief of Staff stream, and a revert would silently undo owner pauses. **Now** the store ignores lifecycle events it doesn't know (instead of rejecting them), and rollback is a config switch that stops new pause asks while existing pauses hold and resumes keep working.
- Durability: the owner sees "Paused" only after the record is durably saved; a failed save keeps the ask and says so.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | gate, security, integration, decision/lessons, codex, clean-door | 14 | 12 | redesign from message-authority to owner tap |
| 2 | gate, security, integration, codex, clean-door | 9 | 10 | ask record + nonce + exact message; whole owner text; tolerant validator; durability |
| 3 | gate, combined internal, codex | 6 | 6 | callback-machine only; chat/message actually used; write-failure honesty; askId dedupe; rollback switch |
| 4 | gate, codex, clean-door | 4 | 5 | durable before "Done"; resume survives the switch; one ask per project |
| 5 | gate, codex, clean-door | 5 | 4 | slow-tap race; edited-message refusal; unavailability doesn't block |
| 6 (cap) | gate, codex | 2 | 6 | resume on closed projects; honest ask/answer wording |

## Proportion

Tier 2 (new authority over restarts plus an identity check on a write). Spec about 120 lines; six rounds used of six. The round count reflects one real redesign in round 1 (the message-as-authority design did not survive), then narrowing. Implementation roughly 8 files.

## Left behind

Accepted at the cap (none is safety, security or data loss):
- Quiet hours are not enforced by the route (gate, rounds 3–6): the no-requests-at-night rule is this operator's preference, not an instar setting; the agent's own rule applies.
- Non-Telegram agents have no pause path (gate rounds 2–6; clean-door round 6): tracked as fb-0ac4fffb-148 (device-signed app control).
- A citation-free ask (clean-door round 6): rejected — the citation keeps the agent from proposing pauses of work it would rather not do, which is the brief's core concern; the tap stays the authority either way.
- Open asks are lost when Telegram polling moves (gate rounds 3, 6): the agent asks again; the asks file is bound to the polling machine.
- An action that passed the in-lock check before the pause replicated may start (codex rounds 2–5): no acknowledgement barrier; every later check, restart and respawn is fenced, and the owner is told work under way may finish.
- Older machines freeze their Chief of Staff stream from a peer until they update, and keep acting without the pause (gate rounds 4–6): warned in the ask; the tolerant validator stops this recurring.
- The unknown-event bound uses the store's existing 200-character short-field bound (gate rounds 4–6).
- The "extra tap" over a chat instruction (gate, Security Fixes Keep the Experience Whole): argued in §3 — a chat instruction cannot prove "this action, this project, now".
- Slack live proof (gate): the Chief of Staff's buttons exist only on Telegram; the live proof is Telegram on a throwaway agent.
- Editing a typo in the cited message refuses the tap (clean-door round 6): the owner is asked again; recording changed words would break "what is recorded is what still verifies".
- Owner command alternative (`/pause`): discussed in §3.2; plain words are how the owner talks.

## Full Findings Catalog

Round 1: message replay; future-dated `at` locking a pause; PIN readable by any session; peer-row authorship; text date comparison; in-flight actions after a pause; mixed-version restart; dashboard Needs-you still listing paused projects; rollback silently unpausing; judge tier contradicted by repo data; tap/clock skew; app rows; no resurfacing of a conditional pause; three gate items (meaning not established, replay ordering, length bounds). Resolution: redesign to an owner tap on a server ask; execution fence; dashboard skip; resurfacing line; honest rollback.
Round 2: callback not tied to an ask (bot-token holder could post a mislabelled button); quote cherry-picking; project mismatch; fleet guard blocking forever on an offline machine; version string comparison; ask only from a send-only machine; rollback stalls; callback redelivery; ask context overwrite. Resolution: nonce + exact message match; whole owner text; tolerant validator; numeric version warning instead of a block; askId.
Round 3: standby machines can send unanswerable asks; DM sends need the real chat id; failed write answered "Done."; crash-replay ordering; lock ordering; rollback revoking pauses. Resolution: callback-machine only; record the chat used; durable-before-answer; askId dedupe in tap and fold; config switch.
Round 4: acceptance is not durability; switch blocked resume; stale opposite-action asks. Resolution: `awaitDurable`; switch blocks pause asks only; one ask per project.
Round 5: slow tap after replacement; edited message; unknown events not lossless; re-check blocking resume. Resolution: re-check the nonce after the await; compare text; state the limit; unavailability doesn't block.
Round 6: resume of a closed paused project; owner-started runs; implementation fail-open spots. Resolution: resume allowed on closed paused projects; ask names owner runs as unaffected; fail-safe fixes in code.

## Convergence verdict

Converged at the round-6 cap. The last round's two design items were small and are applied; nothing remaining is about safety, security or data loss, and everything else is listed above as accepted with a reason. The spec is ready for maintainer approval.
