# ELI16 — Teaching an idle agent when it's safe to "go to sleep"

## What this is, in plain English

Every instar agent runs a full background server all the time — even when nobody
has talked to it for hours. On a machine running ~9 of them, that idle cost is the
biggest drain on the laptop. The end goal (Stage B of the agent-sleep design) is:
when an agent has been completely idle for a while, it drops almost everything to
near-zero and instantly wakes back up the moment a message arrives — like a laptop
sleeping and waking.

That's a risky thing to build, because if an agent sleeps at the wrong moment it
could miss a message or get stuck. So this change builds the SAFE HALF first: the
part that decides *"is it actually safe to sleep right now?"* — and nothing else.
It watches, it decides, it writes down what it would have done — but it never
actually stops anything yet.

## How it decides

It answers with one of four words:

- **awake** — a work session is running, or someone was active in the last couple
  of minutes.
- **idle-shallow** — quiet, but not quiet long enough yet.
- **keep-awake** — quiet long enough to consider sleeping, BUT a safety guard says
  no.
- **would-sleep** — quiet long enough AND every safety guard is clear.

The safety guards are the important part. It will NOT say "would-sleep" if:

- this machine is the one currently in charge of answering messages (in a
  multi-machine setup, it must hand that off first), or
- there's work in flight (a message being handled, a recovery running), or
- a scheduled job is about to fire in the next couple of minutes.

Each guard names itself in the reason, so when you ask "why is this agent still
awake?" you get a plain answer like "holds the multi-machine serving lease."

## Why this is safe to ship right now

It ships **off by default**, and even when turned on it runs in **dry-run** — it
only writes its decision to a log file (`agent-sleep-events.jsonl`) and serves it at
a `/sleep` status check. It has no power to stop a server. The whole point of
shipping it dark first is to watch real agents for a while and confirm: does a real
idle agent actually reach "would-sleep," and was every "keep-awake" correct? Only
once that's proven does the next slice wire the part that actually stops and wakes
the server.

## What you need to decide

Nothing risky. This is the foundation slice of the Stage B you asked me to build
now. It can't break anything because it never acts — it just makes the sleep
decision visible and testable. If it's ever wrong, you'd see it in the log without
any agent ever having slept. The next slice is the actual stop-and-wake mechanism,
and it'll only get built on top of a decision layer we've watched behave correctly.
