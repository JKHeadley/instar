# Upgrade Guide — A stuck message that can't be recovered is now closed out + announced, not dropped silently

<!-- bump: patch -->

## What Changed

When an inbound message gets stranded mid-turn (the machine handling it crashed or was handed off),
recovery re-runs it a few times, then gives up. Previously "give up" did nothing useful: the message
was **silently dropped** (the user never told) AND it stayed marked "being-worked-on", so the
recovery routine kept re-finding it and logging `stuck-recovery: giving up … after 3 attempts` every
~10 minutes, indefinitely (observed firing for hours on the same entries).

Now an exhausted entry is **terminally abandoned** and **announced**: a new terminal `abandoned`
state in `MessageProcessingLedger` (`markAbandoned`) moves it out of `processing` — so `reclaimStuck`
stops re-selecting it (the log-loop ends), `beginProcessing` refuses to revive it, and a provider
redelivery of the same event is dropped (a genuine resend uses a fresh dedupeKey). It leaves
`reply_committed_at` NULL, so it never masquerades as a real reply. `recoverStuckMessages` surfaces
abandoned entries and the server emits one per-topic loss notice.

## What to Tell Your User

- **No more silently-dropped messages**: "If I ever can't finish handling something you sent — say my
  machine crashed mid-thought — I'll now tell you plainly that I didn't get to it and ask you to
  resend, instead of leaving you waiting on a reply that never comes."
- **A quieter, healthier system**: "I also fixed a case where I'd keep silently retrying the same
  failed message every few minutes, forever. Now I close it out cleanly the first time."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Honest loss notice when a stuck message is abandoned | automatic (posted to the affected conversation) |
| Stuck-recovery give-up no longer loops or drops silently | automatic |

## Evidence

Reproduction (live, 2026-06-15): `logs/server.log` showed `stuck-recovery: giving up on
telegram:21487:990487 after 3 attempts` (plus two sibling entries) firing on a ~10-minute cadence for
hours (19:07 → 20:11+), because the give-up branch did `skipped++; continue` — leaving the entry in
`processing` so `reclaimStuck` re-selected it every cycle, with no user notice.

After the fix (verified by 30/30 ledger + recovery unit tests, both sides of the boundary): an
exhausted entry is marked `abandoned` (state asserted terminal, `replyCommittedAt` NULL,
`hasReplyCommittedForTopicSince` still false, `reclaimStuck` no longer returns it), surfaced in
`result.abandoned`, and a subsequent recovery pass neither re-selects nor re-surfaces it — the
10-minute log-loop is gone and exactly one "resend anything still needed" notice is emitted per
abandoned entry. tsc clean.
