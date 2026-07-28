# Side-Effects Review — Fail-closed for LLM safety gates

**Version / slug:** `llm-fallback-failclosed`
**Date:** `2026-06-07`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier-1)`

## Summary of the change
Two safety-gating LLM fallbacks flipped from fail-OPEN to fail-CLOSED:
`src/core/ExternalOperationGate.ts` `consultLLM` catch: `proceed` → `show-plan`.
`src/threadline/ContentClassifier.ts` parse-fail + error catch: `safe` → `sensitive`.
Plus `docs/specs/no-silent-degradation-to-brittle-fallback.md` (the standard + round-1 audit). Regression tests updated in both unit suites.

## Decision-point inventory
- `ExternalOperationGate.consultLLM` LLM-failure branch — modify (proceed→show-plan)
- `ContentClassifier` parse-fail + error branches — modify (safe→sensitive)

## 1. Over-block
On LLM failure (rate-limit/circuit-open/timeout), operations now require a plan/approval and outbound A2A content is held as sensitive. During a heavy LLM outage this WILL pause more ops for approval and hold more A2A messages than before — intentional (fail-closed). Healthy-LLM behavior is unchanged. The planned provider-swap reduces failure frequency.

## 2. Under-block
Strictly reduces under-block: the previous fail-open silently allowed risky ops / shipped unverifiable content when the LLM was down. That hole is closed.

## 3. Data / state
None. Pure decision-value changes; no new files (except docs), no schema, no migration.

## 4. Performance
None. Same code path; only the returned verdict on the already-existing failure branch changes.

## 5. Failure modes
This change IS the failure-mode hardening. The fail-closed verdicts (show-plan, sensitive) are existing valid values handled downstream. No new throw paths.

## 6. Security / auth
Hardens two trust boundaries: the external-operation gate (autonomous-deletion incident origin) and the A2A outbound-leak gate. No new endpoints/capabilities.

## 7. Migration / compatibility
No migration. Behavior takes effect on next deploy; existing agents get the safer fail-closed posture automatically. No agent-installed file changes.
