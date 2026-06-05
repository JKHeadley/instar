---
bump: patch
---

## What Changed

Unverifiable one-time-action commitments (no verificationMethod, or `manual`) are no longer auto-marked `delivered` by the verify sweep ~75 seconds after creation. The sweep is now a strict no-op for them — no auto-delivery (terminal + unrevivable = the promise silently evaporated) and no violation ticks (the historical 51k-spam class stays dead). They close only via explicit `deliver()`/PATCH or `expiresAt`, and remain visible to the PromiseBeacon and overdue surfacing meanwhile. The boot-time backfill was also scoped to what its docstring always claimed (only historical violation-spammed rows), closing a back-door that re-terminalized pending promises at every restart.

## What to Tell Your User

Promises your agent registers for follow-through now stay open and nagging until actually fulfilled, instead of quietly marking themselves done seconds after being made.

## Summary of New Capabilities

- Commitment follow-through works for ALL unverifiable promises, not only beacon-enabled ones — "I'll do X when Y happens" survives until X actually happens.

## Evidence

Live incident 2026-06-05 (framework-issue 5bac8d53): CMT-1101 ("review Codey's fix-B PR when it lands") was registered at 19:44:38Z and auto-resolved `delivered` at 19:45:53Z — 75 seconds later — while the PR it promises to review did not exist; the terminal state then rejected the documented PATCH override. Causal chain grounded via git: #76 (2026-04-19) introduced auto-delivery to stop a 51,000-tick violation-spam pathology; #656 (2026-05-31) exempted only beaconEnabled commitments. Tests: 157 commitment-suite + 13 PromiseBeacon tests green, including inverted pins of the old behavior (the #656 test that explicitly asserted non-beacon auto-delivery now asserts stay-pending) and a 10-sweep evaporation regression test; tsc clean.
