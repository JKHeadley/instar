# ELI16 — Making Slack replies as unlosable as Telegram replies

## The problem in plain terms

When the agent replies to you on **Telegram**, the message rides a whole
safety pipeline: if the send fails, the message is written into a small
crash-proof queue on disk, a background "delivery sentinel" retries it with
increasing patience (30 seconds, then a minute, then two…), an identical
accidental re-send is recognized and suppressed, and every retry or failure
leaves an audit trail. Messages basically cannot vanish silently.

When the agent replies to you on **Slack**, none of that exists. The reply is
one HTTP call to Slack. If the network hiccups at that moment, the script
prints an error and the message is simply *gone* — the agent may not even
realize you never saw it. There's also one internal Slack route that skips
even the outbound safety gate (the check that stops passwords, raw commands,
and file paths from reaching a chat), and nothing on the Slack side prevents
the same message being posted twice after a restart.

## The fix (one sentence)

Instead of building a separate Slack pipeline, we teach the **existing**
Telegram pipeline to carry more than one channel.

## How, concretely

1. **The queue learns channels.** The on-disk retry queue gets one new column:
   `channel` ("telegram" or "slack"). Old rows automatically read as
   "telegram", so nothing existing changes. Never destructive — columns are
   only added, never renamed or dropped.
2. **One address for every conversation.** This work leans on the Phase-1
   "durable conversation identity" project: every Slack channel or thread gets
   a permanent numeric ID (a negative number, so it can never collide with
   Telegram's positive topic numbers). The queue stores that ID; at retry
   time the registry translates it back to the real Slack channel + thread.
   That's why this spec can't be built until Phase 1 lands — it's the
   addressing system everything here writes down.
3. **The sentinel learns to speak Slack.** The retry engine looks at each
   queued row's channel and sends it back out the right door — Slack rows to
   the Slack route, Telegram rows exactly as before. The retry schedule,
   give-up rules, and circuit breaker are shared and unchanged.
4. **No double-posting.** Every send carries a unique delivery ID; the server
   remembers recent IDs and answers "already delivered" instead of posting
   again. Separately, sending byte-identical long text to the same
   conversation twice within ~15 minutes is suppressed (short acks like "on
   it" are never suppressed). Both are copies of what Telegram already has.
5. **The ungated route gets gated.** `/internal/slack-forward` now passes the
   same outbound safety gate as every other message. (We also found and wrote
   down an oddity: that route looks like it was meant for *incoming* messages
   but actually sends *outgoing* ones. It has never run live. Fixing its
   direction belongs to the next phase; this phase just makes sure nothing
   ungated can leave through it.)

## The safety philosophy (why the failure directions matter)

The house rule is: **a delivery system's own failures must never silence the
agent.** So every failure here leans toward delivery: if the queue can't
open, the message still sends directly; if a retry engine breaks, queued
messages sit safely on disk instead of being deleted; if retries run out, you
get exactly ONE clear escalation notice (not a flood). The only thing allowed
to withhold a message is the safety gate itself making a real "this contains
a leak" verdict — and the retry engine is never allowed to overrule it.

Every dropped or refused message leaves a trace: a counter and a line in an
audit log (`logs/delivery-recovery.jsonl`). "It vanished and nobody knows
why" is structurally impossible.

## How we'll know it works (the live proof)

Cut the network in the middle of a Slack reply. The message must show up in
the Slack thread **exactly once** after the network returns — not zero times
(loss) and not twice (duplicate) — with the retry visible in the audit log.

## Rollout

Ships dark on the fleet. On the development agent it runs first in dry-run
(it goes through all the motions and logs what it *would* retry, but posts
nothing), then live after the proof above passes. Config keys:
`monitoring.deliveryFailureSentinel.channels` and `.slackDryRun`. Existing
agents get the changes through the normal update path — the database upgrades
itself additively on boot, and the Slack reply script refreshes via the
standard template-refresh machinery.
