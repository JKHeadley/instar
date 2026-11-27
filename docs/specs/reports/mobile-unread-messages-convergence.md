# Convergence Report — Unread messages in the Instar app

**Spec:** [docs/specs/mobile-unread-messages.md](../mobile-unread-messages.md)
**Slug:** `mobile-unread-messages`
**Iterations:** 6 (the Tier 2 cap)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-family pass ran every round through the agent's own Codex CLI, from the reviewer module of a sibling worktree's build: this worktree had no built copy, and the `instar` CLI isn't on this machine's path.

- **Claude clean-door read:** degraded in round 1 (`override-not-frontier`) and was not repeated.
- **Gemini:** not signed in on this machine.
- **Honest limit:** Codex read the spec inlined to it and no code, and said so each round. The internal reviewers read the code.

## ELI10 Overview

Justin wants the Instar app to work like Telegram for unread messages:

- a number on each conversation;
- a total on the Chat tab and on the app icon;
- an "Unread messages" line where he left off;
- a button that jumps to the bottom and says how many new messages are waiting.

To do that, the agent's server now remembers, for each person and each conversation, how far they have read. It counts the messages after that point, leaving out the person's own. All of the owner's phones share one marker. Every machine of the agent keeps a copy, so reading on one phone clears the count on the others.

Telegram and Slack don't let the agent see what you read in their own apps. So the rule is "your own reply there marks everything before it as read", and the app says so plainly.

The main tradeoffs:

- Nothing shows as unread when this first appears; new activity after that counts normally.
- A count stops at "100+".
- Notification badges count only the agent's own app conversations, because Telegram and Slack badge their own icons. The Chat tab shows the full total.

## Original vs Converged

| | Originally | After review | Why |
|---|---|---|---|
| Conversations with no marker | Showed 0 unread | Each person gets one baseline time; messages after it count, even in a conversation never opened | The original hid every new conversation for good |
| Message position | "The id the history route returns", times compared as text | Milliseconds plus a defined id per platform (`in:`/`out:` + the Telegram message number) | Telegram rows usually have no eventId, and text comparison misorders mixed precisions |
| Read reports | Client-chosen positions, checked against each receiving machine's clock | The holder stores its own position for a message it has, or limits the phone's position to its newest message; no clock check on landing | Prevents future markers and junk markers, and keeps machines agreeing |
| Pool reads | "Each machine counts its own rows" | The reader is forwarded to peers (Bearer `reader=`, resolved on the peer, access re-checked with `mayUse`); the sanitizer passes the fields | As first written, peers answered a Bearer read and returned no counts at all |
| Marks for messages on another machine | Refused | Forwarded once to the machine the phone names, never re-forwarded; unreachable answers `pending` and the phone keeps the mark | Otherwise counts stuck for anyone whose phone talks to a non-holder |
| Bounds | 20,000-marker eviction | No eviction; markers are removed only on stored evidence the conversation or person is gone | Evicting deleted read history and showed it as "0 unread" |
| Badge | "Matches the list" | App conversations only, filtered by access; the app's icon shows its full total when it refreshes | Machines hold different Telegram/Slack rows, and the badge could leak other people's activity |
| Replication | Furthest-wins "like TopicPin" | Own ingest with a forward-only merge, emits throttled with a durable outbox, turned on with native chat; older state comes from a paged boot catch-up from any peer | TopicPin is HLC-highest-wins; refused emits were lost; old keys rotated out of the journal |
| Counting cost | Up to 100 reads per conversation, an 8 MiB Slack parse per row | Walk back from the newest message, only past a millisecond pre-filter; one shared Slack parse; counts cached by local revision | Kept the list fast under launch-time prewarm across machines |

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware (six separate reviewers), Codex | about 35 raised, about 14 distinct | about 20 | Rewrite of §3–§7 |
| 2 | three paired internal reviewers (all six lenses), Codex | 7 | 12 | §3.1–§3.6, §4, §5 |
| 3 | two paired internal reviewers (all six lenses), Codex | 6 | 8 | §3.2–§3.5, §4, §5 |
| 4 | two paired internal reviewers (all six lenses), Codex | 4 | 4 | §3.2, §3.3, §3.5, §4 |
| 5 | one combined internal reviewer (all six lenses), Codex | 4 | 5 | §3.2–§3.5 |
| 6 | Codex (internal reviewer: converged) | 3 | 4 | §3.2, §3.3, §3.5, §8 |

- **Standards-Conformance Gate:** ran in every round (6, 10, 5, 3, 3 and 5 advisory flags), and those flags went to the reviewers.
- **Externals:** run in every round, because the spec body changed each round.
- **Reviewer models:** the internal reviewers ran on this session's model (claude-opus-5-5).
- **Applied after the last round, with no seventh round under the cap:** round 6's three Codex design findings and the internal reviewer's precision notes. They were small and local:
  - a baseline never takes a future time from a fast peer;
  - "something new" uses the same one-second margin as counting;
  - a failed catch-up page retries from its saved cursor;
  - `hasUnread` is passed through the peer sanitizer;
  - keys learned from a peer are never re-emitted.

## Left behind (precision)

- **The quote's pointer.** It is the coordinating Echo session's verbatim relay of Justin's 15:32 message. This session cannot read that app conversation's message id, so the relay is the cited source.
- **The 16-peer and 100-count limits.** Both are existing system bounds, reused deliberately. Above 100, the count shows "100+", so no unread is hidden.
- **Telegram handoff.** Unread rows still sitting only in a previous holder's log are not counted. This undercount is documented; the own-reply marker now replicates.

## Decisions for the approver

None open. Settled before or during review:

- no Slack token for the owner's own account;
- the cross-machine path is replication with a forward-only merge, plus a boot catch-up;
- the first view after the update is quiet for existing conversations;
- the badge counts app conversations only.
