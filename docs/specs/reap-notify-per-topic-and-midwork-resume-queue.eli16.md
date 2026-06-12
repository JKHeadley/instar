# Per-Topic Reap Notification + Mid-Work Resume Queue — Plain-English Overview

> The one-line version: when the system has to kill one of my working sessions, you always
> get told in the conversation it belonged to, and if it died mid-task it goes into an
> ordered queue that brings it back automatically once the machine has recovered.

## The problem in one breath

On June 11 the machine got overloaded and the system started killing sessions to save
itself. Two things went wrong from your side: you were barely told (one summary message in
a system channel, nothing in the actual conversations that lost their sessions), and the
sessions that were killed in the middle of real work just stayed dead until you happened to
message them. You asked for two fixes: always notify the right conversation, and bring
mid-work sessions back automatically, in order, once there's room.

## What already exists

- **The reaper** — kills sessions under resource pressure, age limits, or quota walls. It
  already keeps an audit log of every kill.
- **A notifier** — already tries to tell you about kills, but when several happen at once
  it sends ONE combined message to a system channel, so the affected conversations hear
  nothing. Worse, its delivery path silently swallows failures.
- **A "was it working?" check** — the system already knows whether a session shows signs of
  active work (builds running, sub-agents, open commitments), but it throws that knowledge
  away at kill time.
- **Resume machinery** — a killed conversation CAN be picked back up, but today only when
  you happen to send a message to it.

## What this adds

The biggest change: every conversation that loses a session gets its own notice, in plain
English, delivered through a durable path that retries on failure and records whether it
actually got to you — "did the user get told?" becomes a fact the system can look up, not a
hope. Second: kills now get stamped with whether the session was mid-work (measured by the
component doing the killing, at the moment it decides — review caught that measuring it any
later records "not working" for exactly the kills that matter). Mid-work sessions go into a
durable, ordered queue. A drainer brings back AT MOST ONE per minute, only after the
machine has been calm for several minutes straight, with honest wording ("restarted to pick
the work back up"). It validates reality first — is the conversation still on this machine,
has nothing else already restarted it, does the working folder still exist — and gives up
loudly (never silently) when something's wrong.

## The safeguards

**Can't flood you.** Notices are bounded by the number of affected conversations, urgent
ones are capped per burst, and all "the queue is struggling" alerts collapse into ONE
rolling status item instead of one per entry.

**Can't loop forever.** A session that gets killed, revived, and killed again hits a
resurrection cap (tracked by stable identity, so it can't be dodged). A circuit breaker
stops the drainer entirely if restarts keep failing. Everything that gives up says so.

**Can't fight the operator.** Your kills don't queue for revival. An emergency stop pauses
the whole queue, and nothing can quietly un-pause or work around it.

**Honest delivery.** The review found the existing delivery engine was off by default
fleet-wide and had a startup bug that silently deleted delayed messages — this ships its own
always-on delivery loop and fixes the deletion bug for everyone.

## What ships when

Part A (per-topic notices + durable delivery) ships ON for everyone — it's a correctness
fix. Part B (the resume queue) ships in observe-only mode fleet-wide and goes live on me
(the dev agent) first; the fleet flip happens only after a soak that proves the mid-work
detection actually fires on real overload kills.

## What you actually need to decide

Read this and the convergence report, then approve the spec (`approved: true`) so the build
can start — the design went through 7 review rounds with 5 internal reviewers plus GPT and
Gemini until no material findings remained.

> **Status update (2026-06-12):** Approved by Justin (topic 24662). The build is in
> progress on branch `echo/reap-notify-resume-queue` under the constitutional parent
> principle **Close the Loop** — interrupted work is durably registered and re-surfaced
> until it reaches a deliberate close, and every notice's delivery outcome is recorded.
