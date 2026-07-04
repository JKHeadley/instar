# Maturation Follow-Through Fix — Standard C (un-droppable growth-digest delivery)

## What Changed

First increment of the maturation-followthrough-fix spec (Standard C). It fixes a real bug
in the weekly growth-digest engine: on 2026-06-29 the digest hit the outbound tone gate
(`send-blocked`), consumed its weekly window, and never retried — so a check-in the operator
was supposed to receive was silently dropped, the exact "a dark feature can never be silently
forgotten" guarantee the engine exists to provide.

- **C2 (content fix, always on):** the digest formatter no longer emits raw route paths or
  config keys in operator-facing text — the literal patterns the always-on tone gate blocks.
  The footer (`GET /growth/digest` → "Full digest in your dashboard"), the truncation notes,
  and the dev-gate finding detail (a raw config key → plain English) are now tone-safe. A
  deterministic preflight guard (`scanFormattedDigestForLeaks`) + a fixture test catch any
  future formatter regression at build time instead of by a live block.
- **C1 (dev-gated dark, behind `monitoring.growthAnalyst.blockedDigestEscalation`):** a
  retryable blocked/failed send now re-queues under a bounded contract (5 attempts / 14 days
  / 60s exponential backoff) and raises one deduped attention item, instead of consuming the
  window with no retry. A poison window that exhausts a ceiling surfaces one HIGH attention
  item and stops retrying — surfaced, never silently dropped, never an infinite loop. The
  flag ships dark on the fleet; a development agent runs it live to soak.

## What to Tell Your User

Nothing changes for you today — this ships dark (fleet agents keep their exact current
behavior; only a development agent runs the new retry path, to soak it). Once it graduates,
if your weekly growth check-in ever can't be delivered, you'll get one honest heads-up on
your attention queue that it will retry, instead of the check-in silently vanishing. The
digest wording is also plainer now (no developer route paths or config keys).

## Summary of New Capabilities

- Un-droppable weekly growth-digest delivery: a blocked/failed send re-queues + escalates
  instead of silently consuming its window (dev-gated dark, opt-in via
  `monitoring.growthAnalyst.blockedDigestEscalation`).
- Tone-safe digest content, so the check-in stops tripping the outbound safety filter.

## Evidence

Reproduction: the audit log `.instar/logs/growth-digest.jsonl` records a real
`send-blocked` entry on 2026-06-29 with `reason=tone-gate-blocked` and a `window` field —
that `window` made `recordedWindows()` treat the window as decided, so `catchUp()` never
retried (verified in the spec's grounded findings against canonical `main` v1.3.735).
Verified fix: new unit suite `tests/unit/growth-digest-delivery-c1c2.test.ts` (16 tests)
asserts, on both sides of every boundary, that a retryable block now records `send-deferred`
WITHOUT a window (so it retries), raises exactly one attention item, and exhausts to
`send-exhausted` + one HIGH item after the ceiling; that the tone-safe formatter output
passes the leak scanner; and that the file-backed deferral store round-trips. Existing growth
suites (publisher / analyst / gate-wiring / devgate-r6 / routes) stay green after the C2
footer/detail change.
