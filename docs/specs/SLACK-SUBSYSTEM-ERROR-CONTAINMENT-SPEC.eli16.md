# Slack Subsystem Error Containment (Net #1) — Plain-English Overview

> The one-line version: make a Slack network hiccup unable to crash the whole
> agent, by funneling every "send to Slack" through one careful helper and adding a
> second process-level safety catch that still crashes on anything genuinely unknown.

## The problem in one breath

The agent talks to Slack over an always-on network pipe (a WebSocket). If the code
tries to push a message into that pipe at the exact moment it's closing or
reconnecting, the send throws an error. On 2026-06-14 one of those errors wasn't
caught, and instead of just dropping a Slack message, it took the **entire agent
process** down for about two hours (the recovery nets were also down that day).

## What already exists

- **Two crash-recovery nets** — net #2 (the agent notices its own server died and
  respawns it in ~10 seconds) and net #3 (the operating system relaunches it if it
  vanishes entirely). Both are live now, so a crash today is a ~10-second blip, not a
  long outage. They restart a *dead* process; they don't stop one from dying.
- **A Slack reconnect engine** — already hardened: exponential backoff, a 30-second
  heartbeat that notices a dead socket, and a careful "epoch" model that stops a
  stale, torn-down socket from interfering with a fresh one.
- **A narrow, audited crash policy** — a short, deliberately tight list of
  "known-harmless" errors the process is allowed to log-and-continue on instead of
  crashing. Anything not on the list still crashes (the safe default). It already
  covers one Slack send-race message, but only the wording from an older network
  library — not the wording today's Node.js uses.

## What this adds

The core change is one small private helper, `_safeSend`, that **every** Slack
socket send now goes through. It checks the pipe is actually open, wraps the send so
an error can never escape and crash the process, returns a simple success/failure,
and — only for the heartbeat "are you alive?" probe — quietly triggers a reconnect
when the pipe itself is dead. Four scattered send calls become one funnel with one
policy, plus a test that fails if anyone ever adds a send that skips the funnel.

Secondary changes: a second process-level safety catch for "unhandled promise
rejections" (the error category the existing catch doesn't cover, and the one the
real crash actually fell into), wired through the **exact same** narrow allowlist; and
one new, tightly-anchored entry in that allowlist for today's Node.js wording.

## The new pieces

- **`_safeSend`** — the single, careful send funnel. It is allowed to: check the
  socket, swallow a send error, and (for the liveness probe only) ask the existing
  reconnect engine to reconnect. It is **not** allowed to: hold any blocking power
  over the rest of the agent, resurrect a socket that was deliberately torn down, or
  reconnect a fresh healthy socket by mistake. It is a self-healing helper, not a
  decision-maker.
- **`handleProcessLevelError`** — one shared function both process-level catches call,
  so the "crash vs. continue" decision is identical for both and can never drift
  apart. It crashes on anything not on the tiny allowlist.

## The safeguards

**Prevents a Slack glitch from crashing the agent.** Every send is wrapped; an error
on a closing/closed socket is dropped and (where appropriate) reconnected, never
escalated to a process crash. Your other chats, scheduled jobs, and memory keep
running through a Slack hiccup.

**Prevents the safety catch from hiding a real bug.** The allowlist stays tiny and
the default stays *crash* — because a crash now costs ~10 seconds (net #2), while
wrongly limping along on corrupted state could cost much more. The one new allowlist
entry is anchored to the exact "WebSocket is not open" wording so it can't
accidentally swallow unrelated "registration is not open" or "database is not open"
errors. A negative test guards that.

**Prevents silent message loss and reconnect storms.** A failed message-queue drain
keeps the unsent messages for the next reconnect instead of discarding them. A failed
acknowledgement does *not* trigger a reconnect (a single failed ack doesn't prove the
socket is dead, and reconnecting on every one would thrash) — the 30-second heartbeat
remains the recovery path.

## What ships when

One PR, shipped live (not behind a flag — it only changes behavior on the unhappy
path, and there's nothing to toggle on a good day). It reaches existing agents
through the normal `instar update`. A broader "single-writer" socket redesign that
would prevent these races by construction is recorded as separate future hardening —
it solves message-ordering, not the crash, and isn't bundled here.

## What you actually need to decide

Do you approve shipping net #1 as scoped — contain Slack socket errors at the
subsystem boundary, add the matching `unhandledRejection` catch through the same
narrow allowlist, and keep the global default as fail-toward-crash — yes or no?
