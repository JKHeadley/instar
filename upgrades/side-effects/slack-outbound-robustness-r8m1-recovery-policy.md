# Side-Effects Review — R8-M1 Arm A: recovery-policy `409 delivery-in-flight → retry`

**Version / slug:** `slack-outbound-robustness-r8m1-recovery-policy`
**Date:** `2026-07-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The accepted build-phase residual R8-M1 (Arm A) from the slack-outbound-robustness review ceremony, settled in code with a test — the first build increment of `docs/specs/slack-outbound-robustness.md`. The §2.4 single-flight reservation (a later increment) makes `/slack/reply` and `/telegram/reply` answer a concurrent same-`delivery-id` POST with a structured `409 { error: 'delivery-in-flight' }`. The DEPLOYED pure `recovery-policy.ts` classifies every unlisted 4xx via `if (httpCode >= 400 && httpCode < 500) → escalate` (`:189`), so on the raw-HTTP Telegram redrive lane (which has no funnel typed-result mapping table) a routine reservation race would terminalize a deliverable message and fire a spurious operator escalation. The fix adds ONE named, tested exception: a structured `409 delivery-in-flight` retries at the existing §3c backoff (bounded by the same MAX_ATTEMPTS + 24h TTL caps as every transport retry); an unstructured/unknown 409 keeps the deployed default-deny (escalate). This reconciles the spec-wide "recovery-policy stays byte-untouched" invariant HONESTLY — as a single visible exception, not a silent one. Files touched: `src/monitoring/delivery-failure-sentinel/recovery-policy.ts` (the 409 branch + a `parseErrorCode` helper + an exported `DELIVERY_IN_FLIGHT_ERROR` wire-string constant) and `tests/unit/recovery-policy.test.ts` (six new table cases).

## Decision-point inventory

- `recovery-policy.evaluatePolicy 409 branch` — add — a structured `409 delivery-in-flight` retries at backoff; every other 409 escalates (default-deny). Placed before the generic `4xx → escalate` so only the exact structured code is rescued.
- `DELIVERY_IN_FLIGHT_ERROR` constant — add — the single source of truth for the wire string; the route (later increment) references it so policy and route can never drift.
- `parseErrorCode` helper — add — parses `{ error: string }`; distinct from the untouched `parse403` so the deployed 403 path stays byte-identical.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None new. The change only RESCUES a status the deployed code escalated (409): structured `delivery-in-flight` now retries instead of terminalizing. An unstructured 409 still escalates exactly as the deployed generic-4xx branch did — no legitimate delivery is newly rejected. The retry is bounded by the identical MAX_ATTEMPTS + TTL caps, so a pathological forever-racing 409 still escalates loudly rather than looping (P19).

---

## 2. Under-block

**What failure modes does this still miss?**

If a non-instar server ever returned `409 { error: 'delivery-in-flight' }` for a genuinely terminal conflict, this would retry it 9 times before escalating — bounded, loud, never silent, and not a real deployment shape (only the instar reservation route emits this exact structured body, and the `/whoami` gate already protects against redriving through a foreign server config). Arms B (adapter-timeout → 408) and C (script 409 classification) are settled in their own increments (the §2.4 route work and the §2.6 script refresh); this increment is Arm A only.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The pure `recovery-policy` module is exactly where HTTP-status → action classification belongs — it is the single deterministic authority for the raw-HTTP redrive lanes, exhaustively table-tested. Putting the 409 rule here (rather than a translation shim in the Telegram redrive caller) makes the exception ONE visible branch in the enumerable decision table, which is where the round-8 reviewers said it belongs.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this is deterministic policy classification in a pure module, not a brittle string-matcher gaining new blocking authority.

The branch keys on an EXACT structured error code (`delivery-in-flight`) parsed from JSON, not a substring/heuristic. It relaxes an escalate toward retry (the never-lose-a-message direction); it never withholds a message. Authority over what withholds still rests with the tone gate (unchanged).

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

It is consumed by `DeliveryFailureSentinel`'s redrive loop for the Telegram lane (raw HTTP → `evaluatePolicy`) and is the safety net if any Slack row ever reaches `evaluatePolicy` with a raw 409. The Slack lane primarily maps `delivery-in-flight` → retry through the §2.3 funnel typed-result table (a later increment); both paths converge on the same "retry, no breaker arm, no attention noise" outcome. `reasonToCategory` is unaffected on the retry path (a `delivery_in_flight_*` reason only reaches escalate on exhaustion, where it falls to the existing `unstructured_403` category — a rare, correct catch-all).

---

## 6. External surfaces

No new routes, config keys, env vars, or CLI in this increment. `DELIVERY_IN_FLIGHT_ERROR` is an internal exported constant.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing surface changes in this increment.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

`recovery-policy` is a pure, machine-local, stateless function — no cross-machine state. Classification is identical on every machine by construction (no clock, no I/O; `now` is injected).

---

## 8. Rollback cost

Trivial and isolated: revert the single 409 branch + helper + constant + the six test cases. No schema, no config, no migration, no persisted state. A rolled-back binary simply escalates a structured 409 again (the deployed behavior) — loud, never a misdelivery.

---

## Conclusion

A minimal, deterministic, bounded, test-backed exception that closes the R8-M1 Arm A regression (a routine reservation race terminalizing a deliverable Telegram message) while keeping the "recovery-policy byte-untouched" invariant honest as a single visible branch.

---

## Second-pass review (if required)

Not required — pure additive classification branch in a fully table-tested module, fail-toward-delivery direction, trivially reversible.

---

## Evidence pointers

- `src/monitoring/delivery-failure-sentinel/recovery-policy.ts` — the 409 branch, `parseErrorCode`, `DELIVERY_IN_FLIGHT_ERROR`.
- `tests/unit/recovery-policy.test.ts` — describe block "evaluatePolicy — 409 delivery-in-flight (spec R8-M1 Arm A)": structured→retry@backoff, MAX_ATTEMPTS→escalate, TTL→escalate, unstructured→escalate, other-structured→escalate, no-body→escalate.
- `docs/specs/slack-outbound-robustness.md` §2.3/§2.4, `accepted-build-residual` frontmatter; `docs/specs/reports/slack-outbound-robustness-round8-findings.md` §"The blocking finding".

---

## Class-Closure Declaration (display-only mirror)

Class: raw-HTTP status composition against the deployed `recovery-policy` classifier. This increment closes the 409 member (Arm A). Arms B/C close in their own increments; the exhaustive recovery-policy table test is the standing guard that any future status keeps composing.
