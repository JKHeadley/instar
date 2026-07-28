# Side-Effects Review — StandingDrive Slice 2 scope derivation

**Version / slug:** `standing-drive-slice2`
**Date:** `2026-07-17`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** Hegel (`continuation_side_effects_review`)

## Summary of the change

This slice upgrades `src/core/StandingDriveSchema.ts` from an enum-only scope membership result to an auditable `StandingDriveActionDerivationV1`. It validates unknown runtime-shaped requests without throwing, returns the matched frozen rule and stable decision digest, applies safe project-relative prefix matching for git/local-test targets, and preserves `deriveActionDecision` as a compatibility projection. Tests in `tests/unit/standing-drive-schema.test.ts` prove closed holds, traversal refusal, insertion-order determinism, and absence of model/network/clock/locale seams.

## Decision-point inventory

- `deriveActionDecisionDetailed` — add — authoritative closed policy evaluation over the frozen enumerated envelope.
- `deriveActionDecision` — modify — compatibility projection over the detailed result; its public decision enum is unchanged.
- `targetMatches` — add — deterministic domain-specific target membership, with project-relative prefix semantics only for git/local-test domains.

## 1. Over-block

Git/local-test requests using absolute paths, backslashes, `.` segments, or `..` segments hold even when they resolve inside an approved root. This is intentional: filesystem resolution differs across platforms and environments, while frozen project-relative paths are portable and auditable. External-operation, message-review, and operator-transition targets remain exact; a legitimate alias or renamed recipient holds until a fresh operator transition updates the frozen envelope.

## 2. Under-block

The validator proves membership, not external authority or effect safety. An allowed action still cannot execute safely until later slices compose drive aliveness, exact local authority rebind, breaker and stop state, operation/coherence gates, and effect reconciliation. Constraint keys remain operator-frozen generic fields in schema v1; service-specific payload semantics belong to the Slice 3 adapter and cannot be inferred here.

## 3. Level-of-abstraction fit

This is a deterministic policy authority over a genuinely enumerable domain, colocated with the frozen envelope canonicalizer. It does not duplicate lifecycle persistence, external-operation authority, or a semantic evaluator. Detailed derivation is pure and synchronous, so later actuators can persist or audit its stable output without giving this module side effects.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] This is blocking authority over closed hard invariants, not brittle semantic judgment.

The authority compares enumerated domain, operation, target, constraints, phase, and schema fields. It never interprets prose or estimates relevance. The explicit plausibly-related-but-out-of-envelope test demonstrates that semantic closeness cannot expand authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals judgment point is introduced. Scope membership is a closed set-membership invariant. Project-relative path prefix matching is deterministic mechanics with traversal refusal, not a heuristic about intent.

## 5. Interactions

- **Shadowing:** none; later execution code must consume this result before existing operation/coherence gates, which retain their own authority.
- **Double-fire:** none; the evaluator has no actuator or persistence.
- **Races:** none; the evaluator reads one immutable input snapshot and returns a value.
- **Feedback loops:** none.
- **Compatibility:** the existing `deriveActionDecision` API and decision strings are preserved.
- **Determinism:** candidate rules are sorted with fixed code-unit ordering before a match is selected, preventing replicated insertion order from changing the matched rule or digest.

## 6. External surfaces

No route, message, notice, external call, persistent transition, URL, or operator-facing action is added. The exported detailed result is an internal API for later reviewed slices.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated deterministic behavior:** the frozen envelope remains in the existing autonomous-run record and this pure evaluator produces the same result on every machine. Canonical object fields, array-valued constraints, and candidate rule selection use fixed code-unit ordering rather than locale or insertion order. Project-relative path syntax is deliberately OS-neutral. The decision stores no machine-local authority and remains inert until a later execution slice performs fresh local authority rebind.

It emits no user-facing notices, holds no new durable state, and generates no URLs. Topic transfer therefore cannot strand new Slice 2 state.

## 8. Rollback cost

- **Hot-fix release:** revert the detailed evaluator and restore the previous compatibility function body.
- **Data migration:** none; no stored schema changes.
- **Agent state repair:** none.
- **User visibility:** none; no runtime actuator consumes the result yet.

## Conclusion

Slice 2 closes the scope-derivation boundary without introducing semantic judgment or side effects. The main risks—path overreach, traversal, malformed input, rule-order divergence, and hidden intelligence seams—are covered by focused tests. It is ready for independent second-pass review and the normal Instar gates.

## Second-pass review (if required)

**Reviewer:** Hegel (`continuation_side_effects_review`)
**Independent read of the artifact:** concur

The first pass caught Windows drive-qualified and noncanonical double-slash paths at the project-relative boundary. Slice 2 now rejects drive-absolute and drive-relative syntax in both requested and frozen targets, rejects invalid frozen targets as corrupt enrollment state, and canonicalizes equivalent trailing-slash targets for stable decision digests. The reviewer concurs that the revised path, cross-machine, fail-closed, and no-intelligence-seam claims are accurately tested and documented.

## Evidence pointers

- `tests/unit/standing-drive-schema.test.ts`: closed derivation, traversal/drive-path, cross-machine order, malformed-input, and no-intelligence-seam canaries.
- Focused Vitest: 30/30 passing; combined store and no-silent-fallback regressions: 50/50 passing.
- TypeScript build and repository lint: passing.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller is added — not applicable.
