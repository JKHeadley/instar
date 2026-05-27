# Side-Effects Review — feedback receiver intake defenses (Phase 1, increment 6)

**Slug:** `feedback-factory-receiver-defense`
**Date:** `2026-05-27`
**Author:** Echo (autonomous)
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** The six intake defense layers of the receiver, ported as pure/injectable functions. NOT the Next.js/Vercel HTTP wiring (the app-placement architecture decision — spec's blocked list).

## Summary of the change

Ports the defense-in-depth logic of `the-portal/pages/api/instar/feedback.ts` out of the Next.js handler into `src/feedback-factory/receiver/defense.ts` as framework-agnostic functions: `RateLimiter` (in-memory sliding window, 10/hr + 50/day, injectable clock), `validateAgentFingerprint` (UA must contain `instar/`; version-header semver), `checkHoneypot` (website/email ⇒ bot), `verifySignature` (HMAC-SHA256 over `${timestamp}.${JSON.stringify(body)}`, timing-safe, +5min/−1min replay window, injectable `now`), `validateFeedbackInput` (title ≥3, description ≥10, valid type, semver version), plus the regex constants + `isValidType` + `extractSourceIp`. **Not wired into any route yet** — no behavioral change.

Convergence finding folded in: `normalizeWebhookSecret` trims the secret at load so a trailing newline can't silently break the HMAC (replaces the reference's "use printf not echo" warning with structure).

## Equivalence verification

The reference is TypeScript (not Python), so equivalence is by **faithful transcription + exhaustive both-sides-of-boundary unit tests**, not a cross-runtime parity harness (those apply only to the Python processor ports). `now` is injected everywhere the reference used `Date.now()`, so the rate-limit window + replay window are tested deterministically (10 allowed → 11th blocked; window slide; per-IP isolation; replay-window edges at +5min/−1min; HMAC valid/wrong/missing). The HMAC formula, replay thresholds, and validation bounds are copied verbatim from the reference.

## Seven-dimension review

1. **Over/under-reach** — Pure/injectable functions + one stateful class (`RateLimiter`) that owns its own Map (no module-level global, unlike the reference — a deliberate improvement for testability + multi-instance safety). Not wired into any route.
2. **Level-of-abstraction fit** — `src/feedback-factory/receiver/` — the receiver layer, separate from the processor. The HTTP/framework wiring is intentionally excluded (blocked architecture decision); this is the reusable core that any host calls.
3. **Signal vs Authority** — N/A; these are validators/guards returning verdicts. The HTTP handler (later) decides the response code.
4. **Interactions** — None. New isolated module; nothing imports it yet.
5. **Rollback cost** — Trivial: delete the module + tests.
6. **Migration parity** — N/A. New internal library code; no agent-installed file touched.
7. **Failure modes** — (a) HMAC payload-construction divergence from what agents sign → the formula is transcribed verbatim (`${timestamp}.${JSON.stringify(body)}`); the sender side already uses this. (b) Trailing-newline secret → structurally trimmed (`normalizeWebhookSecret`) + tested. (c) Rate-limit clock non-determinism → injectable `now`, tested via window-slide. (d) Replay-window off-by-one → both edges (+5min/−1min) tested.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/defense.test.ts` — 16 tests across all six layers + secret normalization + boundaries.
- No cross-runtime parity harness (reference is TS; equivalence by transcription + boundary tests — noted above).
- No integration/E2E this increment: the HTTP wiring/app placement is the blocked architecture decision; these functions attach to a route when that's decided. Reasoned, documented.
