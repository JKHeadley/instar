# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Sixth increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the **receiver intake defenses** — the six security layers of the feedback front door — out of the reference Next.js handler (`the-portal/pages/api/instar/feedback.ts`) into framework-agnostic TypeScript at `src/feedback-factory/receiver/defense.ts`.

The layers: a per-IP sliding-window rate limiter (10/hour, 50/day), the agent fingerprint check (User-Agent must say `instar/`, version header must be semver), the honeypot (real agents never send `website`/`email`), HMAC signature verification with a 5-minute replay window, input validation (title/description length, valid type, semver), and the type/dedup helpers. Pure/injectable functions plus one self-contained `RateLimiter` class. **Not wired into any route yet** — the HTTP/app placement is a separate decision; this is the reusable core.

A convergence finding is folded in: the webhook secret is trimmed at load, so a trailing newline can't silently break the signature check (replacing a "be careful how you set it" warning with structure).

## What to Tell Your User

- The security guards on the feedback front door — rate limiting, bot traps, signature checks, input validation — are now ported into our own codebase, ready to attach to the new front door when we stand it up.
- One sharp-edge removed for good: a stray newline in the signing secret used to be able to silently break verification; now it's trimmed automatically.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Receiver intake defenses (TS port) | Internal module `src/feedback-factory/receiver/defense.ts` — not yet wired |

## Evidence

- The reference is TypeScript, so equivalence is by faithful transcription plus exhaustive both-sides-of-boundary tests (16 unit tests): rate limit at 10 vs 11 and after a window slide and per-IP; fingerprint with/without `instar/` and valid/invalid version; honeypot present/absent; HMAC valid/wrong/missing and both replay-window edges (+5min/−1min); validation at title 2 vs 3 and description 9 vs 10. The clock is injected everywhere, so the time-based windows are tested deterministically.
- The HMAC payload formula, replay thresholds, and validation bounds are copied verbatim from the reference the field agents already sign against.
