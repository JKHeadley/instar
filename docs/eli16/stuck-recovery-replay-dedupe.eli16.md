# Stuck-recovery / replay dedupe — Plain-English Overview

> The one-line version: a message you'd already been answered kept getting "re-delivered" to me every ~10 minutes (showing "from Unknown"), and each re-delivery woke up a fresh session — so the very thing meant to recover *lost* messages was instead replaying *handled* ones and piling load onto an already-struggling machine. This stops that.

## The problem in one breath

When my server crashes mid-reply, a safety net re-runs the message I never got to answer, so nothing is lost. But the net couldn't tell "I never answered this" from "I answered this, but the reply failed to record because the server was flapping." So during the morning incident it kept re-running messages I'd already handled — every ~10 minutes, tagged "from Unknown" because the re-run threw away who sent it — and each replay spawned a session, adding to the overload.

## What already exists

- **Exactly-once ingress (the message ledger)** — a durable record of every inbound message's life: received → being-worked-on → answered → done. A redelivery of an already-answered message is dropped. This part works.
- **Stuck-message recovery** — if a message is stuck at "being-worked-on" too long (the server crashed mid-turn), the current machine re-runs it from the stored text. This is the no-loss net.
- **The lifeline queue** — when the server is down, incoming messages are parked here and replayed when it recovers.

## What this adds

The recovery net now **looks before it leaps**: before re-running a stuck message, it checks whether I actually replied to that conversation since the message arrived. If I did, the message was effectively handled (its own "answered" mark just failed to save during the flap, or it was a duplicate) — so it's marked done instead of being replayed. The check reads the durable ledger, so it survives restarts.

It also **keeps the sender's identity** through a re-run, so a legitimate replay no longer shows "from Unknown" — which matters because acting on a message from an unknown principal is exactly what "Know Your Principal" warns against.

Finally, the **lifeline queue refuses to re-park a message it already delivered**: enqueue is now idempotent on the message id and skips ids it already delivered or dropped this run. That kills the "stale duplicate kept getting retried" half of the loop.

## The new pieces

- **Reply-evidence guard** — a ledger query, "was a reply committed on this topic at or after this message arrived?" If yes, the stuck entry is committed, not re-injected. It can only *suppress* a re-run, never cause one.
- **Sender envelope on the ledger** — captured at ingress (an additive, nullable column added in place; old rows simply read back empty and fall back to today's behavior), replayed so the `[telegram:N … from NAME]` prefix is right.
- **Queue dedup** — `enqueue` skips a duplicate id; the replay loop records delivered/dropped ids so a redelivery can't re-queue them.

## The safeguards

**Prevents replaying a handled message.** The guard is the whole point: an answered conversation can't be re-run into a loop.

**Prevents losing a genuinely unanswered message.** If there's no reply on the topic since the message arrived, it still re-runs exactly as before — the no-loss guarantee is untouched. The false-negative case (two distinct rapid questions, the second crashes before the first's answer records) is bounded: that message was already routed to the session once, so it isn't lost — only a redundant re-run is skipped.

**Prevents identity bleed.** Re-runs carry the real sender; no more "from Unknown."

## What ships when

One PR. It's a contained behavior fix to an existing (dark-by-default, but live on this agent) subsystem — no new API, config, or migration. Unit-tested on both sides of every branch (handled vs unanswered, dedup hit vs miss), plus source-level wiring guards so the sender-capture and the dedup can't silently regress.

## Evidence

`tests/unit/stuck-message-recovery.test.ts`, `MessageProcessingLedger.test.ts`, `lifeline/MessageQueue-durability.test.ts`: reply-evidence guard commits-not-reruns an already-answered topic; a genuinely-unanswered entry still re-runs; sender round-trips through a recovered replay; the queue refuses to re-enqueue an already-delivered id. 603 messaging/lifeline unit tests green; `tsc --noEmit` clean.
