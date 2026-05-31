---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; codex parity-coverage from the audit)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — codex adapter added to the OneShotCompletion conformance harness

The OneShotCompletion conformance suite ran only the two Anthropic adapters, even though the
codex adapter declares `OneShotCompletion` (capabilities.ts). That parity-coverage gap was
logged in the 2026-05-31 audit. This adds `openai-codex` to the harness so the same
contract-shape assertions (declares the capability, returns a primitive with the matching
marker, exposes `evaluate` as a function) run against codex too. Codex passes — confirming its
OneShotCompletion primitive is wired correctly — and is now guarded against drift.

## Summary of New Capabilities

- `tests/integration/conformance/oneShotCompletion.conformance.test.ts` now enumerates
  `openai-codex` alongside the Anthropic adapters. The real-API behavior case stays opt-in
  (`INSTAR_REAL_API=1`); the contract-shape cases run always.
- Test-only; no runtime/src change.

## What to Tell Your User

Nothing user-facing — internal test coverage that keeps the codex adapter's one-shot-completion
contract honest as the code evolves.

## Evidence

- `npx vitest run tests/integration/conformance/oneShotCompletion.conformance.test.ts` →
  9 passed / 6 skipped (realApi), codex contract-shape green.
- `tsc --noEmit` + `npm run lint` clean.
- Narrows the logged finding `conformance-framework-mostly-unwired-codex-omitted` (the
  oneShotCompletion-omits-codex half).
