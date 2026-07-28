# Side-Effects Review — Stuck-recovery / replay dedupe + sender preservation

**Version / slug:** `stuck-recovery-replay-dedupe`
**Date:** `2026-06-07`
**Author:** `Echo`
**Tier:** 1 (contained fix to an existing dark feature; no API/route/config/migration surface)
**Second-pass reviewer:** `Echo (self) — Tier-1; the over/under-block analysis below is the load-bearing part`

## Summary of the change

The exactly-once ingress subsystem (spec §8 G3a) re-ran an already-answered Telegram
message every ~10 min, tagged "from Unknown", re-spawning a session each cycle —
during the very load incident it stemmed from (topic 21816). Three changes, all
"don't replay an already-handled message":

1. **`stuckMessageRecovery.recoverStuckMessages`** — before re-injecting a stuck
   `processing` entry, a reply-evidence guard checks whether the topic was already
   answered (a reply committed at/after the entry arrived). If so the entry is
   committed (`commitReply`+`advanceCursor`), NOT re-injected. Default backing is the
   ledger query `hasReplyCommittedForTopicSince`; injectable for tests.
2. **`MessageProcessingLedger`** — stores the inbound sender envelope (idempotent
   `ALTER TABLE … ADD COLUMN sender_envelope`, no PostUpdateMigrator step per the
   SQLite-self-init contract) and exposes `hasReplyCommittedForTopicSince`.
   `ingressDedup.decideIngress` + `routes.ts` thread the sender from the inbound;
   `server.ts reinjectStuck` replays with the real sender so the prefix is correct.
3. **`lifeline/MessageQueue`** — `enqueue` is idempotent on `id` and skips ids already
   delivered/dropped this process; the replay loop feeds the guard via
   `markDelivered()` (remove + remember). Kills the "stale already-delivered copies
   kept getting retried" half.

## Decision-point inventory

- `recoverStuckMessages` (per stuck entry) — modify — re-run vs commit-as-handled.
  The new branch only ADDS a "commit, don't re-run" path; it never causes a re-run
  that wasn't already going to happen.
- `MessageQueue.enqueue` — modify — add vs skip a queue entry. Now returns boolean.
- No message block/allow surface. No kill/terminate surface. No new HTTP route, no
  config default, no CLAUDE.md/template change.

## 1. Over-block (suppressing a re-run that SHOULD happen)

The reply-evidence guard could, in principle, skip re-running a genuinely-unanswered
message. Bound: the guard fires only when a reply was committed on the SAME topic at
or after the entry's `receivedAt`. The false-negative case is "two distinct questions
arrive close together, the first is answered, the second crashed mid-turn and arrived
before that answer committed." Cost is bounded and small: the second message was
already ROUTED to the session once (recovery only re-runs crash-mid-turn turns, not
lost deliveries), so it is not lost from the conversation — only a redundant re-run is
skipped. The far larger, observed harm (re-running an already-answered message every
10 min, forever-bounded only by the 3-attempt cap, each re-run spawning a session
under load) is eliminated. Net strictly safer. The attempts-cap backstop remains.

## 2. Under-block (still re-running when we shouldn't)

A genuinely lost turn (claimed, never answered, no reply on the topic since) still
re-runs exactly as before — verified by the "still re-runs a genuinely unanswered
stuck entry" test. The change does not weaken the no-LOSS guarantee.

## 3. Level-of-abstraction fit

Correct layer. The reply-evidence signal is an objective, durable ledger read
(indexed on `topic, reply_committed_at`), not an LLM call. The sender envelope is
captured at the same ingress point that already logs sender for the message log. The
queue dedup is a pure in-memory id check. No new external dependency.

## 4. Blast radius

The exactly-once ledger + stuck-recovery is gated behind `multiMachine` wiring
(`ctx.messageLedger`); agents without it are unaffected (the code paths no-op when the
ledger is null). The sender-envelope column is additive and nullable — old rows read
back `senderEnvelope: null` (→ replay falls back to "unknown", i.e. today's behavior,
never worse). `MessageQueue.enqueue`'s new boolean return is ignored by existing
call sites (statement context). `markDelivered` is a strict superset of the prior
`remove` on the replay path.

## 5. Rollback

Pure code revert — no data migration to undo. The `sender_envelope` column is left in
place harmlessly on rollback (unused). No state-file format change beyond the additive
nullable column. No config flag introduced or flipped.

## 6. Tests

Unit: reply-evidence guard (both branches + ledger-default), sender round-trip,
ledger `hasReplyCommittedForTopicSince` (topic+time scoping), `MessageQueue` id-dedup
+ delivered-guard, and source-level wiring guards (routes.ts captures the sender;
`reinjectStuck` forwards it; replay loop uses `markDelivered`). 603 messaging/lifeline
unit tests green; `tsc --noEmit` clean.
