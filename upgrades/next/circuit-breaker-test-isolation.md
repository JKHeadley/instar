# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The real circuit-breaker test fixture now uses owned temporary admission state for its fake subprocess. It retains the production factory, spawn-cap wrapper, ordinary cap and shared circuit breaker. Its regression models a saturated unrelated ledger without touching the live machine. A server lifecycle check covers the limiter's HTTP route and slot release. Fresh independent review evidence covers the final inherited test harness and this correction.

## What to Tell Your User

The update checks can test rate-limit protection without unrelated background work changing the result. This change does not alter production behavior.

## Summary of New Capabilities

No new product capability or setting. This repairs test isolation and refreshes review evidence.

## Evidence

The selected controlled baseline produced one capacity-error failure instead of the expected rate-limit error while using only an owned saturated ledger. The ordinary test cap was not raised and the live host ledger was untouched. The corrected focused sequence passed six unit tests, three integration cases and one production-server lifecycle case, with no skips or recorded unhandled errors. The raw outputs and final immutable review receipt are preserved with the candidate; complete verification remains a separate gate.
