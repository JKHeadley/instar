# Side-Effects Review — receiver submit handler + a fidelity correction (Phase 1, increment 11)

**Slug:** `feedback-factory-receiver-handler`
**Date:** `2026-05-27`
**Author:** Echo (autonomous → interactive)
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** The framework-agnostic receiver submit handler (faithful port of `handleSubmit`), the store ops it needs (`addFeedback`/`hasFeedback`), AND a correction to increment-6's `validateFeedbackInput` (see below).

## Summary of the change

Adds `src/feedback-factory/receiver/handlers.ts` — `handleFeedbackSubmit(req, deps) → {status, headers?, json}`, a faithful port of the reference `handleSubmit` (the-portal/pages/api/instar/feedback.ts) lifted out of Next.js into a pure request→response function over the FeedbackStore interface + the ported defenses. The canonical front (Vercel function / Next route / instar server) becomes a thin binding. Reproduces the reference's EXACT order, status codes (429/400/200), and error messages so deployed agents' feedback senders behave identically. Adds `FeedbackStore.addFeedback` + `hasFeedback` (the receiver write + dedup seam) + `InMemoryFeedbackStore` impls. **Not wired into any route yet** — no behavioral change. Notification (Telegram) is intentionally NOT in the core handler — it's an operated-side concern the binding adds.

## Fidelity correction (increment 6)

Building this surfaced that increment-6's `validateFeedbackInput` (defense.ts) **diverged from the reference**: it REJECTED an invalid `type` (the reference DEFAULTS it to `'other'`), used a generic error message instead of the reference's specific per-field messages, and omitted the agentName/nodeVersion format checks. That helper was a premature abstraction — the reference validates inline. **Removed** `validateFeedbackInput` (+ its tests); the faithful validation now lives inline in `handleFeedbackSubmit` (exact messages, order, and the type-default). The other defense.ts functions (verifySignature, fingerprint, honeypot, RateLimiter, regexes) were faithful + are reused unchanged.

## Seven-dimension review

1. **Over/under-reach** — Pure request→response function + a self-contained `RateLimiter` (injected). The over-reach in increment 6 (rejecting valid-but-defaulted types) is REMOVED — the handler now matches the reference's leniency exactly. No route wired.
2. **Level-of-abstraction fit** — The handler is reusable "recipe" → core package; the framework binding + Prisma store are operated-side. Notification kept out of core. Correct split.
3. **Signal vs Authority** — N/A; returns a response. HMAC is non-blocking (unsigned still accepted, marked `verified:false`) — faithful to the reference.
4. **Interactions** — `handlers.ts` imports defense.ts + the store interface; nothing imports `handlers.ts` yet. Removing `validateFeedbackInput` is safe — only its own test referenced it (verified by grep).
5. **Rollback cost** — Trivial: delete handlers.ts + restore the helper. (But the helper was incorrect — keeping it removed is the right state.)
6. **Migration parity** — N/A. Core library code; no agent-installed file. (The sender repoint is the separate, blocked cutover step.)
7. **Failure modes** — (a) Response divergence from the reference → exact status/message/order tested incl. the type-default fidelity fix + non-object-body + dedup-idempotency. (b) HMAC verified flag wrong → tested signed vs unsigned. (c) Rate-limit non-determinism → injected clock. (d) feedbackId generation non-determinism → injected generator.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/handlers.test.ts` (11 — 429 / fingerprint-400 / honeypot-silent / exact title+desc messages / **type-default-to-other** / agentName+version messages / success+unverified / verified-with-HMAC / provided-id + dedup-idempotency / non-object-body), plus `store.test.ts` +1 (addFeedback/hasFeedback), and `defense.test.ts` updated (validateFeedbackInput removed).
- All 103 feedback-factory unit+integration tests green together.
- No E2E this increment — the route binding + deploy are gated on the blocked app-placement + Prisma-adapter decisions.
