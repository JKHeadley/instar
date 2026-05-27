# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

First increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the dedup **fingerprinter** — scar (b), the single most correctness-critical piece of the "sorting brain" that decides whether two reports describe the same bug — from the reference Python (`the-portal/.claude/scripts/feedback-processor.py`) to TypeScript at `src/feedback-factory/processor/fingerprint.ts`.

This is an internal building block: it is **not wired into any route, job, or runtime path yet**, so there is no behavioral change for any agent or user. It establishes the new `src/feedback-factory/` module and — importantly — the **parity-harness methodology** (`scripts/feedback-factory/fingerprint-parity.mjs`) that runs the real reference Python and asserts the TS port is byte-identical. Every subsequent scar port reuses this harness.

## What to Tell Your User

- This is groundwork, not a feature you'll notice yet — the first verified piece of moving the feedback system to where it's built.
- The interesting part: I proved my rewrite produces exactly the same results as the original, character-for-character, including the tricky non-English-text cases — so nothing in the bug history can quietly drift as the move proceeds.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Feedback fingerprinter (TS port) | Internal module `src/feedback-factory/processor/fingerprint.ts` — not yet wired; foundation for the processor job |
| Parity harness | `node scripts/feedback-factory/fingerprint-parity.mjs` (local; set `PORTAL_PROCESSOR` to the reference) |

## Evidence

The byte-exact port is the whole risk, so it was verified empirically, not by reasoning:

- **Parity vs the real reference Python:** ran `compute_fingerprint` from `the-portal/.claude/scripts/feedback-processor.py` and the TS port over a 33-entry corpus (real titles + adversarial Unicode/encoding/whitespace cases). Result: **33/33 byte-identical**.
- **The harness caught a real divergence before it could ship:** the first cut diverged on a bare arabic-indic digit, because Python's `\b\d+\b` is a *Unicode* word boundary while JavaScript's `\b` is ASCII-only — so the digit wasn't collapsed. Fixed by emulating the Unicode boundary with lookarounds; re-ran → 33/33. This is exactly the silent-history-fork hazard the spec's convergence flagged, caught at the foundation.
- **CI regression anchors:** three golden fingerprint values captured from the reference are asserted in the unit test, so a future regex/encoding regression fails in CI even where the reference checkout isn't present.
