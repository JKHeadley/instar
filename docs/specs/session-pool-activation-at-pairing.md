---
title: "Sharing turns on when a new agent pairs its second machine"
slug: "session-pool-activation-at-pairing"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "docs/specs/session-pool-activation-at-pairing.eli16.md"
review-convergence: "2026-11-05T01:15:00.000Z"
review-iterations: 3
review-completed-at: "2026-11-05T01:15:00.000Z"
review-report: "docs/specs/reports/session-pool-activation-at-pairing-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: "echo (autonomous run; Justin 2026-11-03 17:11 PST, topic 136110, 'yes, agreed' to on-for-new-agents, proven parts first; decisions listed for override)"
---

# Sharing turns on when a new agent pairs its second machine

## Problem statement

A new agent that pairs a second machine gets no sharing. `multiMachine.sessionPool` stays off, so
conversations stay on the first machine and the second sits idle. Step 1 of
`session-pool-default-on.md` added a read-only report. This spec is step 2: turn sharing on at the
first pairing, with ceiling `shadow`, where a new conversation can start on either machine and nothing
running moves.

Already landed for this step: a machine that cannot serve hands a message back (#2723), jobs follow the
role (#2737) and a standby waits for the lease before polling (#2759). This spec depends on #2758, which
claims a live local session before routing and fetches a moved conversation's history over signed mesh.
It must merge first, because a joiner's bearer token differs from the inviter's.

Still missing, each read in the code:

- Nothing decides activation at pairing. `/api/pair` (`machineRoutes.ts:528`) writes no pool setting.
- The queue, journal replication, duplicate check and secret sync are separate keys, all off by default.
- The stage climbs only on a signed green, and the only producer is the failover runner, which is dark
  outside development agents. `dark` to `shadow` can never happen on a new agent.
- `reconcile` reverts only on a red, so a green from a long-gone peer holds `shadow` forever.
- Pool on makes the money layer self-fence paid routing (`AgentServer.ts:2425`), so activation could
  silently stop paid routing.

## Proposed design

### Change 1: one decision, before the peer is stored

New pure `src/core/sessionPoolPairActivation.ts`:

`decidePairActivation({ fileConfig, otherMachineCount })` returns `{ activate: true }` or
`{ activate: false, reason }`. It activates only when all of these hold:

- `otherMachineCount` is 0, counting every registry entry other than this machine, revoked ones
  included. A third machine is never a first pairing.
- The owner has made no choice. Update writes the shipped defaults into every agent's config, so
  `enabled:false` and `stage:'dark'` are on disk whether or not anyone chose them. A choice is therefore a
  value that differs from the shipped default for `enabled`, `stage`, `promotionModel` or
  `promotionCeiling`, or the explicit opt-out `multiMachine.sessionPool.autoActivate: false`. A partial
  setup is declined, never half-overridden.
- `routingSpend.money.enabled` is not true. The pairing still succeeds, and the reason is logged and
  shown in the readiness report.

It is called in `/api/pair` after the code is valid and before `storeRemoteIdentity`, because the count
must not include the joiner. A pair by repo URL never reaches this route, so it does not activate.

### Change 2: one list of keys, on both machines

`poolActivationKeys()` is the only list:

| Key | Value |
|---|---|
| `multiMachine.sessionPool.enabled` | `true` |
| `multiMachine.sessionPool.dryRun` | `false` |
| `multiMachine.sessionPool.activatedAtPairing` | ISO time; marks this pool as started here |
| `multiMachine.sessionPool.promotionModel` | `auto-climb` |
| `multiMachine.sessionPool.promotionCeiling` | `shadow` |
| `multiMachine.sessionPool.inboundQueue.enabled` | `true` |
| `multiMachine.sessionPool.inboundQueue.dryRun` | `false` |
| `multiMachine.sessionPool.duplicateReconciler.enabled` | `true` |
| `multiMachine.coherenceJournal.replication.enabled` | `true` |
| `multiMachine.pollFollowsLease.enabled` | `true` |
| `multiMachine.pollFollowsLease.dryRun` | `false` |

Tests start from the real shipped defaults, not an empty config, and check each path exists there. Both
machines overwrite these keys, because the defaults are already on disk and the decision has ruled out a
choice.

The inviter writes them through a temp file and rename, then adds `sessionPoolActivation: { version: 1 }`
to the pairing response. The joiner applies the same helper in the post-response rewrite beside
`identityReannounce`. Any written `stage` is removed, so it starts at `dark` with ceiling `shadow` whatever
its home held. The field carries no values, so a response cannot hand a joiner arbitrary config, and an older
inviter simply omits it.

### Change 3: the bot token, before first boot

A standby must answer on the real channel at `shadow`, and `loadConfig` refuses a Telegram entry whose
secret cannot be resolved, so the token must be on the joiner before it boots. Secret sync cannot do this:
it is wired inside the running server and its push is best effort.

The inviter adds `telegramHandover` to the pairing response, sealed with `encryptForSync` to the joiner's
encryption key. The binding is inside the ciphertext, not beside it: the sealed payload holds the bot
token, the chat id, the pairing session id, the joiner's machine id and an expiry, and the joiner checks
each against what it sent. The identity handover's outer transcript is not reused, because it is not
authenticated. The joiner writes the token to its own secret store, then a Telegram entry that resolves
to it, all before the server first starts. Only this one secret moves. If the inviter has no Telegram,
nothing is sent and activation continues.

If opening fails, the joiner still writes the pool keys, writes no Telegram entry and says so plainly. It
cannot serve, so it hands messages back (#2723), readiness fails and no green is recorded, so the pair
stays dark. To recover, the owner pairs the same machine again: `decidePairActivation` also returns
`activate` when this machine has `activatedAtPairing` and the joiner is its only other machine, which
sends the handover again.

A home that already fails `loadConfig` fails `join` before the request, as it does today. This spec covers
fresh homes and homes that load.

`pollFollowsLease` is live, so the standby holds its poll at boot (#2759) and never polls beside the
holder.

### Change 4: both machines agree

Activation is read at boot on the inviter. After the response is sent, the inviter writes the existing
`restart-requested.json` flag with `requestedBy: 'session-pool-activation'`. Until it has restarted it
is dark and places nothing remotely, so no conversation moves in that window.

### Change 5: the green that earns shadow

New `src/core/sessionPoolPairGreen.ts`, called on the promotion tick. It runs only where
`activatedAtPairing` is written. It records a signed stage-0 green for the running build, with an
`evidenceRef` starting `readiness:`, only when all hold:

- the failover runner is not constructed here, so there is one producer;
- the readiness report has said `ready` on every check for the last 10 minutes;
- no verified red exists at stage 0 or stage 1 for this build, so a readiness green can never supersede a
  real failure through `reconcile`'s newer-green rule.

This is the first thing to read the readiness report, so `poolReadiness.ts`'s header changes to say so.
A green here means prerequisites held, not that a conversation was placed; the rung thresholds measure
that. It earns `shadow` only: the ceiling stops the climb.

### Change 6: the green expires, on the way in as well

`StageAdvancer` gains a `shadowProof` dep with the same shape as `rebalanceProof`: fresh means the latest
stage-0 row is verified, green, under 24 hours old, and a non-revoked peer exists. When wired,
`reconcile` reverts `shadow` to `dark` if it is not fresh, and `advanceTo('shadow')` refuses if it is not
fresh, so an expired pair cannot return in the same tick. It is wired only where `activatedAtPairing` is
written. Pools that existed before this change get neither the producer nor the expiry.

### Change 7: stepping down never strands a conversation

A session only acts when a message reaches it. So the rule is about where the next message goes. On a pool
marked `activatedAtPairing`, `dark` stops new placements but does not stop routing: a conversation a live
peer owns keeps going to that peer, through the same router, until it ends or the peer is gone. Ingress and
the queue drain both take the routed path for such a conversation instead of the local one, so there is no
moment when a message can run locally while the peer's session is in use, and nothing to order or wait for.
`route` gains `routingOnly: true` for these calls. In that mode the router never calls placement: a failed
forward, or an owner that is gone, returns `handled-locally`, whatever pins or other machines exist. So a
dark pool can never start a new remote placement.

An explicit `enabled:false` is the owner saying stop. It reads live, messages then run here, and the next
message brings the recent history with it (#2758). The peer's session gets no more input and is closed by
the idle reaper. After a restart with `enabled:false` the same holds.

### Change 8: the duplicate check works between machines with different tokens

The ladder counts duplicates, so the detector must work on a pair. Its remote-session probe sends the local
`config.authToken` (`server.ts:28925`), which a joiner does not share, so every probe fails and it defers.
The probe moves to the signed mesh client. It stays a measure: `dryRun` remains true, nothing is stood down
automatically, and `monitoring.standDown` is not part of this spec.

## Decisions taken, open to override

- **Token on every machine: yes,** and only that secret, sealed in the pairing response. A joiner is the
  same agent and already receives the agent identity the same way. Broader secret sync stays off.
- **Restart the inviter at pairing: yes.** Running sessions survive a server restart. The owner has just
  run a pairing command, so it is an expected moment.
- **Stage-0 green from readiness: yes,** held for 10 minutes. It is weaker than the failover test, which
  a new agent cannot run. `shadow` is the ceiling for that reason.
- **Money layer on: pairing succeeds, sharing stays off,** and the report says why. Sharing would stop
  paid routing silently, which is worse than not sharing.

## Single-machine guarantee

An agent that never pairs never runs `/api/pair`, so no key is written. The producer, expiry and drain
all need `activatedAtPairing`. A test boots single-machine config and asserts no config write, no stage row and no restart
flag.

## Existing agents

Nothing runs at update time, and every new behaviour is gated on `activatedAtPairing`, which only a
future first pairing writes, so no agent changes on update. This keeps "updates never restrict existing agents". No migration is
needed. Awareness: the readiness report and the CLAUDE.md template line on pairing.

## Rollback

`multiMachine.sessionPool.enabled: false` is read live and triggers Change 7, tested with a remote
conversation open. Reverting the code leaves the written keys as plain config.

## Maturation

**ladder:** multiMachine.sessionPool.stage, rungs and thresholds as in `session-pool-default-on.md`.
Practice and development rungs run on a test pair with `developmentAgent:false`.

## Non-goals

`live-transfer` and takeover (step 3), `rebalance` (step 4), any change to Echo's own machines.

## Open questions

None.
