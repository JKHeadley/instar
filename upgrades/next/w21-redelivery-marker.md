---
change_type: fix
---

## What Changed

When instar hands a session the same message a second time, that copy now says so.

instar has a safety net called no-loss recovery: if a message arrives, gets picked up by a session, and no reply is recorded within the processing window, instar assumes the reply was lost and re-delivers the message. That net is why a message doesn't silently vanish when a session dies mid-turn.

The second copy was already labelled internally — it gets its own `replay-` id and a flag saying it is a replay — but the flag stopped short of the words the session actually reads. The two payloads handed to the agent were byte-for-byte identical, so a re-delivered message was indistinguishable from a brand-new instruction. On 2026-08-20 that produced the failure it predicts: an instruction that was 21 hours old, and had already been superseded, was re-delivered and read as current.

The flag now travels the remaining few inches into the message tag:

```
[telegram:29723 "Window 21" from Justin (uid:12345) — RE-DELIVERED — no reply was recorded for this message] Start the migration now.
```

The change is additive only. It runs after the decision to deliver has already been made, so it cannot refuse, delay, reorder or drop a message; if it failed entirely, messages would still arrive, just unlabelled. A first delivery is byte-identical to before. The label is minted from an in-process flag and never from message text, so a message whose body merely contains that phrase cannot make itself look like a system re-delivery.

## What to Tell Your User

Nothing about your messages changes. This only affects what your agent sees when instar re-sends it something.

If you have ever wondered why an agent suddenly acted on an instruction you gave hours earlier and had since moved past — this is the fix for that. Your agent can now tell "you just asked me this" apart from "the system handed me this again because it thought I never answered you," so a stale instruction reads as stale instead of urgent.

You do not need to do anything. There is no setting, no command and no migration.

## Summary of New Capabilities

- A message re-delivered by instar's own no-loss recovery now carries a visible `RE-DELIVERED — no reply was recorded for this message` marker in its tag, so an agent can tell a re-delivery from a fresh instruction.
- The marker also rides the reference line of a long message — the line an agent reads before opening the saved file — so long instructions, which is what the observed re-deliveries actually were, are marked where it counts.

## Evidence

Three test tiers cover both directions plus the forgery case: `tests/unit/redelivery-marker.test.ts` (12), `tests/integration/redelivery-marker-injection.test.ts` (11), and `tests/e2e/redelivery-marker-e2e.test.ts` (9). The e2e tier replays the 2026-08-20 incident as a regression test and asserts the thing that was actually broken — that a first delivery and its re-delivery are no longer byte-identical — plus that an ordinary conversation gains no marker anywhere, that a re-delivered message stays parseable by every downstream tag consumer, and that a body forging the marker text produces an unmarked delivery.

## Known Limits

This makes instar's *own* re-delivery visible. It says nothing about an actual external replay; that is a separate, larger problem and no verdict is read here.

One delivery route stays unmarked: the durable-queue drain tail carries only a message id string, not the in-process flag, so a message re-delivered through that route arrives unlabelled exactly as before. Closing that means adding a column to a durable store, which was deliberately left out of this change.

Non-Telegram channels are untouched, because the no-loss recovery is Telegram-only today.
