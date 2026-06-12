# Upgrade Guide — Ownership reconcile: half-moved conversations now finish their move

<!-- bump: patch -->

## What Changed

WS1.3 of the converged multi-machine-seamlessness spec. A topic transfer could leave
pin and ownership permanently disagreeing (2026-06-12 live incident: owner=Mini /
pin=Laptop stuck for hours; re-placement waited on an inbound message that delivery
never routed; the closeout reaper attacked the working session throughout). Now:

- New `OwnershipReconciler` (per-machine tick over LOCAL state): cooperative
  transfer→claim convergence while the owner lives (flap debounce + bounded safe
  point), adoption of unowned pinned topics, and `force-claim` ONLY with owner-death
  evidence (offline + last-seen past the bound) AND quorum membership — a
  reachable-but-slow owner is never stolen from. Phase-C-ready: quorum is
  majority-of-N from day one (2-machine pools degrade explicitly to
  surviving-machine-vs-provably-dark-peer).
- FSM gains the fenced `force-claim` action (epoch takeover the stale owner cannot
  override; rejects self-claims and missing records).
- `GET /pool/placement` now surfaces `pendingReplacement` + `pendingSince` — a
  half-moved topic is an honest first-class state.
- SessionReaper's post-transfer closeout HOLDS (audited once per episode) when the
  topic's pin names this machine — never again attacking the session a transfer-back
  is bringing home.
- Journal `PlacementReason` gains `'reconcile'` (additive).

Ships DARK: `multiMachine.seamlessness.ws13Reconcile: false` + `ws13DryRun: true`
(rehearsal mode logs intended actions without CAS). Single-machine agents: strict
no-op inside the module, tested.

## What to Tell Your User

- "Moving a conversation between my machines now always finishes — and if a move is
  mid-flight you can see that honestly ('pending move since…') instead of the system
  quietly disagreeing with itself. A machine that dies mid-move gets its
  conversations recovered by the survivors, with proof-of-death required so a
  merely-slow machine never gets robbed."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Bounded pin/owner convergence | Enable `multiMachine.seamlessness.ws13Reconcile` (dry-run first via `ws13DryRun`) |
| Honest half-moved state | `GET /pool/placement?topic=N` → `pendingReplacement`, `pendingSince` |

## Evidence

- `tests/unit/OwnershipReconciler.test.ts` — 15 tests: FSM force-claim fencing (incl.
  the clock-proof stale-owner rejection), cooperative convergence reproducing the
  exact 13481 incident, flap debounce, bounded safe point, death-evidence + quorum
  requirements (a live owner is NEVER force-claimed; minority partitions never act),
  the exactly-one-owner invariant across 3 simulated machines, dry-run inertness,
  single-machine strict no-op.
- `tests/integration/pool-placement-transfer-routes.test.ts` — +2: pendingReplacement
  true/false with pendingSince presence.
- Affected suites green (placement/transfer routes 19/19, dark-gate lint, ratchet);
  `tsc --noEmit` clean; full build green.
- Side-effects artifact `upgrades/side-effects/multi-machine-seamlessness-ws13.md`
  with REQUIRED independent second-pass audit (ownership lifecycle + reaper surface).
