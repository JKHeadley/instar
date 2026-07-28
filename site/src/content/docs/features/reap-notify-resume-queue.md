---
title: Reap notices & the mid-work resume queue
description: Every autonomous session kill notifies the conversation it belonged to, and sessions killed mid-work are queued for ordered automatic revival once the machine recovers.
---

When an Instar machine comes under resource pressure, the session reaper sheds
load by killing sessions. Two failure modes used to follow: the user was barely
told (one combined summary in a system channel — nothing in the conversations
that actually lost their sessions), and a session killed in the middle of real
work stayed dead until someone happened to message its topic. This feature
closes both gaps. (Spec:
`docs/specs/reap-notify-per-topic-and-midwork-resume-queue.md`.)

## Per-topic reap notices

`ReapNotifier` groups kills per affected topic: every conversation that lost a
session gets one notice in that conversation — what was killed, the reason in
plain English, whether it was mid-work, and whether a restart is queued. The
lifeline topic receives only unbound sessions plus a cross-topic index, never
the whole story. Mid-work notices with a queued resume release immediately
(held through quiet hours); routine reaps batch into the existing summary
cadence, capped per flush.

Delivery is durable: notices are enqueued as a dedicated lane in the
PendingRelayStore and delivered by `ReapNoticeDrain`, a small always-on loop
(claim → send → record, with backoff and a single aggregated escalation item
when retries exhaust). A Telegram hiccup delays a notice instead of eating it,
and every outcome lands in the reap-log as an `enqueued` → `sent` /
`send-failed-escalated` pair, so "did the user get told" is auditable.

## Killer-stamped work evidence

Whether a session was mid-work is decided by the component that kills it, at
its decision moment — not reconstructed afterwards. The quota-shed migrator
snapshots evidence before its Ctrl+C grace destroys it; the idle reaper
asserts an authoritative empty set (an idle-reap means it proved no work).
Evidence names come from the closed `WorkEvidence` vocabulary (an active build
or autonomous run, an open commitment, a live subagent, a recent user message,
a pending injection) and are clamped at the kill chokepoint, then stamped onto
the reap event, the reap-log row, and the session record.

## The resume queue

Terminal autonomous reaps of mid-work sessions enter `ResumeQueue` — a
durable, per-machine, ordered queue (interactive sessions before jobs, then
first-in-first-out) with stable-key dedupe, a resurrection ledger that caps
kill→resume→kill loops, a 24-hour TTL, and a single-writer lockfile.

`ResumeQueueDrainer` revives at most one entry per tick, and only after the
machine has been calm for several consecutive ticks on the same pressure gauge
the reaper reads, quota allows a spawn, the session cap has room, and no
account migration is in flight. Before any spawn it re-validates reality —
a live session for the topic, a stale resume UUID, the topic having moved
machines, a binding mismatch, an operator stop, or a missing working directory
each invalidate the entry rather than spawn something wrong. Failures walk a
ladder (three attempts with backoff → give up loudly, once), and a breaker
pauses all attempts after consecutive failures. Revived sessions restart with
an honest "you were shut down mid-work, pick the work back up" prompt and the
working directory recorded at kill time.

The queue ships **observe-only** (`dryRun: true` as a code default): entries
and would-resume audits accumulate so its judgment can be verified in the
field before it is allowed to spawn anything. Operator kills never enter the
queue — a session you chose to stop stays stopped. Jobs participate only when
their definition sets `resumeOnReap: true`.

## Reading and steering it

```bash
# Queue state: entries, paused/breaker state, lastTickAt (a wedged drainer is visible here)
curl -H "Authorization: Bearer $AUTH" http://localhost:4040/sessions/resume-queue

# Levers
curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4040/sessions/resume-queue/ENTRY_ID/cancel
curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4040/sessions/resume-queue/ENTRY_ID/requeue   # gave-up entries only
curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4040/sessions/resume-queue/resume             # unpause after an emergency stop
curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4040/sessions/resume-queue/drain              # one manual step; quota gates still apply
```

Emergency stops reach the queue: "stop everything" pauses it (resumes are
refused until an explicit unpause), and an explicit per-topic stop cancels
that topic's queued entries.

Configuration lives under `monitoring.reapNotify` (per-topic grouping, flush
caps, the durable-drain lever) and `monitoring.resumeQueue` (enabled/dryRun,
attempts, TTL, resurrection caps, job opt-in) in `.instar/config.json`.
