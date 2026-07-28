# ELI16 — When the agent can't finish a message, tell the user instead of dropping it silently

## The one-sentence version

If a message gets stuck (the machine handling it crashed or got handed off mid-thought), the agent retries it a few times — but when it finally gives up, it used to just go quiet AND keep logging "giving up" forever. Now it cleanly closes the message out and tells the user "I didn't get to this — resend if you still need it," so nothing vanishes in silence.

## What's going on today

Every incoming message is tracked in a little durable ledger: received → being-worked-on → replied → done. This is what guarantees "no message is lost and no message is answered twice," even if a machine crashes or the conversation hops between machines mid-reply.

When a message is stuck in "being-worked-on" too long (the machine that grabbed it died or was taken over), a recovery routine re-runs it from its saved text. To avoid an infinite retry storm, it gives up after 3 tries.

The bug is in what "give up" did: **nothing**. It logged a line and moved on, but:

1. **It never told the user.** A real message the user sent just... never got a reply, and they were never told. They're left waiting forever. (This is exactly what happened on 2026-06-15.)
2. **It never closed the message out.** The message stayed marked "being-worked-on," so the recovery routine kept *re-finding* it every cycle and logging "giving up on it after 3 attempts" — the same message, every ~10 minutes, for hours. Pure noise, and a sign the message was stuck in limbo, neither answered nor cleanly abandoned.

## What's new

Two changes, both in service of "a dropped message is never silent":

1. **A real terminal state.** The ledger now has an "abandoned" status. When recovery gives up, it marks the message *abandoned* — which moves it out of "being-worked-on" so the recovery routine stops re-finding it (the every-10-minute log loop ends), and a later redelivery of that exact same message is recognized and dropped (we already decided we're done with it). Crucially, "abandoned" is NOT recorded as "replied" — so it can never trick the system into thinking the topic was answered when it wasn't.

2. **An honest notice.** The moment a message is abandoned, the agent posts one plain-English line to that conversation: *"I didn't get to N message(s) you sent earlier — I tried but couldn't complete the turn. Resend anything still needed."* This mirrors the existing "loss is never silent" notice the durable message queue already uses.

## What's deliberately unchanged (the safety net)

- A message that's **still being worked on** (within its time budget) is untouched — only genuinely-exhausted, stuck messages are abandoned.
- A message that **was actually answered** (even if its own bookkeeping failed to commit) is still recognized as handled and committed, never abandoned.
- The retry budget itself is unchanged — we still try 3 times before giving up; this only fixes what happens *after* giving up.
- This is the most safety-critical part of the system (the "no lost/duplicate message" ledger), so the change is strictly additive: "abandoned" can only ever be applied to a message that was *already* going to be given up on, and it never marks anything as falsely replied.

## What you actually need to decide

This is a straight correctness fix to a live bug: messages were being silently dropped AND spamming the log every 10 minutes. The change closes both — cleanly closing out the message and telling the user to resend. There's no real downside: the only new user-visible behavior is an honest "resend this" notice for a message that genuinely never got answered, which is strictly better than silence. The trade is firmly worth it.
