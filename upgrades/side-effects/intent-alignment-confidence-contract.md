# Side-Effects Review — Intent alignment confidence contract

**Version / slug:** `intent-alignment-confidence-contract`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`DecisionJournal` now enforces its numeric confidence contract at both the
agent-authored HTTP validator and the canonical append boundary. Unambiguous
numeric strings are normalized to numbers; qualitative, non-finite, and
out-of-range values are refused before JSONL or SemanticMemory writes.
`IntentDriftDetector` treats legacy invalid values as unmeasurable, returns the
existing `N/A` plus `assessable:false` alignment state, and refuses to turn any
non-finite score into `F`. Drift windows expose nullable average confidence plus
valid and invalid sample counts, and emit a warning instead of silently skipping
comparison when either window is poisoned. ACT-1522 owns the broader
declared-contract-versus-computation class; no duplicate action is created.

## Decision-point inventory

- `validateDecisionSubmission` — modified — hard-invariant validation of the
  HTTP confidence field before the route writes.
- `DecisionJournal.log` — modified — canonical persistence boundary normalizes
  numeric strings and refuses values outside the stored contract.
- `IntentDriftDetector.alignmentScore` / `scoreToGrade` — modified — a
  non-finite component produces no verdict, never a failing verdict.
- `IntentDriftDetector.buildWindow` — modified — averages only valid numeric
  confidence and exposes the denominator and invalid count.
- `instar intent drift` rendering — modified — branches on `null`, so measured
  zero renders as `0.00` while an unavailable average renders as `n/a`.
- `generateClaudeMd` / `PostUpdateMigrator.migrateClaudeMd` — modified — new
  and existing agents receive the accepted confidence shape and legacy-data
  semantics before their next journal write.

## 1. Over-block

The HTTP route now returns 400 for `confidence:"high"`,
`confidence:"medium"`, `confidence:null`, non-finite runtime numbers, and
numeric values outside `[0, 1]`. Those are legitimate JSON shapes but not
legitimate values under the published journal contract. Numeric strings such as
`"0.8"` remain accepted and are stored as numbers, reducing avoidable client
breakage without inventing meaning for qualitative labels.

The direct writer enforces the same rule even for JavaScript or cast callers
that bypass TypeScript. This can make a previously silent machine integration
fail visibly. That is the intended direction: refusing before persistence is
safer than recording data that later fabricates a health verdict.

## 2. Under-block

Existing qualitative confidence rows remain on disk. They are treated as
unmeasurable rather than migrated because no authoritative numeric mapping for
`high` or `medium` existed when they were written. Alignment remains
unassessable while such a row is inside the selected period; the summary names
the reason. The drift window reports the invalid count, marks its average
unavailable, and emits `confidence_unmeasurable` rather than returning a stable
summary. Numeric-string legacy rows remain measurable and participate in the
ordinary confidence-drop comparison.

Other journal fields retain their current validation contracts. This change
closes the confidence mismatch tracked by ACT-1522 without claiming that every
field has received equivalent runtime schema validation.

## 3. Level-of-abstraction fit

The write correction lives at the lowest shared boundary that actually
persists records, with a route-level validator for a useful 400 response. The
scorer remains defensive because persisted legacy rows predate that boundary.
The grade floor lives at the only function converting a numeric result into a
verdict, so every alignment consumer inherits it.

No arbitrary mapping is introduced. `"0.8"` has a single numeric
interpretation; `"high"` does not. The former is normalized and the latter is
refused or treated as legacy poison.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Hard-invariant exception — boundary values must satisfy the numeric
  storage contract.

The 400 response is structural validation, explicitly allowed by the
hard-invariant exception in Signal vs Authority. It does not infer message
meaning. Alignment and drift outputs are read-only signals and hold no blocking
authority.

## 4b. Judgment-point check

No competing-signals judgment point is added. Numeric finiteness and range are
enumerable invariants. The non-finite-to-`N/A` branch determines whether a
measurement exists, not what a decision means.

## 5. Interactions

- **Shadowing:** The HTTP validator runs before evidence synthesis and the
  append. The canonical writer repeats the invariant for non-HTTP callers.
- **Double-fire:** Invalid HTTP values stop at the validator. The writer error
  remains a defensive backstop and is also translated to 400.
- **Races:** The JSONL append mechanics and rotation order are unchanged.
- **Feedback loops:** SemanticMemory receives only the normalized numeric
  confidence. Existing qualitative rows are read but never rewritten.
- **Consumers:** `/intent/alignment`, `/intent/drift`, and `instar intent drift`
  receive explicit unavailable states instead of accidental NaN serialization.

## 6. External surfaces

`POST /intent/journal` may now return
`reason:"invalid-field"` plus `invalidFields:["confidence"]`; numeric strings
are returned and stored as numbers. `/intent/alignment` returns finite
placeholders, `grade:"N/A"`, and `assessable:false` for a poisoned period.
`/intent/drift` widens `avgConfidence` to `number|null` and adds
`confidenceSampleSize` and `invalidConfidenceCount`; it adds the
`confidence_unmeasurable` warning signal when invalid stored values prevent a
complete comparison.

No external service, outbound message, timer, or operator action is added.
Persistent journal state is only constrained on future writes; existing journal
rows are not mutated. Existing agents' `CLAUDE.md` receives one idempotent
awareness bullet, while new agents receive the same contract in the scaffold.

## 6b. Operator-surface quality

No dashboard or operator action surface — not applicable. The existing CLI
renders measured zero distinctly from unavailable confidence.

## 7. Multi-machine posture

**Machine-local BY DESIGN.** The decision journal is existing per-machine
observational state under that machine’s `stateDir`; alignment and drift report
what that machine recorded. No user-facing notice, URL, topic-bound durable
state, or actuation is added. Multi-machine aggregation behavior is unchanged.

## 8. Rollback cost

Code-only rollback. Reverting restores permissive writes and the NaN-to-F
failure. Numeric strings written after this change are stored as ordinary
numbers and remain readable by old code. Existing qualitative rows are left
untouched, so rollback needs no reverse migration or state repair.

## Conclusion

Clear to ship. The review kept both required halves: the persistence contract
prevents new poison, and the read floor prevents old or future non-finite input
from becoming a confident failing grade. The explicit legacy-data decision is
no migration and no invented mapping.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** The high-risk trigger list is not engaged:
this is structural field validation and read-only metric honesty, with no
messaging, session lifecycle, trust, guard, sentinel, or watchdog surface.

## Evidence pointers

- `tests/unit/DecisionJournal.test.ts`
- `tests/unit/decision-journal-principle-honesty.test.ts`
- `tests/unit/alignment-score-not-assessed.test.ts`
- `tests/unit/IntentDriftDetector.test.ts`
- `tests/integration/decision-journal-route.test.ts`
- `tests/integration/drift-routes.test.ts`
- Mutation proof: removing the non-finite grade floor makes the poisoned
  journal assessable and graded; removing route validation loses the
  `invalid-field` refusal contract.
- 99 focused unit and integration tests passed; TypeScript typecheck passed.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. ACT-1522 already tracks the
broader runtime contract-versus-computation class.
