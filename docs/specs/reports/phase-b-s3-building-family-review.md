# Phase B S3 — Building family review

Reviewed: 2026-08-17

Scope: the Building-family change to **Constitutional Traceability — Every Action Traces to the Root**.

The added paragraph corrects the semantic conformance reviewer's unavailable-result contract. It does not claim that an outage rejects work; it states the narrower enforced behavior: unavailable or unparseable judgment is recorded as `not-proven`, cannot be represented as fit/complete/approved, and ordinary drafting may continue.

Evidence reviewed:

- `src/core/reviewers/standards-conformance.ts` returns `not-proven` for no provider, provider error, timeout, and unparseable output.
- `tests/unit/standards-conformance-gate.test.ts` exercises those blind inputs and distinguishes them from a genuine fit.
- `tests/unit/checker-blind-input-ratchet.test.ts` independently classifies a clean report while blind as failure.
- The HTTP route transports the explicit conclusion/verdict; the CLI labels degraded output non-authoritative and does not render it as a clean fit.

Disposition: accepted. No unresolved design finding was introduced by this registry clarification. The existing Building-family reference-resolution floor remains 34/40.
