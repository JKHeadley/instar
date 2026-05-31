---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; codex audit parity-coverage + correction-learning self-violation signal)
---

# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**codex adapter observability readers now have conformance coverage.** The
provider-adapter conformance harness only exercised the OneShotCompletion primitive, and
only against the two Anthropic adapters. The codex adapter shipped conversation-log readers and
a session-resume index, but no test exercised them — so a codex adapter that declared one of
those capabilities while wiring no implementation (or drifting a method shape) would have passed
CI. This adds a contract-shape conformance suite that runs the SAME assertions against BOTH the
Anthropic and codex adapters for all three observability read primitives.

**A stored preference that gets violated now becomes a learning signal (dark).** This extends the
Correction & Preference Learning Sentinel. A learned preference (for example, "don't defer work
to a fresh session" or "never ask the user to edit files") can now carry an optional
self-violation pattern. When the agent emits an outbound message that contradicts such a
preference, that is recorded as a self-violation in the correction ledger, which reinforces the
preference's recurrence so it surfaces more prominently the next session. It is signal-only: the
detector observes the finalized message and records — it can never block, delay, or rewrite a
message — and it is fail-open and dark (gated behind both the master correction-learning flag and
a new self-violation sub-flag). A preference without a self-violation pattern is never checked,
so existing preference files are fully backward compatible.

## Summary of New Capabilities

- New `tests/integration/conformance/observabilityReaders.conformance.test.ts` asserts, for the
  `anthropic-headless` and `openai-codex` adapters: each declares the ConversationLogReader /
  ConversationLogTailer / SessionResumeIndex capability, returns a primitive carrying the
  matching capability marker, and exposes the interface methods as callables (18 cases).
- New `src/monitoring/SelfViolationDetector.ts` — pure, deterministic `detectSelfViolation`;
  precision-biased (a lone weak keyword never fires), never throws.
- `PreferencesManager` preference records gain an optional `violationPattern` (regex or keyword
  grammar); fully backward compatible.
- Observe-only outbound hook in `checkOutboundMessage` records self-violations to the
  `CorrectionLedger`; structurally independent of the tone-gate verdict and the message itself.
- New `monitoring.correctionLearning.selfViolationSignal` config flag (default false).

## What to Tell Your User

Two changes, both safe. First, internal test coverage that makes the codex and future non-Claude
adapters safer to evolve — nothing user-facing. Second, the correction-learning system can now
notice when the agent's own outgoing message contradicts a preference it has already learned
about you, and quietly use that as a signal to remember the preference more strongly next time.
It only ever observes and records — it never blocks, delays, or changes a message — and it stays
off until explicitly turned on.

## Evidence

- `npx vitest run tests/integration/conformance/observabilityReaders.conformance.test.ts` → 18 passed.
- `SelfViolationDetector` unit (17), self-violation wiring-integrity (5, asserts the outbound
  message passes through byte-for-byte unchanged and the detector fail-opens), integration (5),
  and E2E lifecycle (3) — all passed; `npm run build` / `npm run lint` / `docs-coverage` clean.
- Closes the parity-coverage gap logged in the framework-issue ledger
  (dedupKey `codex-adapter-readers-no-conformance-coverage`).
