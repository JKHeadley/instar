# Side-Effects Review — Mesh Self-Heal G2 (observe route)

**Change:** Wires the G2 pure core (this PR's first commit) to a read-only observe surface: `GET /mesh-selfheal/g2` (`src/server/routes.ts`) + 4 integration tests. The route computes the B5 verdict over the live pool (`machinePoolRegistry.getCapacities()`), debounces a `silence` across reads (`G2_NOBODY_POLLING_CONFIRM_OBSERVATIONS = 3`), runs `decideNobodyPollingClaim`, records the counterfactual to `sharedG2NobodyPollingLedger`, and returns `{ verdict, silenceStreak, silenceConfirmed, selfMachineId, decision, ledger }`.

**Decision point?** The route REPORTS a decision (who would claim poll-ownership) but does NOT ENACT it — no fenced-CAS acquire, no poll-lever write. It is observe/read-only. The enacting authority (the enforce increment) is explicitly NOT in this change.

## 1. Over-block
N/A — read-only, blocks nothing. The decision it reports is biased hard against claiming (dual→veto, indeterminate→fail-closed, unconfirmed-silence→await, no-fit→escalate); only a confirmed real silence with this machine as the deterministic single claimant yields `claim`.

## 2. Under-block
The observe surface does not act, so it can neither over- nor under-block. KNOWN not-yet-built (tracked, not orphan-deferred): the enforce actuation (CAS acquire + `writePollIntent` poll-lever + post-claim live-verify of `lifeline-poll-active.json`) and peer-evidence-of-global-outage plumbing (`globalOutageEvidence` is hard-coded false here → a confirmed silence proceeds to elect, which is the observe-correct behavior; the HOLD-on-global path is the enforce increment).

## 3. Level-of-abstraction fit
Correct. The route reuses the EXACT capacity-gathering + `poolPollerVerdict` the adjacent `GET /pool/poller-count` already uses (no new pool plumbing), and the pure decision lives in `nobodyPollingRecovery.ts`. The route is a thin reporter over both.

## 4. Signal vs authority compliance
COMPLIANT. Read-only observability with no blocking/enacting authority. `selfMachineId` is read from `coordinator.identity?.machineId`; the election is deterministic + machine-agnostic. The route records soak evidence (signal) and returns the decision (signal) — it does not acquire the lease or change polling.

## 5. Interactions
- Reuses `poolPollerVerdict` (B5) — no reimplementation, no double-fold.
- The `_g2SilenceStreak` debounce counter is module-scoped per `createRoutes` call (one server process = one counter) — correct (a single server's consecutive reads). It is reset on any non-silence verdict.
- Records to the process-wide `sharedG2NobodyPollingLedger` — the same singleton the enforce increment's evaluator will use; read-driven recording means the ledger advances as the route is polled (documented; the periodic evaluator is the enforce increment).

## 6. External surfaces
New route `GET /mesh-selfheal/g2` — Bearer-gated like all routes; classified under the existing `mesh-selfheal` INTERNAL_PREFIXES entry (added by G3, already on main) so it's an agent-read, not a user capability. No config flag, no write surface, no audit file in this increment.

## 7. Multi-machine posture (Cross-Machine Coherence)
This IS the cross-machine coherence read. The decision is computed locally from the pool's advertised capacities + the deterministic election, so every machine's `/mesh-selfheal/g2` agrees on the single claimant without a coordination round-trip. `selfMachineId` is machine-local. Read-only — nothing replicates or strands on transfer.

## 8. Rollback cost
Trivial — revert the commit. The route is read-only and unreferenced by any actuation path; removing it cannot affect a running agent's behavior. No migration, no state.

## Second-pass review
Not triggered: the route holds NO block/allow authority, touches NO session lifecycle, and performs NO actuation — it is read-only observability over a pure decision. The Phase-5 second-pass IS required for the ENFORCE increment (CAS + poll-lever actuation = lease/poll-ownership authority) and remains flagged in MESH-SELF-HEAL-G2-BUILD.md.
