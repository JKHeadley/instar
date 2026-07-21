# Side-Effects Review — Claim-verification general verdict metrics

**Version / slug:** `claim-verification-general-verdict-metrics`
**Date:** `2026-07-21`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `independent Codex reviewer — concurred`
**Driving spec:** `docs/specs/claim-verification-sentinel.md` §2.7

## Summary of the change

This increment extends only `CompletionClaimVerifier`'s existing content-free statistics. Each server-admitted general claim now increments a `supported`, `refuted`, or `unverifiable` total immediately after the existing deterministic assessment and criticality-floor calculation. Refuted and unverifiable claims also increment a cross-tab keyed by the final floored criticality. Existing persisted stats load backward-compatibly, and every restored count is floored and clamped to the safe integer range. The existing `/metrics/features` response automatically exposes the new fields beneath `claimVerificationServerAdmittedOnly`; there is no new route, store, extractor, audit, or authority.

## Decision-point inventory

- `assessClaim` verdict — **pass-through only** — the existing verdict is counted; its calculation is unchanged.
- `applyClaimCriticalityFloor` result — **pass-through only** — the existing final criticality is used as the cross-tab key; the floor is unchanged.
- Message delivery, legacy claim publication, future-claim handling, and action authorization — **not touched**.

## 1. Over-block

No block/allow surface — over-block is not applicable. A counter write or persistence failure cannot change claim assessment, arbitration, delivery, or action behavior.

## 2. Under-block

No block/allow surface — under-block is not applicable. These aggregates deliberately cover only claims admitted by the existing server observation path. They do not estimate transport misses, eligible coverage, or production recall, and the response keeps the explicit `claimVerificationServerAdmittedOnly` label.

## 3. Level-of-abstraction fit

The change is at the existing owner and read surface. `CompletionClaimVerifier` already owns admitted/evaluated counters and their persisted content-free file; `/metrics/features` already projects `stats()` without a second adapter. Adding a ledger, audit summary, route, or parallel observer would duplicate the foundation and was rejected during the foundation audit.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The new values are aggregate observations only. They cannot withhold, rewrite, send, settle, authorize, promote, or change a criticality floor. General assessments remain automation-ineligible dark-core signals.

## 4b. Judgment-point check

No new static heuristic exists at a competing-signals decision point. The increment counts outputs from the existing assessor and floor without reinterpreting either.

## 5. Interactions

- **Shadowing:** none; the bump occurs after the existing assessment and final floor, before the unchanged recorder call.
- **Double-fire:** one bump per extracted claim in the one existing general-observation loop. The admission queue remains the sole production caller of observation.
- **Races:** unchanged process-local stats posture. Atomic temporary-file rename remains the existing persistence mechanism.
- **Feedback loops:** none. No runtime consumer feeds these counts into assessment, criticality, routing, or delivery.
- **Persistence compatibility:** old files omit the new maps and therefore start their new fields at zero. Malformed, negative, non-finite, fractional, and oversized counts restore as bounded integers.

## 6. External surfaces

The authenticated read-only `/metrics/features` JSON gains additive fields under the already explicit `claimVerificationServerAdmittedOnly` object. No user notice, external API, URL, action, configuration, or operator control is added. The persisted file remains content-free: it contains only fixed enum keys, integers, and an update timestamp.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design.** The stats describe claims admitted and evaluated by this server process, so origins may legitimately differ. The existing metrics endpoint exposes this machine's server-admitted-only observation; this increment does not claim fleet aggregation or trusted replication. It emits no user-facing notice, holds no topic-transfer authority, and generates no URL.

## 8. Rollback cost

Low. Revert the source and test changes and ship the next patch. Older binaries ignore the additive JSON keys; newer binaries recreate missing keys at zero. No schema migration, data repair, state reset, or destructive cleanup is required.

## Conclusion

The increment is bounded, content-free, backward-compatible, and observe-only. It reuses the sole verifier and sole metrics route, preserves the server-admitted-only denominator, and introduces no authority or parallel infrastructure.

## Second-pass review

**Reviewer:** independent Codex reviewer
**Independent read of the artifact: concur**

The reviewer found no blocking issue and confirmed that the implementation is confined to the existing verifier stats path, uses the final criticality floor without altering it, preserves all authority boundaries, and clamps persisted counts. Its one test-strengthening suggestion was incorporated: the route integration fixture now enters through `enqueue()` and the real admission queue instead of calling `observe()` directly.

## Evidence pointers

- `tests/unit/turn-evidence-completion-verifier.test.ts`
- `tests/integration/metrics-features-routes.test.ts`
- Focused and adjacent suites: 69 tests green; repository lint and zero-silent-fallback ratchet green.

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller change — not applicable.
