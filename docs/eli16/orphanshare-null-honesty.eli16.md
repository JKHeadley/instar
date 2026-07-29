# Orphan Share Null Honesty — Plain-English Overview

> The one-line version: the benchmark-divergence analyzer now treats a missing orphan-share denominator as unknown instead of silently pretending it is zero.

## The problem in one breath

The benchmark-divergence detector compares live graded decisions against a benchmark baseline and emits advisory findings such as aligned, divergent, partial, or insufficient evidence. One of its honesty checks asks whether too many outcomes are orphaned, which means the quality evidence cannot be trusted as a clean comparison. When the analyzer had enough settled grades but the recorded-decision denominator was zero, it produced an orphan share of zero, so the comparison could continue as if the orphan evidence was clean.

That was not honest. A zero denominator means the orphan share is unavailable, not zero. In JavaScript, comparing `null > 0.05` would still behave like `0 > 0.05`, so the comparison site also has to branch on null before any numeric threshold check.

## What already exists

- **Benchmark-divergence analyzer** - reads matured decision-quality rollups and compares model performance against the mirrored benchmark predictions.
- **Verdict ladder** - turns those inputs into advisory findings. It already has partial verdicts for cases where the comparison should not produce an aligned or divergent conclusion.
- **Feature metrics ledger** - stores the latest benchmark findings and serves them through the benchmark-divergence API.
- **Pool merge clamps** - accept only enumerated, content-free finding fields from peers so one machine cannot inject raw text into another machine's findings view.

## What this adds

This change makes the unavailable orphan-share case explicit. The analyzer now passes `null` when the orphan-share denominator is zero, and the verdict ladder returns `partial` with `partialReason: "orphan-share-unavailable"` before any numeric comparison runs. The existing over-threshold orphan-share path also gets `partialReason: "orphan-share-over-threshold"`, so tests can prove the specific reason surfaced rather than only proving that no actionable verdict was reached.

The ledger gains an additive nullable `partial_reason` column for benchmark findings, with an idempotent open-time migration for existing SQLite databases. The API read surface and peer clamp allow only the closed partial-reason enum, preserving the existing content-free envelope.

## The new pieces

- **Partial reason enum** - names the two orphan-share partial cases without accepting free text.
- **Null branch in the verdict ladder** - handles unavailable orphan share before JavaScript can coerce null during threshold comparison.
- **Finding persistence field** - stores and returns the partial reason separately from the verdict, so downstream readers can tell "unknown denominator" from "too many orphans".

## The safeguards

**Prevents fabricated certainty.** A zero denominator no longer becomes a fabricated clean zero. The detector says the comparison is partial and names the reason.

**Prevents weak test passes.** The regression tests assert the exact partial reason, not only the absence of an aligned or divergent verdict. A future bug that suppresses every verdict would not satisfy the new assertion.

**Preserves the advisory boundary.** Benchmark-divergence findings remain advisory and content-free. This change does not add a block, allow, route, spawn, kill, or message-send authority.

**Preserves peer safety.** Peer-provided partial reasons are clamped to the local enum and peer-authored free text is still dropped from the merged finding view.

## What ships when

This ships as one small Tier 1 fix: core verdict logic, analyzer producer behavior, ledger persistence, route allowlist, and focused tests in the same change.

## What you actually need to decide

Approve whether the benchmark-divergence detector should report the zero-denominator orphan-share path as `partial` with a distinct closed reason instead of treating it as clean evidence.
