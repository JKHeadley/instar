# Side-Effects Review — Coherence reviewers fail CLOSED on abstain (CMT-1794, v1)

**Version / slug:** `reviewer-fail-closed-on-abstain`
**Date:** `2026-06-25`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `the spec's 2-round convergence (6 internal reviewers + codex cross-model) IS the multi-angle review; see docs/specs/reports/reviewer-fail-closed-on-abstain-convergence.md`

## Summary of the change

Implements the converged+approved `reviewer-fail-closed-on-abstain` spec (the CMT-1794 fail-open fix), v1 = the substance. The audit found that when a coherence reviewer's LLM call errors/times-out/returns-unparseable, the base `CoherenceReviewer.review()` resolved with a permissive `pass:true` and `CoherenceGate` counted it as a GENUINE PASS (it only abstain-counted a promise REJECTION; review() catches internally) — so on an LLM blip the highest-stakes outbound checks (leak/constraint/provenance/url) silently passed. Files: `src/core/CoherenceReviewer.ts` (tag abstains with a structured cause), `src/core/CoherenceGate.ts` (count abstains as abstains → route to the existing `highCritTimeout` floor path + the kill-switch + Dec B coverage), `src/core/reviewers/escalation-resolution.ts` (its `review()` OVERRIDE tags abstains too — a gap the §9 ratchet caught), `src/core/types.ts` (the kill-switch config field), + 2 test files (13 tests). `src/core/SendGateway.ts` Stage-4 catch now fails closed on external.

## Decision-point inventory

- `CoherenceGate` reviewer abstain handling — **modify** — an errored/unparseable reviewer is now an ABSTAIN (not a counted pass); a high-criticality abstain on an external channel fails the turn CLOSED via the EXISTING `highCritTimeout` path (reuse, not a new tier).
- `CoherenceReviewer.review()` / `parseResponse()` / escalation-resolution override — **modify** — tag abstains (host-set, injection-proof).
- `SendGateway` Stage-4 catch — **modify** — external fails closed (held) instead of swallow-and-send.
- `responseReview.failClosedOnCriticalAbstain` kill-switch — **add** — live-readable revert.

## 1. Over-block

A reviewer that genuinely PASSES still passes — only a reviewer that COULD NOT FORM AN OPINION (errored) now abstains. The over-block surface is: during a real multi-provider LLM outage, external outbound needing a critical review is HELD (not lost — it rides the existing retry path). That is the safe direction the standard mandates, it is operator-revertable (the kill-switch), and the critical set is narrow (4 floor reviewers). §8 ensures a single-provider blip SWAPS (review stays alive) rather than abstaining, so a held outbound requires a true outage, not a transient flake.

## 2. Under-block

Bounded coverage deferred to v2 (tracked CMT-1801): short URL-free external messages still skip the gate (Dec C) — but PEL catches credential PATTERNS deterministically regardless of length, so the residual is a short non-pattern PII string; the breaker/hold optimization (§3) is deferred, but the amplification it optimizes is ALREADY bounded by the host spawn-cap + `maxRetries` (3 turns), so v1 is bounded, not unbounded. MessageSentinel inbound stays fail-open-except-capacity by deliberate decision (it leaks nothing on fail-open; the emergency-stop fast-path runs first).

## 3. Level-of-abstraction fit

Correct — Signal-vs-Authority: the abstain is a HOST-set signal (trusted catch/parse code, never model output), the gate is the authority. The fix REUSES the gate's existing `'high'` criticality + `highCritTimeout` machinery (the convergence's headline correction: the draft's parallel `critical` tier was a no-op the code never read).

## 4. Signal vs authority compliance

- [x] No — produces a SIGNAL (the abstain tag) consumed by the existing smart gate; removes a silent fail-open. The structured `abstainCause` is derived from typed error classes (typed-timeout `.code`), NOT a string-match of the error text — the very standard this work enforces, applied to itself.

## 5. Interactions

- **Shadowing:** none — the abstain branch is the unified rejected-or-abstain-tagged path; capacity-shed (`capacityUnavailable`) keeps precedence over abstain over genuine pass/block (explicit tri-state).
- **Double-fire:** none — one abstain per reviewer per evaluation.
- **Kill-switch scope:** governs ONLY the NEW abstain-tag-driven `highCritTimeout`; a promise REJECTION keeps its pre-existing unconditional fail-closed (no behavior change there).
- **passCount:** an abstain no longer inflates `passCount` (else a degraded reviewer reads as healthy during an outage).

## 6. External surfaces

- A new config key `responseReview.failClosedOnCriticalAbstain` (default true; live-readable via the optional `liveConfig` getter — v1 falls back to snapshot/safe-default, true no-restart wiring is CMT-1801). No new HTTP route. The held disposition rides the existing retry/feedback path. No operator-facing action added (the held/escalation rides the existing attention/DegradationReporter surface).

## 6b. Operator-surface quality

No operator surface touched (no dashboard/approval/grant file). Not applicable.

## 7. Multi-machine posture

**replicated/uniform by construction** — the floor set + abstain logic + ratchet are compiled from source (identical across machines); the `reviewerCriticality` config can only RAISE (the hardcoded floor holds on every machine regardless of config), so the leak/constraint protection cannot silently diverge. Held drafts are machine-local by design (Decision E). No user-facing notice, no cross-topic durable state, no generated URL.

## 8. Rollback cost

Pure code change + one additive config key. Back-out = revert the commit (reviewers return to the prior fail-open) OR flip `failClosedOnCriticalAbstain:false` (live, no deploy) to revert just the fail-closed behavior. No data migration, no agent-state repair.

## Conclusion

v1 ships the SUBSTANCE of CMT-1794: no reviewer silently fails open (the §9 ratchet locks it across every subclass + caught the escalation-resolution override gap), a high-criticality abstain fails closed external (proven by a dedicated test), the leak-review coverage bypass (Dec B) is closed, the provider-swap (§8) keeps reviews alive on a single-provider blip, and a live kill-switch reverts it. The v2 refinements (Dec C, breaker/hold, kill-switch live-wiring, integration/e2e) are bounded-not-blocking and tracked under CMT-1801.

## Second-pass review

The spec's 2-round convergence (6 internal reviewers across security/adversarial/scalability/integration/decision-completeness/lessons + a codex GPT-tier cross-model pass + the conformance gate) IS the multi-angle review for this change — it reshaped the design (caught the no-op tier + the false rides-retry premise) before any code. See the convergence report. The implementation was verified against that converged design with 164 passing tests across every touched area.

## Evidence pointers

- `tests/unit/reviewer-fail-closed-on-abstain.test.ts` (3): external+all-abstain→fail-closed (the exact bug, was pass:true); internal→pass-with-report (Decision D); abstain≠clean-pass.
- `tests/unit/reviewer-fail-closed-ratchet.test.ts` (10): every reviewer subclass abstains on a forced LLM error (never a silent pass); the review()-override set is the known {information-leakage (delegates to super), escalation-resolution (tags in its own catch)} — a NEW override trips the ratchet.
- Regression: CoherenceReviewer (47) + CoherenceGate (27) + MessageSentinel + spawn-cap-fail-closed-gates + all the above = 164 tests green. `npm run build` + `tsc --noEmit` clean.
