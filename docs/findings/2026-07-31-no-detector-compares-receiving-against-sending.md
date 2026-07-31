---
title: "An agent can go completely deaf, keep talking, and pass every health check indefinitely — nothing compares 'am I still receiving?' against 'am I still sending?'"
date: 2026-07-31
author: echo
machine: Mac Mini
severity: high
status: open
kind: finding
relates:
  - "docs/findings/2026-07-31-load-bearing-gap-raised-and-unacted.md"
  - "src/monitoring/StrandedTopicSentinel.ts"
---

## The incident, resolved

`instar-codey`'s Telegram connection went stale — not disconnected, not erroring, not rate-limited.
It simply stopped receiving. Its own startup line, once restarted, states the whole thing:

```
[Lifeline] Stale connection flushed
  Telegram polling active
  15 queued messages from previous run
```

Inbound had been frozen since **2026-07-30T01:47Z** — about 30 hours. In that window the agent:

- posted outbound repeatedly (four times on the evening of 07-31 alone, timestamped)
- ran its scheduled jobs
- answered `/health` with `200`
- held its serving lease
- accumulated **15 undelivered messages** from its operator and from me

Every health surface was green. The agent was completely deaf.

## Why nothing caught it

I checked the obvious candidates before writing this, because "no detector exists" is exactly the
kind of claim that turns out to be wrong:

| candidate | what it actually watches | would it have caught this? |
|---|---|---|
| `/health` | process liveness, subsystem construction | **No** — all green throughout |
| `StrandedTopicSentinel` | an owner machine online-but-unable-to-serve, from the *pool's* view | **No** — and it was dark on this agent anyway (see sibling finding) |
| `DeliveryFailureSentinel` | **outbound** relay failures, drains a pending-send queue | **No** — outbound was healthy |
| `DeliveryRetryManager` | **outbound** ack timeouts | **No** — same direction |
| PresenceProxy | a user message going unanswered *past a threshold* | **No** — it needs an inbound message to notice one is unanswered |
| rope-health / mesh transport | machine-to-machine reachability | **No** — this was the platform connection, not the mesh |

The pattern is uniform and it is the finding: **every delivery guard we have watches the outbound
direction.** They exist because the failures we have historically been burned by were "my message
didn't reach them." Not one of them asks the mirror question.

PresenceProxy is the near-miss worth naming: it *is* about inbound, but it triggers on *an inbound
message that goes unanswered*. When inbound stops entirely, it has nothing to fire on. A famine is
invisible to a detector that watches individual meals.

## Why "no inbound for N hours" is the wrong signal, and what the right one is

The naive detector — alert when inbound has been silent for N hours — is unusable. A quiet operator
is normal, overnight is normal, a job-only agent may legitimately receive nothing for days. It would
be either deafening or useless depending on N.

The signal that is actually available locally, and unambiguous:

1. **Asymmetry.** Sustained outbound (or session/job activity) while inbound is *exactly zero* over
   the same window is a different state from a quiet agent, which is quiet in both directions. The
   comparison, not either count, is the signal.
2. **The platform connection's own age.** A long-poll connection that has not returned *anything* —
   not a message, not an empty-update tick — for far longer than its own poll interval is faulty by
   construction. Codey's interval is 2s; the connection was silent for 30 hours. That ratio needs no
   threshold-tuning, and it is the strongest available signal because it does not depend on whether
   anyone happened to send anything.
3. **The evidence already existed and was never read.** "Stale connection flushed / 15 queued
   messages" was computed *at restart*. The system knew. It only knew at the moment the fault ended,
   and it told no one.

(3) is the sharpest form of it: this was not undetectable. It was detected, once, too late, and
logged rather than raised.

## The blind-spot class

> **A guard built from an incident inherits that incident's direction.** Every delivery guard here
> was earned from a message that failed to go out, so all of them watch outbound. The mirror failure
> was never *decided against* — it was never considered, because no incident had yet pointed at it.
> A guard set assembled incident-by-incident is complete only in the directions we have already been
> hurt in.

This is the sibling of the two findings filed earlier today (`accumulating-memory-never-synthesises`,
`constitution-asserts-an-audit-that-does-not-exist`): in each case the individual components are
correct and the gap exists only in what nobody thought to compare.

## What closes it

- **An ingress-liveness check on the platform connection itself.** Not "has anyone messaged me" but
  "has my long-poll returned anything at all in ≫ poll-interval." Local, cheap, no threshold
  guesswork, no false positive on a quiet operator.
- **Raise the stale-connection detection that already exists, instead of only logging it at restart.**
  If the flush path can compute "stale connection, 15 queued" at startup, the same condition can be
  evaluated while running.
- **A direction-asymmetry signal** as the backstop: outbound active + inbound exactly zero over the
  same window. Weaker than the connection check and more prone to noise, so it belongs behind it,
  not instead of it.

## Honest limits

- The 30-hour figure is from the machine I can read. A second machine holds one of the topics and
  keeps its own record; I could not read it. What is not in doubt: 15 messages were queued and
  undelivered, and three of mine sent across two topics produced no action until the restart.
- I have **not** verified that any of the three proposed checks would have fired on this instance.
  The connection-age check is the one I would build first precisely because it is the only one whose
  correctness does not depend on traffic patterns — but that is an argument, not a measurement.
- The candidate table above is from reading each component's purpose, not from executing them
  against this fault. A detector I mis-classified as outbound-only would weaken the claim; the
  uniformity across six of them is what makes me confident in the shape.
