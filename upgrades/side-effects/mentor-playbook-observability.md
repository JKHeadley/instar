# Side-Effects Review — Playbook promotion (non-Echo gate) + observability (§19.5)

**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (converged 5 iters, approved by Justin)
**Change:** Two additions to the FrameworkIssueLedger (§19.1) + two read-only-ish routes:
`promotePlaybook()` (none→candidate→extracted→superseded, with a **non-Echo attestation gate** on
candidate→extracted, §13.6) and `observability()` (bucket-distribution + leak/probable-loop/extracted
counts, §15). New routes `POST /framework-issues/:id/promote` and `GET /framework-issues/observability`.
**Files:** `src/monitoring/FrameworkIssueLedger.ts`, `src/server/routes.ts`,
`src/server/CapabilityIndex.ts`, `tests/unit/FrameworkIssueLedger.test.ts`,
`tests/integration/framework-issues-routes.test.ts`, `upgrades/NEXT.md`.

## Principle check (Phase 1)

Does this involve a decision point that gates info flow / blocks actions / constrains behavior?
**Yes — and it's a structural authority boundary, the good kind.** `promotePlaybook` enforces that
the proposing agent (Echo) cannot promote its own lesson into the reusable playbook — candidate→
extracted requires a non-Echo attestation. This is a *gate on the agent itself*, not authority over
the user's world; it can only refuse a promotion (signal/anti-gaming), never block another component.
`observability` is pure read-only telemetry.

## The seven questions

1. **Over-block.** `promotePlaybook` refuses candidate→extracted by Echo (or an empty attester) —
   intentional (§13.6). Other transitions (none→candidate, →superseded) are unrestricted. No
   legitimate promotion by a non-Echo actor is blocked.
2. **Under-block.** The attester is a free-string compared case-insensitively against `echo`. A
   determined Echo could pass a different literal — but the route is operator/human-driven and the
   recorded `promoted_by` makes any promotion auditable (a spoofed attester is visible). The gate is
   the structural deterrent + the audit trail is the backstop; matches the `difficultyAttestedBy`
   pattern from §7.3.
3. **Level-of-abstraction fit.** Both methods live on the ledger that owns the data; the routes are
   thin pass-throughs. `observability` reuses indexed columns (bucket, playbook_status, signature).
   Correct layer.
4. **Signal vs authority.** Compliant. `observability` is signal. `promotePlaybook`'s only authority
   is to *refuse* a self-promotion (an anti-gaming guard on the proposer) — it never gates messaging,
   sessions, or other components. Promotion to `extracted` is reserved for a non-Echo actor (§13.6).
5. **Interactions.** Adds a `promoted_by` column via an idempotent `ALTER TABLE … ADD COLUMN`
   (duplicate-column errors swallowed in init) so ledgers created by §19.1/§19.2 (v1.3.5–1.3.9)
   migrate forward on first boot. No interaction with the capture funnel or Stage-A paths.
6. **External surfaces.** Two routes behind Bearer auth, added to the existing `frameworkIssues`
   CapabilityIndex entry (no new prefix → no discoverability gap). No template/config change.
7. **Rollback cost.** Low. Revert removes the routes/methods; the `promoted_by` column is harmless if
   left. No data migration beyond the additive column.

## Phase 5 — second-pass

**Not required.** The promotion gate is a single pure attestation check (`promotedBy != echo`),
unit-tested on both sides (Echo refused; non-Echo allowed + recorded); `observability` is read-only.
No session lifecycle, no spawning, no blocking of another component, nothing named
sentinel/guard/watchdog. The decision-bearing live loop (§19.4) already carried its dedicated
second-pass.

## Testing

- Tier 1 (unit, +6): promotePlaybook none→candidate by any actor; **candidate→extracted REFUSED for
  Echo / empty attester**; allowed + `promoted_by` recorded for a non-Echo actor; invalid-status
  guard; unknown-issue null; observability bucket-distribution + leak/extracted counts.
- Tier 2 (integration, +5): observability 503/200; promote rejects Echo (400), allows non-Echo (200),
  404 unknown.
- route-completeness + capabilities-discoverability gates pass (new catch uses `instanceof`; new
  routes fall under the classified `/framework-issues` prefix).
- Affected push-config suite green vs canonical main; route docs-coverage 56% ≥ 55% floor.
