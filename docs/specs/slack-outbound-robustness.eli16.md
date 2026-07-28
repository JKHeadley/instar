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

1. **The queue learns channels — and learns to say "on hold".** The on-disk
   retry queue gets new columns: `channel` ("telegram" or "slack") and a
   `hold_reason` marker for any message that is deliberately parked (its lane
   is switched off, it's in a dry-run soak, or the machine holding it isn't
   the one that owns the conversation). Old rows automatically read as
   "telegram", so nothing existing changes. Never destructive — columns are
   only added, never renamed or dropped. The hold marker matters: the second
   review round found two ways a parked message could still be destroyed by
   older machinery (the boot-time stale-row cleanup, and the "too many
   failures, collapse them into a digest" path) because "parked" was only
   implied by timestamps. Now it's written on the row, and both of those
   paths are required to leave marked rows alone.
2. **One address for every conversation — checked twice.** This work leans on
   the Phase-1 "durable conversation identity" project (now fully reviewed
   and approved): every Slack channel or thread gets a permanent numeric ID
   (a negative number, so it can never collide with Telegram's positive topic
   numbers). The queue stores that ID — but only after checking that the ID
   actually points at the channel the reply was aimed at (the review caught
   that blindly trusting the session's own ID could re-deliver a failed
   message into the WRONG channel). If no trustworthy ID exists, the script
   fails loudly instead of queueing something misaddressed — a visible error
   beats a message quietly landing in the wrong room. At retry time the
   address is checked again before anything posts.
3. **The sentinel learns to speak Slack — through the front door.** The retry
   engine looks at each queued row's channel and sends Slack rows through the
   SAME delivery gateway the identity project built (the "funnel"), which
   already knows which machine owns a conversation, refuses mismatched
   addresses, spots permanently-dead channels (archived, bot removed) so we
   stop immediately instead of wasting a full day of retries on them, and
   rate-limits notices. Telegram rows go
   out exactly as before. The retry schedule and give-up rules are shared;
   the circuit breaker now pauses ONE channel's retries at a time, so a
   Slack outage can never freeze Telegram recovery (a review catch).
4. **No double-posting — even across restarts.** Every send carries a unique
   delivery ID **from the very first attempt** — the third review round
   caught that the ID used to be created only when a send failed, which
   meant the server had never seen the ID of a first attempt that actually
   landed (so a much-later retry could double-post; the fix also closes the
   same long-standing gap on the Telegram side). The server remembers recent
   IDs and answers "already delivered" instead of posting again — and that memory is now saved to
   disk, because the review found a real (if narrow) sequence where a
   restart wiped the in-memory list and a late retry could double-post.
   When the outcome of a send is genuinely unknowable (the network died
   right as Slack may have accepted it), the retry engine marks it
   "ambiguous" and refuses to blind-repost — on both the script path and the
   retry path. One honest fine-print case remains: if the machine crashes in
   the instant between Slack accepting a post and the server writing it
   down, one duplicate is possible — bounded, visible, and caught by the
   next net. Separately, sending byte-identical long text to the same
   conversation twice within ~15 minutes is suppressed (short acks like "on
   it" are never suppressed).
5. **The broken internal route gets refused, not just gated.** We found that
   `/internal/slack-forward` looks like it was meant for *incoming* messages
   but actually sends *outgoing* ones — an echo bug that has never run live
   (nothing calls it). Both external reviewers agreed that politely gating a
   bug still ships a bug, so until the next phase rebuilds it properly, the
   route now answers with a clear "this route is misdirected" error instead
   of sending anything.

## The safety philosophy (why the failure directions matter)

The house rule is: **a delivery system's own failures must never silence the
agent.** So every failure here leans toward delivery: if the queue can't
open, the message still sends directly; if a retry engine breaks, queued
messages sit safely on disk instead of being deleted; if retries run out, you
get exactly ONE clear escalation notice (not a flood). When a channel is
permanently dead (archived, bot kicked out), the heads-up about it goes to
your attention queue — not into the dead channel, where you'd never see it
(a review catch). The only thing allowed to withhold a message is the safety
gate itself making a real "this contains a leak" verdict — and the retry
engine is never allowed to overrule it. One address rule with teeth: if the
stored ID and the stored channel name ever disagree about where a queued
message should go, the system refuses to deliver to either and asks for
attention — it never guesses.

Every dropped or refused message leaves a trace: a counter and a line in an
audit log (`logs/delivery-recovery.jsonl`). "It vanished and nobody knows
why" is structurally impossible.

## How we'll know it works (the live proof)

Cut the network in the middle of a Slack reply. The message must show up in
the Slack thread **exactly once** after the network returns — not zero times
(loss) and not twice (duplicate) — with the retry visible in the audit log.

## Rollout

Ships dark on the fleet. On the development agent it runs first in dry-run —
and dry-run is honest by design: it logs what it *would* retry but never
marks anything "delivered" and never posts (the review caught that a
sloppier dry-run could have recorded fake deliveries and lost real
messages). Then live after the proof above passes. While the Slack lane is
switched off or drying, queued Slack messages are HELD — marked as on-hold
right on the row — and the boot-time cleanup that deletes stale rows must
skip both lanes that aren't live and rows carrying the hold marker, so a
message that never got a chance to deliver can never be deleted (round one
caught the June-5th silent-deletion accident recurring one level up; round
two caught it AGAIN inside the fix, because the protection relied on timing
instead of a durable marker — hence the marker). A parked message also re-checks its
reason on a short cadence and is released the moment the reason clears (the
lane turns on, the right machine takes over, a rate window passes) — the
third review round caught that without an explicit release rule, "parked"
could quietly have meant "parked forever". And release itself is recorded
on the row, because the fifth round caught that a just-released backlog
looked "stale" to the boot-time cleanup if a restart landed before it
finished sending — released messages now get a fresh grace window instead
of being mistaken for ancient leftovers. And a message can't sit parked
forever either way: after a week on hold it's surfaced loudly to your
attention queue instead of being quietly dropped. Config keys:
`monitoring.deliveryFailureSentinel.channels` and `.slackDryRun`. Existing
agents get the changes through the normal update path — the database upgrades
itself additively on boot, and the Slack reply script refreshes via the
standard template-refresh machinery.
