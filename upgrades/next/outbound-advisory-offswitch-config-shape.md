---
user_announcement:
  - audience: agent-only
    maturity: stable
---

## What Changed

Fixed the outbound-advisory off-switch, which was silently broken on every real install. The preflight
route read `messaging.outboundAdvisory.enabled`, but on a real install `messaging` is a JSON **array**
of adapter configs, so that path resolves `undefined` → the `true` default → the documented off-switch
(`messaging.outboundAdvisory.enabled: false`) had **no effect** (an operator could not disable the
advisory). This is the un-DISABLABLE sibling of the PR #1379 un-ENABLABLE bug. The off-switch and tune
knobs now read from a reachable **top-level `outboundAdvisory`** block (the legacy nested key is
honored as a back-compat fallback). Existing agents' docs are corrected via a CLAUDE.md migration.

## What to Tell Your User

Nothing proactive — this is an internal fix. If a user ever asks why turning off the automated-message
advisory did nothing, the answer is that the off-switch was written in a spot the program could not
read; it now lives at a reachable top-level setting and genuinely works. The advisory is inform-only
and unchanged otherwise; this only makes its off button work.

## Summary of New Capabilities

- The outbound advisory is now genuinely **disablable** via top-level `outboundAdvisory.enabled: false`.
- Its tuning knobs (escalation thresholds, the time-claim dev-gate) read from the same reachable
  top-level block.
- Legacy object-shaped `messaging.outboundAdvisory` config keeps working (fallback).
- Existing agents' CLAUDE.md off-switch line is auto-corrected to the reachable key on update.

## Evidence

- `tests/unit/outbound-advisory-config-shape.test.ts` — real LiveConfig + a real array-shaped config:
  the top-level off-switch disables the advisory (impossible before the fix), default-on when unset,
  object-shape back-compat.
- Existing `outbound-advisory-routes` / `outbound-advisory` / `telegram-reply-advisory-script` tests
  (58) stay green; `tsc` clean; `lint-no-unreachable-messaging-gate` clean.
- Sibling audit that surfaced it: `docs/investigations/messaging-config-unreachable-audit-2026-07-04.md`.
