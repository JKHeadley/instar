# ELI16 — Why stall alerts vanished into silence

## The problem

The operator couldn't tell whether a session had stalled or was just working —
because for almost an hour it heard nothing. Here's what was actually happening
under the hood, and it's worse than "the agent didn't notice."

The agent's stall-detector **did** notice. It saw a session go quiet, gave it a
nudge, and tried to send the operator a message: "this session went quiet ~16
minutes ago, want me to dig in?" That message goes to a dedicated "Lifeline"
system topic in Telegram.

But that Lifeline topic had been **deleted** on the Telegram side, while the
config still pointed at it. So every send came back with `message thread not
found` — and the code did `catch { return false }`, i.e. it threw the error in
the trash and moved on. **41 times in one day** the system had something
important to tell the operator and it silently failed to send. The operator got
pure silence, which looks exactly like "nothing's wrong."

So the real bug wasn't a missing alert — it was a generated alert dying on the
way out the door, invisibly.

## What already exists

The Telegram adapter already has a method, `ensureLifelineTopic()`, that knows
how to **recreate** a deleted Lifeline topic and remember the new one. The alert
path just never called it — and worse, it hid the failure instead of reacting to
it.

## What's new

One small, shared helper that both alert paths now use. When it tries to send an
alert and the send fails, it:

1. **Logs the real error** instead of swallowing it — so a delivery failure can
   never again be invisible.
2. **Heals the topic** — calls `ensureLifelineTopic()` to recreate the deleted
   topic, then retries the send once.

If the topic is fine, nothing changes — it sends and returns immediately. Only on
a failure does the heal-and-retry kick in.

## The safeguards in plain terms

- **No silent failures, ever.** Every send failure is now logged with the real
  reason, so the next time something can't be delivered, it's diagnosable in
  seconds instead of invisible for hours.
- **Self-healing, not just louder.** A deleted system topic now repairs itself
  and the alert still gets through.
- **Zero change on the happy path.** A working topic behaves exactly as before —
  the heal logic only runs when a send actually fails.
- **Bounded.** It retries once, never loops.

## What you need to decide

Nothing — it ships as a normal patch with safe behavior. This is the foundation
under the bigger piece you asked for (stall alerts that land in the *stalled
session's own topic*, and auto-recovering the session, not just alerting): step
one was making sure these alerts can't silently disappear in the first place.
