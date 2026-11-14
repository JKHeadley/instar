# Side-Effects Review — Unread messages: documentation coverage follow-up

**Version / slug:** `mobile-unread-messages-docs`
**Date:** `2026-11-08`
**Author:** `echo (builder session on the Mac M5 Pro)`
**Second-pass reviewer:** `not required (documentation only)`

## Summary of the change

Documentation only. PR #2958 (docs/specs/mobile-unread-messages.md) added three classes with no page under `site/src/content/docs/`, which took the Docs Coverage class ratio from its 55% floor to 54% on `main`. This adds `site/src/content/docs/features/unread-messages.md` (the feature, its routes, how it is built, switches, multi-machine posture) and a short subsection in `features/multi-machine.md`, so `ConversationReadMarkerStore`, `ConversationUnreadService` and `wireReadMarkerStore` are documented and the two new routes are mentioned. No runtime file changes.

**Proportion:** Tier 2 under the already-approved spec (no new spec), 3 files, about 90 lines of prose, 1 commit attempt. A follow-up a few hours after the feature merged.

## Decision-point inventory

No decision-point surface — documentation only.

## 1. Over-block
No block/allow surface — over-block not applicable.
## 2. Under-block
No block/allow surface — under-block not applicable.
## 3. Level-of-abstraction fit
The feature page sits with the other feature pages; the multi-machine page gains the one paragraph that explains the posture of a new replicated store, next to the other replicated stores.
## 4. Signal vs authority compliance
- [x] No — this change has no block/allow surface.
## 4b. Judgment-point check (Judgment Within Floors standard)
No new static heuristic at a competing-signals decision point.
## 5. Interactions
None; prose only. The docs-coverage check reads these pages and counts the class and route mentions.
## 6. External surfaces
The public docs site gains one page and one subsection. No operator-facing actions.
## 6b. Operator-surface quality (Operator-Surface Quality standard)
No operator surface — not applicable.
## 7. Multi-machine posture (Cross-Machine Coherence)
Not applicable to prose; the page itself states the feature's posture (markers replicated, Telegram history machine-local with counts proxied on read, badge unified). No status surfaces changed.
## 8. Rollback cost
Revert the two files. Nothing else.

## Conclusion
Documentation-only, no runtime surface. Restores the Docs Coverage class floor on `main`.

## Second-pass review (if required)
Not required.

## Evidence pointers
- `node scripts/docs-coverage.mjs --check` passes locally after the change (class coverage back at or above 55%).

## Class-Closure Declaration (display-only mirror)
No agent-authored-artifact defect — not applicable. No self-triggered controller is added or modified.
