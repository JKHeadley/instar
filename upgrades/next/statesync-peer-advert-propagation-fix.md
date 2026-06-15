# Cross-machine memory replication: peers can finally see each other's "I can receive" advert

## What Changed

When an agent runs on more than one machine, each machine advertises which kinds of
records it can durably RECEIVE (its `stateSyncReceive` capability, carried inside
`seamlessnessFlags` on the machine-pool heartbeat). Before a machine replicates a record
to a peer, the flag-coherence gate checks that the peer advertises it can receive that
kind — otherwise it withholds, because the journal applier silently drops unknown kinds.

That peer advert was being DROPPED on the receive side, so every machine saw its peers as
having zero receive capability and the gate blocked replication in both directions.
Root-caused live on a Laptop↔Mac-Mini pair (2026-06-14): each machine's `GET /pool` showed
itself with its full receive-key set but every peer with 0.

The fix is three receive-side changes, plus a regression guard:

- **`src/core/PeerPresencePuller.ts`** — extracted the peer `session-status` narrowing into a
  single exported pure helper, `narrowSessionStatusToPeerCapacity`, that now passes
  `seamlessnessFlags` through (it had been dropped, exactly like commitmentsAdvert in #930,
  quotaState in A2/#804, and preferencesAdvert in WS2.1 — this is the fourth instance of the
  same "narrowing return forgets a field" class). Added the field to the `PeerCapacity`
  interface and the `recordHeartbeat` dependency signature, and forwarded it in `pullOnce`.
  Added an exported `SESSION_STATUS_ADVERT_FIELDS` registry that drives the regression test.
- **`src/commands/server.ts`** — `fetchPeerCapacity` now delegates to that shared helper
  (keeping only the closure-bound journal-advert unwrap), so production and the round-trip
  integration test run ONE mapping instead of a hand-copied mirror.
- **`src/core/MachinePoolRegistry.ts`** — `recordHeartbeat` now carries a peer's
  `seamlessnessFlags` forward when a beat omits it (the same pattern guardPosture already
  uses), so the 30-second sparse liveness heartbeat can no longer wipe an HTTP-pulled advert.
  A genuine withdrawal (a present object with a flag flipped) still propagates.

The sender side already emitted the advert (via `getCapacity(self)`), so no sender change was
needed. The whole path ships behind the already-merged WS2 stateSync substrate; a
single-machine install is a strict no-op.

## What to Tell Your User

If you run your agent on more than one computer — say a laptop and a desktop — it is supposed
to share what it learns between them. That sharing was silently blocked: each machine could
not see that the other was ready to receive, so neither ever sent. This release fixes that.
Each machine now correctly sees its peers' readiness, and the pool view shows real peer
capability instead of a blank. If you only run on one machine, nothing changes for you. After
updating on both machines, you can confirm it works by saving a learning on one machine and
reading it on the other.

## Summary of New Capabilities

No new user-facing capability or configuration — this is a correctness fix to an existing,
default-off multi-machine feature. It removes a silent block so cross-machine memory
replication can actually take effect once the feature is enabled. The pool view now shows each
peer's real receive-capability set instead of zero.

## Evidence

- Unit: `tests/unit/peer-presence-puller.test.ts` — the shared helper preserves every advert
  field in `SESSION_STATUS_ADVERT_FIELDS` (a forgotten field fails loudly); presence-guard,
  not truthiness, so an all-disabled object survives; the puller forwards `seamlessnessFlags`.
- Unit: `tests/unit/MachinePoolRegistry.test.ts` — a sparse liveness beat does not wipe a
  pulled `seamlessnessFlags`; a genuine withdrawal still propagates; the carry-forward is
  scoped to `seamlessnessFlags` (quotaState still clears) and is per-peer (correct for N≥1).
- Integration: `tests/integration/peer-presence-roundtrip.test.ts` — over a real signed
  `/mesh/rpc` round-trip using the SHARED production mapping, a peer's advertised
  `stateSyncReceive` lands in the puller's pool registry and SURVIVES a subsequent sparse beat.
- Spec + convergence: `docs/specs/STATESYNC-PEER-ADVERT-PROPAGATION-FIX-SPEC.md`
  (review-convergence, approved; codex-cli gpt-5.5 + gemini-cli gemini-2.5-pro external passes).
