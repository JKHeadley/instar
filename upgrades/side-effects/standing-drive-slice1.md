# Side-Effects Review — StandingDrive Slice 1 schema

**Version / slug:** `standing-drive-slice1`  
**Date:** `2026-07-17`  
**Author:** `Instar Agent (instar-codey)`  
**Second-pass reviewer:** Hegel (`continuation_side_effects_review`)

## Summary of the change

This slice adds the optional `StandingDriveExtensionV1` to `AutonomousRunRecord`, pure deterministic canonicalizers and validators in `src/core/StandingDriveSchema.ts`, and revision-guarded enrollment and mutation methods in `src/core/AutonomousRunStore.ts`. It deliberately adds no runtime wake, replay, effect, messaging, continuation, route, or scheduler integration.

## Decision-point inventory

- `validateStandingDriveExtensionV1` — add — structurally validates the closed v1 envelope and rejects unknown versions and sources.
- `deriveActionDecision` — add — permits only an action explicitly enumerated by the current phase and constraints.
- `checkAuthorityRebind` — add — requires exact principal, topic, and project-digest equality.
- `readBreakerEligibility` — add — corrupt or unreadable breaker state holds execution.
- `composeStopDecision` — add — any stop evidence source, or any unreadable required source, halts continuation.
- `AutonomousRunStore.enrollStandingDrive` and `mutateStandingDrive` — add — serialize writes and enforce one shared revision CAS.

## 1. Over-block

Malformed or future schema versions, rotated authority receipts, non-enumerated actions, unreadable breaker state, and unreadable stop evidence hold. These are intentional hard-invariant boundaries: each case lacks the structural evidence needed to authorize execution. A legitimate future enrollment surface is rejected until its source enum and truth table receive review. Plain runs without the extension are not classified as corrupt and retain legacy behavior.

## 2. Under-block

This slice does not determine whether prose is semantically related and therefore cannot catch a misleading description whose structured action fields remain valid. That is intentional: actions are authorized only by exact phase, domain, operation, target, and constraint fields. This slice also has no actuator, so its validators cannot independently prevent later code from bypassing them; later runtime slices must route every action through the derived decision and existing operation authorities.

## 3. Level-of-abstraction fit

The schema and structural validation live beside the server-owned autonomous-run record, avoiding a parallel lifecycle store. The decision functions are deterministic policy authorities over closed, enumerable domains—not semantic detectors. They reuse the run store's atomic persistence and add a run-scoped lock for extension revision CAS. Existing CommitmentTracker, operation gates, and continuation machinery remain authoritative for their respective domains.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] No brittle semantic judgment is introduced; these are hard-invariant and closed deterministic policy checks.

The change does hold blocking authority, but only for mechanically enumerable invariants: version and field validity, exact identity equality, explicit action membership, revision equality, and ANY-source stop evidence. It never interprets message meaning, intent, or competing semantic signals. This is the hard-invariant exception described in the principle document.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals judgment point. Action eligibility is a closed membership predicate over the operator-frozen envelope. Stop composition is a safety precedence rule: every named stop source is independently authoritative, so no consensus or weighting judgment exists. Unreadable authority evidence fails closed rather than being guessed.

## 5. Interactions

- **Shadowing:** nested `disposition.state` is the sole drive-aliveness authority; base run `status` remains run-completion state. Tests pin `status=expired` with `disposition=active` as legal.
- **Double-fire:** no spawn, wake, notice, or external effect exists in this slice.
- **Races:** all record writers serialize with the repository-standard crash-recoverable file lock. Generic updates refuse any extension change; extension writers compare the shared revision before an atomic record write. Stale writers refuse instead of overwriting, and stale crash-left locks are reclaimed.
- **Feedback loops:** none; the new helpers are inert until called by later reviewed slices.
- **Compatibility:** absent extension leaves current readers, writers, and status enums unchanged. `commitmentRef` remains advisory; CommitmentTracker remains promise authority.
- **Tracked lifecycle binding:** existing R28a registration-time archive and R28b daily archive do not yet inspect active drive disposition. The continuation/lease integration slice must exempt or resurrect `status=expired × disposition=active` before any runtime consumer ships; this remains bound to the StandingDrive continuation integration slice and cannot be declared complete without its archive-boundary canary. <!-- tracked: topic-458-standing-drive-continuation-integration -->

## 6. External surfaces

No routes, messages, URLs, external-service calls, automatic jobs, or operator-facing actions are added. The only persistent change is an optional JSON field written after explicit enrollment. Unknown fields remain readable by older JSON consumers.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated-ready inert state:** this slice defines the envelope that later cross-surface replay/replication work may carry, but it does not add a replication path itself. A carried record is structurally inert on another machine until exact locally verified operator-principal, topic, and project-digest rebinding succeeds. The stored receipt is evidence, never portable authority; it deliberately stores no machine identity.

It emits no user-facing notices, so one-voice gating is not needed here. It holds optional durable state in the existing run record; topic-transfer behavior remains with the existing run owner and later replication slice. It generates no URLs. A future enrollment surface requires a reviewed enum and truth-table extension; existing creation keys are never eagerly recomputed.

## 8. Rollback cost

- **Hot-fix release:** revert the module, optional type field, and store methods, then ship a patch.
- **Data migration:** none required; older readers ignore the optional JSON field.
- **Agent state repair:** none; no runtime controller consumes the field yet.
- **User visibility:** none during rollback because execution behavior is not enabled in this slice.

## Conclusion

The review found the design belongs at the autonomous-run persistence boundary and that its blocking decisions are closed hard invariants rather than brittle semantic judgments. The implementation preserves plain-run compatibility, fails closed on corrupt authority evidence, and introduces no runtime actuator. It is ready for independent second-pass review and normal ship gates.

## Second-pass review (if required)

**Reviewer:** Hegel (`continuation_side_effects_review`)
**Independent read of the artifact:** concur

Concur: Slice 1 enforces unambiguous frozen-envelope references and shared revision CAS, preserves generic-update immutability, and handles both crash-stale and live-lock contention with stable tested behavior. The signal-vs-authority boundary and side-effects artifact are complete and accurate.

## Evidence pointers

- `tests/unit/standing-drive-schema.test.ts`: 23 schema, truth-table, authority, stop, compatibility, and CAS tests.
- `tests/unit/autonomous-run-store.test.ts`: 15 existing store regression tests.
- Focused Vitest run: 38/38 passing.
- `npm run build`, `npm run lint`, and `git diff --check`: passing.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller is added — not applicable.
