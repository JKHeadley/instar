<!-- bump: patch -->
## What Changed

Third piece of the context budget's Phase 2 (shadow folding, still switched off): grading the practice quiz (`src/monitoring/foldGrade.ts`).

- **One model grade per answer** (`retained`, `retrievable` or `lost`), with the inputs fenced as data.
- **Fixed rules in code, above the model:**
  - "found it by looking it up" counts only for lookup-able details, and only when a lookup really happened;
  - a lookup on a constraint or an open thread counts as lost;
  - an ungradeable answer is never a pass;
  - a text search of the restore bundle corrects a wrong "it wasn't there" diagnosis, but never turns a wrong answer into a pass.
- **The roll-up.** Losing the operator's own words or a decision means roll back. A second loss after one correction means roll back. Other losses get one correction and a re-quiz. The would-be loss rate is the Phase 2 exit measure.

No route, config key or live behaviour. Nothing calls it yet.

## What to Tell Your User

Nothing changes yet. This is more groundwork for letting long conversations shrink their working memory safely (grading the quiz for practice runs). It stays switched off until the practice runs are proven.

## Summary of New Capabilities

- None user-visible yet. Internal building block for Phase 2 shadow folding.

## Evidence

- Unit: `tests/unit/fold-grade.test.ts` (17). Each rule is tested on both sides (`retrievable` with and without a lookup, on detail and non-detail items; a lookup on a constraint; presence correcting `absent` but not the grade; invalid and no-model ungraded), plus prompt fencing and every roll-up branch.
