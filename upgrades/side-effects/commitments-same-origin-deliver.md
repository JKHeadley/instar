# Side-Effects Review — commitment id resolution collapses same-origin copies

**Version / slug:** `commitments-same-origin-deliver`
**Date:** `2026-11-20`
**Author:** `echo (instar-dev, outage repair run)`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1 (declared), 2 source files (+~35 LOC), 3 test files, 1 commit attempt, no spec review rounds (Tier 1). `resolveBareId` in `src/core/CommitmentsSync.ts` gains an optional `ownMachineId`; when several merged rows match an id and all share ONE `originMachineId`, it returns the row published by that origin (own row if origin is self, else the replica row whose new `replicaOwnerMachineId` equals the origin). `mergeCommitmentViews` stamps `replicaOwnerMachineId` on replica rows. `resolveCommitmentRoute` in `src/server/routes.ts` passes `ctx.meshSelfId`. This unblocks `POST /commitments/:id/deliver` (and PATCH/probe/withdraw/etc. that share the resolver) on a rebuilt machine whose own store holds restored copies of a peer's records (fb-6a8328a1-e98).

## Decision-point inventory

- `resolveCommitmentRoute` / `resolveBareId` (which copy a mutation targets: local / forward / 409) — modify — same-origin matches now resolve instead of 409.

---

## 1. Over-block

No block/allow surface added. The change strictly reduces 409 answers: only cases where every match shares one origin AND exactly one match was published by that origin are resolved. Nothing previously accepted is now refused.

---

## 2. Under-block

Copies held only by third parties (origin never published its own row, e.g. the origin is a revoked machine) still answer 409 ambiguous — deliberate: guessing between copies could close the wrong record. The stale restored own copies on the rebuilt machine remain in its store as pending rows (they are not rewritten by this change); they no longer block closes, but the rebuilt machine's tracker still evaluates them locally. That store hygiene is a separate data question reported to the operator in the outage report, not a correctness defect of this resolver.

---

## 3. Level-of-abstraction fit

Right layer: the ambiguity arises in the pure merged-view resolver, which every id-addressed route shares through `resolveCommitmentRoute`. Fixing it there covers all six mutation routes at once; no parallel check is added.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

Not a gate. The resolver routes a mutation to the authoritative copy (the origin's). It does not gain blocking authority; it removes a spurious refusal. Authority over the record stays with the origin machine's `applyOwnerMutation` (verdict-bearing, opKey-idempotent), unchanged.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point added: "which copy is authoritative" has a deterministic answer (the origin's own publication), so a static rule is correct here.

---

## 5. Interactions

- Forwarding path (`forwardMutation` → `forwardCommitmentMutate`) unchanged; a resolved replica row forwards to `originMachineId` exactly like any replica-only record today.
- `annotateDuplicates` unaffected (it skips same-origin pairs already).
- GET `/commitments?scope=pool` rows from replicas gain an additive `replicaOwnerMachineId` field; consumers that ignore unknown fields are unaffected (verified console/promise unit suites pass).

---

## 6. External surfaces

Additive response field on merged replica rows; fewer 409s on id-addressed commitment routes. No messaging, no timing dependency.

## 6b. Operator-surface quality

No operator surface touched — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read + owner-routed mutation (the existing COMMITMENTS-COHERENCE §3.4 path). This change makes that path correct when a store contains another machine's records: the mutation goes to the origin, the stale local copy is not mutated, so no two machines diverge on who closed what. No new replicated state. Status surfaces: none new.

---

## 8. Rollback cost

Revert the commit; no data migration, no persisted state written by the new logic.

## Conclusion

Safe Tier-1 fix; ship.

## Second-pass review (if required)

Not required (no messaging/session-lifecycle/gate surface).

## Evidence pointers

- Live repro: rebuilt Studio 2026-11-20, CMT-2056/2057 409 with `?origin=m_cc2ec651…` (925 own rows with Laptop origin duplicated by the Laptop replica).
- tests/integration/commitments-deliver-same-origin.test.ts and tests/e2e/commitments-deliver-same-origin-lifecycle.test.ts fail (409) on the old code and pass on the fix; tests/unit/CommitmentsSync.test.ts covers both directions and the two still-ambiguous cases.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
