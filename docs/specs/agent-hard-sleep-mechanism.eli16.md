# ELI16 — Actually letting an idle agent sleep, and wake when you message it

## What this is, in plain English

The previous slice taught an idle agent how to DECIDE "is it safe for me to sleep
right now?" — but it never actually slept; it just watched and logged. This slice
builds the part that ACTS on that decision: when an agent has been idle long enough
and it's safe, its heavy background server actually stops to save your machine's
resources, and then it wakes back up the instant you send a message — like a laptop
sleeping and waking.

## How it works (the handshake)

There are two always-running pieces: the heavy "server" (does the real work) and a
tiny "lifeline" that just listens for your messages. A small "supervisor" babysits
the server and normally restarts it if it ever goes down.

- **Going to sleep:** when the decision says "safe to sleep," a little file gets
  written (`sleep-requested.json`). The supervisor sees it, stops the server, and
  drops a "I am intentionally asleep" marker. Critically, while that marker is set,
  the supervisor does NOT treat the stopped server as a crash — it won't keep
  restarting it. (That one change is the whole trick, and it's a no-op unless the
  agent actually went to sleep.)
- **Waking up:** you send a message. The lifeline (still listening) notices the
  server is asleep, writes a `wake-requested.json` file, and holds your message in
  its existing durable queue. The supervisor sees the wake file and starts the
  server back up. Once it's healthy, your held message is delivered — nothing is
  lost. You'd see a brief "waking up…" pause, like when the agent compacts its
  memory.

## Why it's safe to ship now

It's **off by default**, and the file that triggers a sleep is only ever written
when sleep is explicitly turned on. So on every normal agent, none of this does
anything — the server stays up exactly like today. There's also a belt-and-braces
safety: if some outside watchdog force-restarts the whole agent while it's asleep,
the supervisor reads the "intentionally asleep" marker on startup and stays asleep
instead of fighting it — so it can't get stuck flapping, and it can't get bricked.

The risky existing behavior — "if the server crashes, restart it" — is completely
unchanged except in the one case where the agent chose to sleep. The existing
supervisor tests all still pass to prove that.

## What you need to decide

Nothing to flip today. This ships dark. The real decision — turning sleep ON — is
the part worth doing carefully: we'd enable it on one test agent first, with you
watching, and confirm it actually sleeps when idle and wakes cleanly when messaged,
before it ever touches a real agent you use. A few refinements (making a due
scheduled job wake the server, and showing "asleep" instead of "down" on the health
page) come with that enablement; the dark mechanism is safe without them.
