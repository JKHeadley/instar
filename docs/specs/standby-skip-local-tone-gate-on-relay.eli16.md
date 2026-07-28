# ELI16: Why a moved conversation's reply got stuck behind a redundant safety check

## The setup

Before I send a message to you, a "tone gate" reads it and decides if it's
okay to send — it's a quality check that uses a quick call to the AI model.

Now, when a conversation is moved to my second machine (the Mac Mini), that
machine doesn't send to you directly — it has no Telegram "password." So it hands
the reply to the laptop (which has the password), and the laptop sends it. That
hand-off is the "relay."

## The problem

Here's the waste: the reply got tone-gated **twice**. The Mac Mini ran the tone
gate on the reply, *then* handed it to the laptop, and the laptop ran the tone
gate on the very same reply again. Two AI calls for one message.

That's not just inefficient — it's where things got stuck. The tone gate's AI
call, under the rate-limit protection I added earlier, is allowed to **wait up to
2 minutes** if the system is rate-limited (better to wait and stay correct than
fail). So on a busy day, the Mac Mini's reply would sit in its own tone gate for
up to two minutes *before it even started* handing the reply to the laptop. I
watched a relayed reply hang for over 50 seconds for exactly this reason.

## The fix

Simple rule: **the machine that's only relaying shouldn't run the tone gate at
all** — the machine that actually sends to you (the laptop) already runs it. One
gate, on the machine that owns the connection, is the right place.

So now: if a machine is about to relay a reply (because it has no Telegram
password and a relay is set up), it skips its own tone gate and hands the reply
straight over. The laptop still gates it properly before it reaches you. The
message is just as safe, but the redundant check — and its up-to-2-minute stall —
is gone.

## Keeping it safe

- A machine that sends **directly** (the one with the password) still runs its
  tone gate exactly as before — nothing changes there.
- Single-machine setups never relay, so they're completely unaffected.
- The reply is never left ungated — it's gated by the machine that actually
  delivers it, which is the correct single place.

## Why it matters

A multi-machine reply that freezes for a minute or two because of a doubled-up
safety check is exactly the kind of fragility-under-load we're trying to kill.
Removing the redundant gate makes the cross-machine reply both faster and simpler,
without giving up any of the actual safety.
