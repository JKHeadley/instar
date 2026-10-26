# Side-Effects Review — model registry review, 2026-10-25

**Version / slug:** `model-registry-review-1025`
**Date:** `2026-10-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** not required (data-only review record; no pin, routing or code change).
**Tier:** `1` — one JSON manifest; a revert restores it.

## Summary of the change

The freshness lint's staleness tooth (last review 2026-09-10, window 45 days) started refusing every commit on 2026-10-25. This is the review it asks for, done live: every pinned id and every frontier topModel answered a one-line prompt on its own door (claude -p: claude-opus-4-8, claude-fable-5, claude-opus-5, claude-sonnet-5, claude-sonnet-4-6, claude-haiku-4-5; codex exec: gpt-6-astra; gemini CLI: gemini-3.1-pro-preview). Newer ids that also answered are recorded as `frontier: false` (claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1, gemini-4-argon). `lastReviewedAt` → 2026-10-25, with the evidence in `$lastReviewNote`.

## Decision-point inventory

The freshness lint is the decision point; its logic is unchanged. Frontier sets are unchanged (all additions are `frontier: false`), so no drift verdict changes.

## 1. Over-block

None. The lint passes again; nothing new is refused.

## 2. Under-block

The date bump is backed by a live probe of every pin, so the ratchet's claim ("someone checked these are current") is true for the pins. Newer models are not promoted; that is recorded, not hidden.

## 3. Level-of-abstraction fit

The manifest is the single human-edit surface for this review by design.

## 4. Signal vs authority compliance

No authority changes. Routing reads the pins in source files, which are untouched.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added.

## 5. Interactions

The doorway scan and `GET /doorways` read `topModels`; they gain five `frontier: false` rows, which they display as recognized models.

## 6. External surfaces

None.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-independent: a git-tracked manifest read identically on every machine.

## 8. Rollback cost

Revert the commit; the lint fails again on staleness until the next review.

## Conclusion

A real review recorded, unblocking commits. Promotion of the newer models to pins is a separate, benchmark-driven change.
