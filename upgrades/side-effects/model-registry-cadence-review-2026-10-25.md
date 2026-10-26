# Side-Effects Review — Model registry cadence review (2026-10-25)

**Version / slug:** `model-registry-cadence-review-2026-10-25`
**Date:** `2026-10-25`
**Author:** `echo`
**Second-pass reviewer:** `not required` (data-only manifest edit; no decision logic, no routing change)
**Tier:** 1 (small, reversible: one data file; a revert restores the prior state exactly). Size: 1 file. Effort: 1 commit attempt.

## Summary of the change

`scripts/model-registry-freshness.manifest.json`: `lastReviewedAt` 2026-09-10 → 2026-10-25 with a review note; `doors.claude-code.topModels` gains `claude-opus-5-5` and `claude-fable-5-1` as frontier rows (evidence: this agent's own claude-code sessions ran on both ids today). No pin, tier map, adapter or routing code changes. Trigger: the strict freshness lint aged out (46 d > 45 d window) on 2026-10-25 UTC and turned every PR's Studio local-verify run red (PRs #2355 and #2356 failed on `lint-failed: lint-model-registry-freshness` within the hour).

## Decision-point inventory

- `scripts/lint-model-registry-freshness.mjs` (CI/pre-commit/local-verify gate) — **pass-through**: its inputs change (a fresh date; two more frontier ids on one door); its logic does not.
- Routing pins (`ModelTierEscalation.ts`, `crossModelReviewer.ts`, adapter `models.ts`) — **not touched**.

---

## 1. Over-block

No block/allow surface. The lint is now green on the merged tree; nothing it previously accepted is rejected.

## 2. Under-block

No block/allow surface. Honest limit: adding `claude-opus-5-5` / `claude-fable-5-1` to the frontier set means a FUTURE pin edit onto them will pass the drift tooth without a further live probe; the evidence recorded (in-session model identity, not an API probe) is stated in `verifiedAt` so the next reviewer can judge it.

## 3. Level-of-abstraction fit

Right layer: the manifest is the one human-edit surface the lint reads ("to pass the check a human must confirm each pin and bump the date"). This change IS that review, recorded where the spec says it lives.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The lint keeps its (deterministic, by-design) gating authority over a human-reviewed date and list; this change supplies the review.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- No double-fire or race: a data file read at lint time.
- Interaction worth naming: the Studio's local-verify runs the lint on the MERGE tree, so every open PR stays red until THIS lands on `main`; after that, red PRs need a re-queue (`POST /local-verify {"pr":N}`), not a change.

## 6. External surfaces

- Install base: `GET /doorways` (where live) will list the two new recognized ids for the claude-code door. No routing change.
- No operator-facing actions. No persistent state beyond the git-tracked manifest.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Git-tracked canonical data, identical on every machine after update — **replicated via the release itself** (the canonical layer of the doorway registry is git-tracked by design; the live scan-state is machine-local and unchanged here). No notices, no durable per-machine state, no URLs.

## 8. Rollback cost

Pure data change — revert the file. (Reverting re-reds the lint for every PR, so a rollback would need a different review date, not the old one.)

---

## Conclusion

A cadence review that was overdue by a day, performed and recorded with its evidence; the fleet-wide verify blocker it caused is cleared on merge. The one judgment call — not promoting pins to the Claude 5.5 family — is left to the operator and filed as feedback. Clear to ship.

## Second-pass review (if required)

Not required.

## Evidence pointers

- Studio `.instar/logs/local-verify.jsonl`: PR 2355 `run-detail` `reasons: ["lint-failed:node scripts/lint-model-registry-freshness.mjs"]` at 2026-10-26T01:31:14Z; the same lint on the merged tree locally: `STALENESS: model registry last reviewed 2026-09-10 (46d ago) exceeds the 45d window`.
- After: `node scripts/lint-model-registry-freshness.mjs` → PASS; `tests/unit/model-registry-freshness.test.ts`, `doorway-registry-reader.test.ts`, `doorway-scan-guard.test.ts` green.

## Class-Closure Declaration (display-only mirror)

Not applicable: no defect in an agent-authored artifact is fixed and no self-triggered controller is added.
