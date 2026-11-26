# Side-Effects Review — Project names stay readable

**Date:** 2026-11-17
**Author:** Echo
**Second-pass reviewer:** review_work_folds (independent Codex review: concurred)

## Summary of the change
Tier 1, a small reversible correction to the Work page. A missing or identifier-only project title now reads “Project name unavailable” instead of the conversation routing key. The model reuses verifiedDisplayName, which the rest of the console already uses. Two code/test files, one independent review round, no commit attempts yet.

## Decision-point inventory
Presentation only: which text labels a project heading. No request is blocked or permitted; keys and conversation links are untouched.

## 1. Over-block
No block/allow surface. Existing name validation may decline an intentionally ID-shaped title, exactly as it already does elsewhere in the console. Its project remains visible and reachable.

## 2. Under-block
No block/allow surface. This does not invent a name when the upstream source has none; it states the gap.

## 3. Level-of-abstraction fit
The browser model owns the visible heading. It uses the shared display identity policy instead of adding a competing parser or altering authoritative records.

## 4. Signal vs authority compliance
No block/allow surface; docs/signal-vs-authority.md remains unchanged. Display formatting has no authority over access, identity or actions.

## 4b. Judgment-point check
No new heuristic at a competing-signals decision point. This applies the existing display policy to a missed consumer.

## 5. Interactions
Project keys still identify rows, card associations and conversation destinations. Trimming a valid title affects only its label. Project app offers and approval content are unchanged. No writes, race or new timer.

## 6. External surfaces
The console states when a project's name is unavailable. API consumers still receive the original data, and native app rendering is unchanged. This corrects existing presentation and adds no capability requiring scaffold-awareness or migration changes.

## 7. Multi-machine posture
Static asset delivered on each installed machine. The source key remains intact across replicas; no new persisted state or replication path.

## 8. Rollback cost
Revert the static model change and ship the previous asset. No data repair.

## Verification
Regression first failed with the raw telegram:142909 heading. All 42 project/model tests now pass, including missing, whitespace, numeric, Topic-number and exact routing-key labels, with unchanged links. Independent review concurred and additionally checked numeric-containing names and emoji. Chromium at 1280 and 390 pixels verifies the honest fallback, working conversation href and no horizontal overflow. After merging main at 00e04e7c8, all 851 targeted and guard tests across 34 files passed, including every unit ratchet. The queued local full suite was cancelled at the merge coordinator’s request to preserve the shared verification slot. Complete unit/integration/e2e validation remains pending the merge line; no full-suite pass is claimed.
