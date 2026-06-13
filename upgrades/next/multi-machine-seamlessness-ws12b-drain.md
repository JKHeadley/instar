# Multi-machine seamlessness — the drain: active-conversation transfers complete (WS1.2b)

## What Changed

- **New `drain` mesh verb + owner-side SessionDrainRunner:** when a topic transfer
  targets a machine and the topic's current owner can drain (capability-advertised),
  the owner finishes the in-flight turn (bounded by `drainBoundMs`, default 30s),
  suspends any live autonomous run for the move (the remote WS1.4 arm — state file
  survives and rides the working-set carrier), closes its local session (forced at
  the bound with an `interrupted_mid_task` marker + ONE honest notice), and lands the
  target's claim — the exact moment the durable queue's ownership-contention barrier
  releases inbound messages to the new owner.
- **Emergency-stop abort:** checked EVERY poll during the drain; an abort CASes
  `transferring → active(self)` (new FSM `abort-transfer` action, epoch-fenced) so a
  halted move leaves NOTHING split — `/pool/transfer` answers 409 `failedNeedsRetry`
  and no pin is set.
- **Layered authority:** router-only RBAC (`drain-unauthorized` 403) + the runner's
  ownership/epoch CAS fence + the FSM legality check; any refused/failed/timed-out
  drain DEGRADES to today's pin-and-release path (recorded in the response, never
  blocking). Old peers (501 no-handler) and non-advertising owners are never sent a
  doomed order: `seamlessnessFlags.ws12DrainReceive` rides the heartbeat from runner
  presence. `SEAMLESSNESS_PROTOCOL_VERSION` 1→2.
- **Reconciler grace:** WS1.3's transferring-to-me claim now waits out the drain
  window (45s) so it backstops a dead-mid-drain owner WITHOUT front-running a live
  drain.

## Evidence

- `tests/unit/SessionDrainRunner.test.ts` (12): clean drain, bound-forced close +
  marker + notice, emergency-stop abort (incl. abort-CAS-lost honesty), stale-epoch /
  not-owner / cas-lost refusals, idempotent re-delivered drain.
- `tests/unit/SessionOwnership.test.ts` +6 (18): abort-transfer both sides — legal
  owner abort with epoch bump fencing a stale target claim; illegal non-owner abort.
- `tests/unit/MeshRpc.test.ts` +4 (22): drain RBAC router-only, 403 reason, 501
  no-handler for unregistered handler.
- `tests/unit/OwnershipReconciler.test.ts` +5 (17): drain-claim grace (no front-run
  of a live drain; expiry backstop).
- `tests/unit/ws12-drain-wiring.test.ts` (5, new): handler registration + disabled
  fallback, honest capability advertisement, journaling CAS dep, bounded sender,
  route gating (409 only on abort; drain-before-pin).
- `tests/integration/pool-placement-transfer-routes.test.ts` +7 (26): the full
  drain-leg matrix over real registries — self-owner drain, remote capability gate,
  no-flag degrade, abort → 409 + no pin + ownership untouched, throw → degrade,
  noop no-drain, run-suspension surfacing.
- `tests/unit/AgentServer-outbound-timeout.test.ts` +2 (22): `/pool/transfer`
  resolves to the drain budget (`POOL_TRANSFER_TIMEOUT_MS` 75s, above the 50s
  remote cap); the fast sibling `/pool/placement` stays on the default. Closes the
  second-pass concern #1 — the route would otherwise 408 mid-drain.
- `tsc --noEmit` clean. Independent second-pass review (run on Opus after the Fable 5
  outage took down the first attempt) — verdict + the concern-#1 fix in
  `upgrades/side-effects/multi-machine-seamlessness-ws12b-drain.md`. Spec:
  MULTI-MACHINE-SEAMLESSNESS-SPEC §WS1.2 (converged 2026-06-12, approved).

## What to Tell Your User

Until now, moving a conversation that was actively working was really just paperwork
— the records moved, but the conversation itself kept running on the old machine and
the move never truly finished. Now a move means: the old machine finishes its current
thought (up to ~30 seconds), pauses any long-running job at a clean point so it can
continue on the other side, closes up shop, and hands over — and only then do new
messages flow to the new machine. If you hit emergency stop mid-move, the whole move
cancels cleanly and the conversation stays whole where it was. If anything goes wrong
with the new handoff machinery, the move simply falls back to the old behavior rather
than getting stuck.

## Summary of New Capabilities

- Transfers of actively-used conversations now COMPLETE: bounded drain, autonomous
  runs pause-and-travel, queued messages release to the new owner at exactly the
  handoff moment.
- Emergency stop aborts a move atomically — never a half-moved conversation.
