---
title: "A live conversation stays put, and a moved one gets its recent messages"
slug: "session-pool-keep-and-recall"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "docs/specs/session-pool-keep-and-recall.eli16.md"
review-convergence: "2026-11-04T18:21:00.000Z"
review-iterations: 2
review-completed-at: "2026-11-04T18:21:00.000Z"
review-report: "docs/specs/reports/session-pool-keep-and-recall-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: "echo (autonomous run; Justin 2026-11-03 17:11 PST, topic 136110, 'yes, agreed' to on-for-new-agents, proven parts first; condition named in docs/specs/lease-takeover-no-shared-medium.md)"
---

# A live conversation stays put, and a moved one gets its recent messages

Two items from the step 2 list in `docs/specs/session-pool-default-on.md`. Both are safe while the pool is dark
and neither turns anything on.

## Problem statement

**A conversation can hop mid-flight.** When the pool first reaches an agent, running conversations have no
ownership record. The next message for one goes down the router's "unowned" path, placement picks the cheapest
machine, and a peer may spawn a second session while the real one is running here.

**A moved conversation can start blank.** A machine that receives a moved conversation has no history for it, so it
asks the lease holder. That request sends this machine's own bearer token. Machines joined by pairing do not share
one, so the holder refuses, the failure is swallowed, and the session starts with no memory of the conversation.

## Proposed design

**Keep.** `SessionRouter` gains an optional dep, `liveLocalSession(sessionKey)`. In `placeAndClaim`, for a `new`
placement with a live session here, the router first runs `placement.decide` with this machine as the only candidate.
Every mandatory check still applies (online, workspace reachable, not refusing work); only cost stops counting. If
that places here with no escalation, this machine is the choice. Otherwise, as when a quota is blocked or the
workspace is gone, normal placement decides. It lives in the router, not one inbound handler, so Telegram, Slack and
the queue drain all get it.

After the CAS win the router confirms the claim at once, moving the row from `placing` to `active`. Today only
the Telegram path confirms a self-placement, after delivery. Slack and the drain do not, so a kept row left `placing`
would queue their later messages. The session is already running, so `placing` has nothing to wait for. An ordinary
self-placement is unchanged. A confirm error is logged and delivery continues.

It does not apply when the message carries a `preferredMachine` (a pin or request to be elsewhere, which must win),
when the key already has an owner, or on a failover placement. A read error means placement decides as before.

Production answers from `telegram.getSessionForTopic` for numeric keys and `slack.getSessionForChannel` otherwise,
then `isSessionAlive`. WhatsApp and iMessage have no pool routing, so they are not involved.

**Recall.** A new read-class mesh verb, `topic-history-pull`, in the same class as `topic-profile-pull`: any
registered peer may ask, and it serves this machine's own recent messages for one topic. The handler returns at most
50 messages, only the fields the context block reads, text capped at 2000 characters, and 256 KiB for the whole
response, dropping the oldest first. The verb discloses what the bearer history route already discloses to this agent's own machines.

`pullMovedTopicHistory` asks over the signed mesh first. If that fails for any reason (older holder, no Telegram
there, transport error) it falls back to the existing bearer call. Both calls have a 5 second deadline, set where
`server.ts` wires them (`timeoutMs` on the signed send, `AbortSignal.timeout` on the bearer fetch, which had none). If
both fail the session still starts, as today, but the log now says so. The answer is treated as untrusted:
wrong-shaped rows are dropped. An empty signed answer is an answer, so it does not trigger the fallback.

This recovers recent context, best effort. It is not full history: at most 50 messages from the lease holder's log, and
a holder with no record of the topic gives a blank start.

## Limits we accept

- **Keep only sees this machine.** Inbound enters at the lease holder, so this protects sessions on the holder, which
  is where an agent's conversations run before the pool first reaches it. A session with no ownership record on a
  machine that is not the holder (the lease moved while it ran) is not found, and placement decides, as it does today.
- **A failed confirm is not retried by the router.** The confirm is a write to the local ownership registry. If it
  fails, the row stays `placing`: Telegram's own confirmation after delivery still repairs it, but Slack and drained
  messages queue behind it, and the drain's escape may re-place the conversation. That takes a failing local write,
  on a path that is off for every agent until step 2, so this spec logs it and builds nothing more.

## Non-goals

- Turning the pool on, or any other step 2 item.
- Claiming running sessions up front. The claim happens on the next message, which is when a hop could happen.
- Any change to history for a machine that is the lease holder.

## Single-machine guarantee

A one-machine agent has no mesh and no router at a stage other than dark, so neither path runs.

## Rollback

Revert. The verb has no stored state, and `enabled:false` already stops all routing.

## Open questions

None.
