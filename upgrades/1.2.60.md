# Upgrade Guide — NEXT (human-as-detector)

<!-- bump: minor -->
<!-- minor = new capability, backward compatible -->

## What Changed

**New: instar now treats a human-caught coherence break as a first-class diagnostic signal.**

When the user has to point something out — "that's wrong", "you already said the opposite",
"that's out of date", "why didn't you catch this" — that correction is no longer just an
input to fix quietly. It is evidence that some automated guardian (CoherenceGate,
CoherenceMonitor, a freshness check) *should* have caught it and didn't. The new
`HumanAsDetectorLog` (`src/monitoring/HumanAsDetectorLog.ts`) observes inbound human
messages, classifies corrections with a conservative, precision-biased regex set (no LLM,
no network), and records each as a signal mapped to the guardian layer that plausibly
failed. Over time this builds a heat map of "where the human is doing the system's job",
exposed read-only at `GET /human-as-detector/summary`.

This is the user-feedback half of the Continuous Working Awareness north star: never let a
user correction go to waste. It mirrors `DegradationReporter`: a singleton configured at
startup, append-only JSONL persistence at `.instar/metrics/human-as-detector.jsonl`,
best-effort, and it never throws into message handling. The observe hook is chained onto the
inbound Telegram message callback (preserving prior callbacks; only inbound human messages
are observed).

## What to Tell Your User

When you point out something I got wrong or stale, I now treat that as a sign one of my own
safety checks missed it — not just a one-off to fix and forget. I quietly keep score of which
checks keep letting things slip past, so we can see where my automated guardrails are weak and
strengthen them over time. Nothing for you to set up; existing agents get it on their next
update. You can ask me to show the heat map of where you've had to catch my mistakes.

## Summary of New Capabilities

- New `HumanAsDetectorLog` monitor: classifies inbound human corrections into categories
  (factual-correction, staleness, contradiction, source-of-truth-drift, repeat-ask,
  meta-failure), each mapped to the guardian layer that should have caught it.
- New read-only endpoint `GET /human-as-detector/summary` — the heat map grouped by suspected
  failed layer, plus recent signals.
- Append-only audit trail at `.instar/metrics/human-as-detector.jsonl`.
- Always-on, no config, no LLM, no network; best-effort and never throws into message handling.

## Evidence

- Tier 1 (unit): 19 tests — 15 on the classifier/observe/heat-map core, 4 on the
  inbound-human gating helper (`observeInboundMessage`). All pass.
- Tier 2 (integration): 3 tests against the real `createRoutes` pipeline — empty map,
  recorded correction surfaces, non-correction ignored. All pass.
- Tier 3 (e2e): 2 tests booting the real route tree on a live HTTP server — endpoint alive
  (200), and an observed correction flows to the live endpoint AND to the JSONL on disk.
  All pass.
- `npx tsc --noEmit` clean.
- Ported from Dawn's reference implementation (the-portal handoff); built fresh on current
  `origin/main`, not from the stale local checkout (avoids reverting SafeFsExecutor /
  iMessage-attachment features per the handoff's critical warnings).
