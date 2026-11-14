---
title: "A machine that cannot serve a message says so"
slug: "session-pool-no-silent-drop"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "docs/specs/session-pool-no-silent-drop.eli16.md"
review-convergence: "2026-11-04T13:25:13.000Z"
review-iterations: 2
review-completed-at: "2026-11-04T13:25:13.000Z"
review-report: "docs/specs/reports/session-pool-no-silent-drop-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: "echo (autonomous run; Justin 2026-11-03 17:11 PST, topic 136110, 'yes, agreed' to on-for-new-agents, proven parts first; first item of step 2 in docs/specs/session-pool-default-on.md)"
---

# A machine that cannot serve a message says so

## Problem statement

`DeliverMessageHandler` records the receipt and acks `queued`, and only then does `onAccepted` find out it
cannot do anything: it returns silently when the pool stage is `dark`, when the key is Slack and Slack is not
set up here, or when there is no Telegram adapter. The router reads `queued` as delivered, so the message is
gone. A join-built standby has no Telegram, so this is the first thing that would lose messages if routing
were on for new agents, and it is also what makes `enabled:false` an unsafe rollback with conversations open.

## Proposed design

`createDeliverMessageHandler` gains an optional `refusal` object holding `canServe` and `alreadyReceived`
together, so one cannot be set without the other. `canServe(command)` is asked after the epoch and sender checks
and before the receipt. False returns `{ accepted: 'stale-ownership' }`, with no receipt and no hand-off. One
exception: a message already received here, read through the read-only `alreadyReceived`, answers `duplicate`.
Otherwise a message processed before the machine went dark, with its ack lost, would be handed back and run
twice. This covers retries that pass the epoch and sender checks; a retry at an older epoch is refused as stale
before this point, exactly as today.

**Why that ack.** Peers reject unknown values, and an older router would misread a new one. Every router
already treats `stale-ownership` as "this is still yours": on the placement hop it takes the placement back and
handles the message locally, and on the forward hop it re-resolves and re-places. A peer on a new build
protects routers on old builds with no change there.

`server.ts` supplies `canServe`, mirroring those three returns. A dashboard start is exempt: it needs no
channel and runs before those returns.

A forward to an owner that cannot serve re-places, which may choose the same machine; that hop is the placement
hop, which takes the message back and handles it here, or failing that queues it. Hops are bounded by the
router's existing limits. A lost claim race can restart its forward count; that is unchanged, and it needs a
real race on every hop to repeat.

Placement does not yet avoid such a peer for Telegram, because the Telegram route passes no `channel`. Each
message to it costs one extra hop and is not lost. Passing it is a separate item of step 2
<!-- tracked: topic 137054 -->, because it changes placement on live agents.

## Decision points touched

- **Receive refusal:** invariant, fails toward the sender keeping the message. It reads facts about this
  machine, not message content.

## Multi-machine posture

Machine-local check, existing ack value, no new wire shape. The protection comes from the receiver: an upgraded
receiver protects any router, and an old receiver still drops. Nothing relies on this until step 2, which only
activates new pairs on a build that has it.

## Testing

Unit on each side of the check, including that a refusal leaves no receipt so a later delivery is accepted, and
that processed, ack lost, then unable to serve answers duplicate.
Integration with a real router and a real handler, on both hops. A wiring test holds `canServe` and the silent
returns in `onAccepted` together, so they cannot drift apart unseen. Single machine: no deliver path, no change.

## Maturation plan

- **ladder:** multiMachine.sessionPool.stage

Not a flag: a machine that cannot serve always refuses, because the alternative is a lost message. Its measure
is the `refused forwarded message` log line, read on the step 2 test pair.

## Migration

None. No config, no state.

## Rollback

Revert the release. No state.

## Open questions

None.
