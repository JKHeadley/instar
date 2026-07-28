# Side-effects review — git-less same-epoch lease convergence (#680 Problem A v3)

**Spec:** `docs/specs/MULTI-MACHINE-LEASE-ROBUSTNESS-SPEC.md` §Problem A (converged 3 rounds, approved). The design failed verification twice (R1 zombie-holder, R2 headless-loser) before the v3 mechanism — this is why it shipped spec-first.

**Change:** resolve a git-less `LocalLeaseStore` same-epoch leapfrog split-brain to a single holder. When the active pull (#668) observes a peer holding the SAME epoch as our self-issued lease, a deterministic tie-break (lower `machineId` wins) drives a one-shot resolution: the LOSER relinquishes, the WINNER advances once to N+1, the loser adopts N+1 via the existing strict-`>` tunnel fold.

## What it touches (3 files, all on the lease path)
- **`LocalLeaseStore.forceLocalExpiry()`** (NEW) — expires the persisted self-lease in place, KEEPING the committed epoch as the CAS/replay floor (clearing to 0 would let a replayed stale lease win). No-op if no local lease.
- **`LeaseCoordinator`** — NEW `relinquish()` (clears `selfIssued` + calls `store.forceLocalExpiry?.()`), NEW `advanceEpochForContestedWin()` (one-time `buildAcquisition`→N+1 via the same casWrite/broadcast/sign path as a normal acquire; bypasses `canAcquire` deliberately — it IS the tie-resolution), + `forceLocalExpiry?()` added as an OPTIONAL method on the `LeaseStore` interface (GitLeaseStore does not implement it → no-op there).
- **`MultiMachineCoordinator`** — NEW `contestedEpisode` state field + NEW `resolveContestedSplitBrain()` called from `tickLeasePull` after the existing detect-only `surfacePullDiscoveredSplitBrain()`. Tie-break → relinquish (loser) / advance (winner), latched one-shot per episode, K-cycle bounded escalation.

## Side effects & blast radius
- **Behavior change is confined to a genuine same-epoch contested tie** (two machines both holding epoch N over a git-less store — the post-teardown split-brain). The clean single-holder path, the partition path (checkForUnresolvableSplit), and the git-substrate path (GitLeaseStore) are UNTOUCHED. `forceLocalExpiry` is optional on the interface, so only the git-less store gains the behavior.
- **The tie-break is deterministic + total-ordered** (lower machineId wins), so all machines compute the SAME winner with no coordination — exactly one relinquishes, exactly one advances. Transitive, so it generalizes to 3+ machines (tested-direction noted in the spec).
- **One-shot latch per episode** (keyed on the epoch-independent {self,peer} pair) means the relinquish/advance fire ONCE, not every ~5s pull tick — a per-tick action would re-introduce the leapfrog this fixes. The episode clears on the falling edge (tie resolved).
- **Winner-advance bypasses `canAcquire`** (direct `buildAcquisition`+casWrite). This is intentional: the winner must reach N+1 even while the loser's relinquished-but-floor-intact lease is observed. casWrite still enforces strict epoch advance (N+1 > committed N), so it cannot lower the epoch or forge.
- **Relinquish → standby → read-only** is the path implicated in the #668 crash incident. #673 (on main) made the standby read-only write non-fatal; this change relies on that and on Problem B (closeAllSqlite) for a clean exit. Per the spec sequencing, B lands first.
- **Adoption is via the EXISTING strict-`>` fold** — no new adoption write; the loser's `effectiveView()` folds the winner's N+1 (N+1 > N) and `currentHolder()` returns the winner. Verified empirically (the headless-loser guard).
- **Escalation is observe-only**: a persistently-contested episode emits ONE deduped `splitBrainEscalation` event with a deterministic `demote <loser>` recommendation. It does not auto-act; a consumer routes it to Attention. Distinct from the partition escalation.
- **No migration** — pure in-process lease logic; no config/route/schema change; reaches existing agents on normal update.

## What could go wrong (and why it won't)
- **Both advance (leapfrog)?** No — the tie-break gates advance to the winner only; the loser relinquishes. Both latched per-episode.
- **Loser headless (R2's catch)?** No — the winner advancing to N+1 makes the loser's strict-`>` fold adopt it; `currentHolder()===winner`. Tested.
- **Stale-lease replay after relinquish?** No — `forceLocalExpiry` keeps the epoch floor; a below-floor lease is rejected by CAS/acceptTunnelLease.
- **Per-tick churn?** No — the one-shot latch.

## Tests (all green; 9 new + 68 existing lease/MMC regressions)
- Unit `tests/unit/LeaseCoordinator-convergence.test.ts` (6) — the EMPIRICAL convergence proof: two coordinators both at epoch N converge to a single holder at N+1, with the headless-loser guard (loser's `currentHolder()===winner`), order-independence, winner-advance-alone-adopts, relinquish/forceLocalExpiry primitives + epoch-floor retention.
- Integration `tests/integration/lease-contested-resolution.test.ts` (3) — the orchestration on the real pull loop: WINNER advances once + latch (epoch stops climbing), LOSER relinquishes (standby), bounded K-cycle escalation (one deduped `demote <loser>`).
- 68 existing lease/MMC tests unchanged-green; `npm run lint` + `tsc --noEmit` clean.
