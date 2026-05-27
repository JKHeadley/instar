# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Eleventh increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the **receiver submit handler** — the actual "receive a report" request logic — out of the reference Next.js handler (`the-portal/pages/api/instar/feedback.ts`, `handleSubmit`) into a framework-agnostic function at `src/feedback-factory/receiver/handlers.ts`, plus the store operations it needs (`addFeedback` / `hasFeedback`).

It runs the full intake gauntlet (rate-limit → fingerprint → honeypot → signature → validation → dedup → store) and returns exactly the status codes and messages the reference returns, so a deployed agent's feedback sender behaves identically. The canonical front door (whatever framework hosts it) becomes a thin binding around this. **Not wired into any route yet** — no behavioral change.

Also corrects a fidelity slip found while building this: an earlier validation helper rejected an unknown report "type", but the real receiver quietly defaults an unknown type to "other". The faithful behavior now lives in the handler; the imperfect helper was removed.

## What to Tell Your User

- The "receive a report" front-door logic is now ported, behaving exactly like Dawn's original down to the error messages — so when we stand up the new front door, field agents won't notice any difference.
- A small correctness fix went in too: a leftover validation helper was stricter than the real thing about report categories; it's now removed in favor of the faithful version.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Receiver submit handler (TS port) | Internal `handleFeedbackSubmit` in `src/feedback-factory/receiver/handlers.ts` — framework-agnostic, not yet wired |
| Store receiver seam | `FeedbackStore.addFeedback` + `hasFeedback` |

## Evidence

- Reference is TypeScript, so equivalence is by faithful transcription plus exhaustive both-sides-of-boundary tests (11 handler tests): rate-limit 429 with Retry-After; missing-fingerprint generic 400; honeypot silent-200-without-storing; exact title/description messages; **invalid type defaults to "other" (not rejected)** — the corrected behavior; malformed agentName/instarVersion/nodeVersion messages; success path marking unverified without a signature and verified with a valid HMAC; a valid agent-provided id honored with idempotent dedup; non-object body rejected. All 103 feedback-factory tests pass together.
