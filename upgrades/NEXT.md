---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; test-only parity-coverage addition from the codex audit)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — codex adapter observability readers now have conformance coverage

The provider-adapter conformance harness only exercised the OneShotCompletion primitive, and
only against the two Anthropic adapters. The codex adapter shipped conversation-log readers and
a session-resume index, but no test exercised them — so a codex adapter that declared one of
those capabilities while wiring no implementation (or drifting a method shape) would have passed
CI. This adds a contract-shape conformance suite that runs the SAME assertions against BOTH the
Anthropic and codex adapters for all three observability read primitives.

## Summary of New Capabilities

- New `tests/integration/conformance/observabilityReaders.conformance.test.ts` asserts, for the
  `anthropic-headless` and `openai-codex` adapters: each declares the ConversationLogReader /
  ConversationLogTailer / SessionResumeIndex capability, returns a primitive carrying the
  matching capability marker, and exposes the interface methods as callables (18 cases).
- Test-only; no runtime/src change. Confirms the codex adapter wires all three readers correctly
  and guards against future drift.

## What to Tell Your User

Nothing user-facing — this is internal test coverage that makes the codex (and future
non-Claude) adapters safer to evolve.

## Evidence

- `npx vitest run tests/integration/conformance/observabilityReaders.conformance.test.ts` → 18 passed.
- `tsc --noEmit` clean; `npm run lint` clean.
- Closes the parity-coverage gap logged in the framework-issue ledger
  (dedupKey `codex-adapter-readers-no-conformance-coverage`).
