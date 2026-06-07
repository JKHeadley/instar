<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

The exactly-once message recovery re-ran an already-answered Telegram message every
~10 minutes — tagged "from Unknown" — re-spawning a session each cycle and piling load
onto an already-overloaded machine (the 2026-06-07 "server temporarily down on every
message" incident, topic 21816). Three fixes, all "don't replay a handled message":

1. **Reply-evidence guard** — before re-running a message stuck in `processing`,
   stuck-recovery now checks the durable ledger for a reply committed on that topic
   at/after the message arrived. If found, the entry is committed (it was effectively
   handled — its own reply just failed to record during the server flap, or it was a
   duplicate) instead of being re-injected. The no-loss path (re-running a genuinely
   unanswered turn) is unchanged.
2. **Sender preserved through replay** — the inbound sender is captured at ingress and
   replayed, so a legitimate re-run no longer shows "from Unknown" (Know Your Principal).
3. **Lifeline queue dedup** — `MessageQueue.enqueue` is idempotent on message id and
   refuses to re-queue an id already delivered/dropped this run, killing the "stale
   already-delivered copies kept getting retried" half.

## What to Tell Your User

If they saw the same message echoed back repeatedly, or "server temporarily down" on
nearly every message during an overload: that replay loop is fixed — an already-answered
message is no longer re-run, and the queue won't re-deliver something it already sent.
Nothing for them to do; their messages were never lost (they queued and delivered).

## Summary of New Capabilities

- `MessageProcessingLedger.hasReplyCommittedForTopicSince(topic, sinceISO)` — durable
  reply-evidence query used to recognize an already-answered topic.
- `MessageProcessingLedger` stores the inbound sender envelope (additive, nullable
  column; idempotent in-place schema upgrade — no migrator step).
- `recoverStuckMessages` reply-evidence guard + `alreadyHandled` result counter;
  re-injection preserves the real sender.
- `MessageQueue.enqueue` is id-idempotent (returns boolean); `MessageQueue.markDelivered`
  records delivered/dropped ids so a redelivery can't re-queue them.

## Scope (honest)

Contained Tier-1 fix to the existing exactly-once ingress + lifeline replay subsystems.
No new HTTP route, config default, or migration step. The reply-evidence false-negative
case (two distinct rapid questions, the second crashes before the first's reply commits)
is bounded — that message was already routed once, so it isn't lost, only a redundant
re-run is skipped. 603 messaging/lifeline unit tests green; `tsc --noEmit` clean.

## Evidence

`tests/unit/stuck-message-recovery.test.ts`, `MessageProcessingLedger.test.ts`,
`lifeline/MessageQueue-durability.test.ts`, `lifeline/version-skew-recovery.test.ts`:
reply-evidence guard commits-not-reruns an answered topic; a genuinely-unanswered entry
still re-runs; sender round-trips through a recovered replay; the queue refuses to
re-enqueue an already-delivered id; wiring guards assert routes.ts captures the sender
and reinjectStuck forwards it. causalAutopsy: latent (the stuck==unanswered assumption
surfaced under sustained CPU starvation that made replies fail to commit).
