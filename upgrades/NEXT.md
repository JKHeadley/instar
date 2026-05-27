# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Second increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the **fuzzy title-similarity primitives** — `_tokenize` + `_jaccard_similarity` — from the reference Python (`the-portal/.claude/scripts/feedback-processor.py`) to TypeScript at `src/feedback-factory/processor/similarity.ts`.

These sit on top of the exact-match fingerprinter shipped in the previous increment: the fingerprint groups identically-normalized reports, and Jaccard similarity is the fuzzy layer that decides whether two *differently-worded* titles overlap enough to be the same bug (the input to the clustering merge thresholds). Still an internal building block — **not wired into any route or job yet**, so no behavioral change.

## What to Tell Your User

- More groundwork for moving the feedback system in-house — the piece that recognizes two differently-worded reports as the same underlying issue.
- Same discipline as before: I proved my rewrite produces the same similarity scores AND the same group/don't-group decisions as Dawn's original, across 20 title pairs including the tricky non-English-text ones.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Title-similarity primitives (TS port) | Internal module `src/feedback-factory/processor/similarity.ts` — not yet wired |
| Similarity parity harness | `node scripts/feedback-factory/similarity-parity.mjs` (local; set `PORTAL_PROCESSOR`) |

## Evidence

- **Parity vs the real reference Python:** ran `_jaccard_similarity` from the reference processor and the TS port over 20 title pairs (identical / disjoint / partial-overlap / near the 0.35 and 0.55 merge thresholds / empty / punctuation-only / non-ASCII). Result: **20/20 match** — both the raw similarity value and the merge-threshold decision (the math is bit-identical IEEE-754 division; the harness asserts the *decision* too, since that is what actually drives clustering).
- **ASCII-tokenizer fidelity:** the reference tokenizer is ASCII-only (`[a-z0-9]+` after lowercasing), so the port uses the identical ASCII class — non-English letters and non-ASCII digits are separators in both, verified by the corpus.
- **CI anchors:** unit tests assert exact ratios (0.6, 0.4) and the threshold ordering, so a tokenizer/division regression fails in CI even without the reference checkout.
