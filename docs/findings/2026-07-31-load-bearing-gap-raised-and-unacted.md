---
title: "The guard for 'his messages never arrive' exists, is correctly labelled load-bearing, was correctly raised as an unguarded critical path — and the failure it guards ran ~30 hours anyway"
date: 2026-07-31
author: echo
machine: Mac Mini
severity: high
status: open
kind: finding
relates:
  - "src/monitoring/StrandedTopicSentinel.ts"
  - "docs/findings/2026-07-31-accumulating-memory-never-synthesises.md"
  - "docs/findings/2026-07-31-constitution-asserts-an-audit-that-does-not-exist.md"
---

## The claim

`StrandedTopicSentinel` was built for one specific wedge. Its own header describes it:

> a durable ownership record names a machine that is online-by-heartbeat but quota-walled or
> adapter-disconnected, while a healthy machine holds the lease. Inbound routes to the owner that
> cannot serve it → silently dead for that topic; outbound still flows from the healthy machine
> (**the "my replies send but his messages never arrive" split**).

That is, verbatim, the state the `instar-codey` agent has been in. Measured 2026-07-31:

| observation | value |
|---|---|
| last inbound Telegram message codey recorded (Mini) | **2026-07-30T01:47:57Z** (~30h earlier) |
| codey outbound in the same window | steady — four posts on the evening of 07-31 alone |
| messages sent to him across two topics that produced no action | 3 |
| `monitoring.strandedTopicSentinel.enabled` — **echo** | `true` |
| `monitoring.strandedTopicSentinel.enabled` — **instar-codey** | **absent** (resolves dark) |

The guard exists. It is enabled on the agent that is fine, and absent on the agent it was built for.

## The part that matters

**This was not an undetected gap.** The guard-posture layer classifies this guard
`loadBearing: true` with the critical path named as *"inbound message reachability (detects an
online-but-unable-to-serve owner so inbound is not silently dead)"*, and it raises a HIGH
`load-bearing-gap` attention item for exactly this condition. That item has been raised. I saw one
in the operator's Telegram earlier the same evening, in a list of load-bearing gaps, and did not
register what it was telling me.

So the chain performed as designed right up to the last step:

1. The failure mode was anticipated → a sentinel was built for it. ✅
2. The sentinel was correctly classified load-bearing on a named critical path. ✅
3. Shipping it dark was correctly detected as a load-bearing gap. ✅
4. The gap was raised as a HIGH attention item. ✅
5. **Nothing downstream of the alert acted on it.** ❌
6. The anticipated failure then occurred and ran ~30 hours, on the operator's stated top priority.

**The alarm about the missing alarm was working.** That is the finding. Adding another detector
would add a seventh step to a chain that already fails at the fifth.

## Two structural gaps this exposes

**1. A load-bearing gap is a notice, not a countdown.** The existing surface offers three
resolutions — graduate the guard, let it soak, or record an owned accepted-fallback (PIN-gated).
An item that is none of the three simply persists as an open notice at unchanging priority. There
is no escalation with age for a *critical-path* guard, so "raised and ignored" and "raised and
under consideration" look identical forever.

**2. Guard posture is per-agent, and the agent that is fine cannot see it.** `GET /guards`
answers for this agent; `?scope=pool` merges across *machines of the same agent*. Nothing compares
posture across **agents** on a host. My own guard list is green for this guard — the gap lives on
Codey's list, and the agent best placed to notice (the one trying to reach him, watching the
symptom) has no view of it. On a host running nine agent homes, that blind spot is structural.

## What closes it

- **Age-escalation for a load-bearing gap on a critical path.** Not a new detector — a slope on
  the existing one. A gap that stays open past a threshold gets louder and names the failure it is
  guarding against in the operator's own words ("inbound may be silently dead for this agent"),
  rather than repeating a config key at unchanging priority.
- **A cross-agent posture read.** A host-local comparison of load-bearing guard posture across
  agent homes, so "this guard is on for me and off for the agent I depend on" is a question that
  can be asked. Read-only; the existing per-agent surface stays authoritative.

## What I did, and its limits

Set `enabled: true` in the codey agent's config (backed up first). It is signal-only — the
sentinel's own header states it mutates nothing: no ownership CAS, no pin write, no session kill —
so the change is low-risk and reversible. I deliberately did **not** restart that agent, as it was
mid-run; the change takes effect at its next natural restart, so **the guard is not yet running**.

Honest limits:

- The ~30h inbound figure is from the **Mini's** record. Topic 458 is pinned to a second machine
  whose records I cannot read, so the precise claim is "the machine I can reach recorded no
  inbound in ~30h", not "no inbound reached him anywhere." The undisputed part is the outcome:
  three messages, two topics, no action, while he worked steadily on something started earlier.
- I have **not** verified that enabling the sentinel would have caught this instance — only that
  the condition it describes matches the observed symptom. The sentinel is dark-gated and unproven
  on this pair of machines.
- An earlier version of this diagnosis attributed the fault to `LiveTailSource` flush failures
  (743 of them in codey's log). That was wrong: those stream terminal output to a standby for the
  dashboard, are unrelated to message ingress, and do signal once per episode (66 times). Recorded
  because the mistake is the same class this document is about — a confident mechanism attached to
  a real symptom without checking the mechanism.
