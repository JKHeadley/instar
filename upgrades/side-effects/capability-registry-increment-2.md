# Side-Effects Review — Capability registry Increment 2

**Version / slug:** `capability-registry-increment-2`
**Date:** 2026-07-25
**Author:** Codey
**Second-pass reviewer:** independent Codex reviewer

## Summary of the change

Increment 2 adds two dark-gated, advisory capability-registry read routes, a
machine-local receiver, honest observation/health output, and Registry First
awareness for new and existing agents. The CI repair documents both routes,
tracks and shadows the awareness entry, declares the operator-visible impact
in the PR body, and removes two silent-fallback regressions without changing
any budget or threshold.

## Decision-point inventory

- `GET /capability-registry` dark/unavailable responses — pass-through — this
  repair does not change the existing deterministic config/wiring contract.
- Durable projection to doorway-source to receiver-snapshot fallback —
  modified — the redundant outer catch is removed and doorway rebuild failure
  now emits a structured degradation before the truthful fallback response.
- Capability-registry authority boundary — pass-through — the route remains
  advisory and the FD-17 ratchet still forbids admission, placement, or routing
  consumers.

## 1. Over-block

No new block/allow surface. The only refusals remain the named `503`
configuration/wiring invariants (`capability-registry-dark` and
`capability-registry-unavailable`); this repair does not broaden them.

## 2. Under-block

The read route can still omit local doorway evidence when both the durable
projection and the live doorway source are unavailable. That is intentional:
it now reports the degradation and returns the receiver snapshot or the honest
`never-observed` state instead of fabricating evidence. No authority consumes
the result, so this cannot route work on incomplete data.

## 3. Level-of-abstraction fit

The fallback repair stays at the route/read-model boundary. The canonical
`CapabilityRegistryWriter.read()` already owns projection validation and
degradation reporting, so the redundant route catch was removed. The route
owns the second-stage doorway rebuild and now reports failure through the
existing `DegradationReporter` rather than creating a parallel mechanism.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

- [x] No — this change has no judgment block/allow surface.

The named dark/unavailable responses are deterministic configuration and
wiring invariants, not semantic judgments. Capability observations remain
signals only; `scripts/check-capability-registry-read-model.mjs` prevents this
surface from becoming an admission, placement, or routing authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The repair only
removes a redundant catch, reports a failed local rebuild, and preserves the
already-specified fallback ordering.

## 5. Interactions

- **Shadowing:** `CapabilityRegistryWriter.read()` continues to validate and
  report malformed durable projections before the route tries doorway sources.
- **Double-fire:** separate durable-projection and doorway-source failures may
  each report once because they are distinct failed stages; neither repeats on
  a successful stage.
- **Races:** no new state or mutation is introduced. The route reads a
  rebuildable local projection and an in-memory snapshot.
- **Feedback loops:** none. The response is advisory and the FD-17 ratchet
  forbids runtime authority consumers.
- **Awareness parity:** the same marker now exists in the fresh template,
  existing-agent migrator, framework-shadow marker list, and the structural
  completeness test.

## 6. External surfaces

Agents and operators can discover the two read routes in the API and
multi-machine documentation. New and existing agents receive the Registry
First lookup guidance, including Codex/Gemini framework shadows. The PR body
states the user-visible effect. No external service, persistent credential,
operator action, or write API changes.

## 6b. Operator-surface quality

No dashboard, approval page, grant/revoke form, or other operator action
surface is changed — not applicable.

## 7. Multi-machine posture

**Machine-local by design:** Increment 2 reports what the serving machine can
prove from its own durable projection, doorway sources, and authenticated
receiver snapshot. Pool-wide merge/transport remains outside this increment.
The change emits no user-facing notices, holds no new durable state, and
generates no URLs, so one-voice delivery, topic transfer, and cross-machine URL
survival are not applicable.

## 8. Rollback cost

Set `capabilityRegistry.enabled: false` for immediate rollback to the documented
dark `503`, or revert the route/awareness/docs changes in a patch. The
projection is rebuildable; there is no data migration or agent-state repair.

## Conclusion

The CI repair closes all four mechanical failures without weakening a gate:
UX impact is declared, both routes are fully documented, awareness parity is
structurally tracked, and the silent-fallback count returns from 497 to the
existing 495 ceiling by fixing the two new fallbacks. The change is clear to
ship once the independent second pass concurs and CI is green.

## Second-pass review

**Reviewer:** independent Codex reviewer
**Independent read of the artifact:** concur

Concur with the review: the repair preserves the named `503` invariants and
advisory-only `200` surface, restores fallback reporting without adding an
authority consumer, completes template/migration/shadow parity, keeps the
machine-local posture honest, and retains immediate config rollback.

## Evidence pointers

- `tests/unit/feature-delivery-completeness.test.ts`
- `tests/unit/no-silent-fallbacks.test.ts`
- `tests/e2e/capability-registry-lifecycle.test.ts`
- `tests/unit/capability-registry-read-model-ratchet.test.ts`
- `node scripts/docs-coverage.mjs --check`
- `pnpm build`

## Class-Closure Declaration

No agent-authored-artifact defect in the class-closure sense — not applicable.
The migration-tracking omission is already structurally caught by
`tests/unit/feature-delivery-completeness.test.ts`; this repair satisfies that
existing gate rather than introducing a new defect class.
