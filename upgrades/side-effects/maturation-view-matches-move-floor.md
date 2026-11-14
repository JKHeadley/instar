# Side-Effects Review — the ladder view offers only the move the floors accept

**Version / slug:** `maturation-view-matches-move-floor`
**Date:** `2026-11-06`
**Author:** `Echo`
**Second-pass reviewer:** `not required (read-model only; no gate, sentinel or refusal logic changes)`

## Summary of the change

`MaturationLadderService.features()` answered "what is the next move" differently from `applyMove`. For a `dark` entry with no `start`, the view fell through to the next rung's `advance` (a config set), while `applyMove` treated it as `code` and refused `not-a-config-move`. Spec section 8 says the floor is right: only a `start` makes a dark feature a config move. Both now call one helper, `nextAdvance`, in `src/monitoring/MaturationLadderService.ts`. Tier 1. Two files plus docs: 15 lines of source changed, 42 lines of test. One review pass (self); independent review was not run because the recovery brief forbids new agents, and the PR is the review surface. Commit attempts are noted in the PR.

## Decision-point inventory

- `applyMove` floors: the same moves are refused and applied as before. One detail differs: a dark entry with no `start` whose rung advance is `owner-driver` now reports `detail: owner-driver` rather than `detail: code` on the same refusal. No shipped behavior depends on that text.
- `GET /maturation/ladder` `move` block: corrected for dark entries with no `start`. Advisory read.

## 1. Over-block

No issue identified. No new refusal exists. `applyMove` refuses exactly what it refused before.

## 2. Under-block

The view can still show a config move that another floor refuses (`sensitive`, `held`, `not-a-development-agent`, `changed-since-read`). That is by design: those refusals name a different reason and the job handles them. This change covers `not-a-config-move` only, and the new test holds that for every shipped entry.

## 3. Level-of-abstraction fit

Right layer: the service owns both the view and the floor. A shared helper removes the duplicated rule. Adding `start` to the registry rows instead would have been a feature-activation decision, not a repair, and is not done here.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. No authority added or changed. The view is a signal; the route's floors remain the authority. The change makes the signal agree with the authority.

## 4b. Judgment-point check

No static heuristic added at a competing-signals decision point. The review's model still decides.

## 5. Interactions

The review job reads `move`. A dark feature with no `start` now reads `kind: code`, which routes it to the job's build-session path as spec section 8 directs, rather than to a move that is always refused. `raise()` does not read `move`. The dashboard board and the board route do not read `move` (searched `dashboard/console/maturation-board.js`, `src/monitoring/MaturationBoard.ts`, `src/server/maturationLadderRoutes.ts`).

## 6. External surfaces

One visible API field: `move` on `GET /maturation/ladder` for `sessions.dynamicMcp` and `monitoring.principalCoherence` changes from `{kind:'config',set,from}` to `{kind:'code'}`. No message, setting or stored file changes.

## 6b. Operator-surface quality

Not applicable. No operator-surface file changed.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the view is computed per machine from the shipped registry and that machine's config, and the pool board reads each machine's own row. No state, notice or URL added.

**Status surfaces:** `GET /maturation/ladder` changes as above; it already reads local state only.

## 8. Rollback cost

Revert the commit and release. No data or config migration, because nothing stored changes.

## Conclusion

A bounded correction of a read model to match an unchanged, spec-correct floor. It activates nothing and decides nothing about either feature.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/MaturationLadderService.test.ts`, "the ladder view offers only the move the floors accept". Before the fix the shipped-registry case failed naming `sessions.dynamicMcp` and one more entry; after it, the file and `tests/unit/MaturationLadder.test.ts` pass 75 of 75.
- `docs/research/feature-maturation/reviews/2026-11-06.json`, feature row 206 decision text.
- Spec `docs/specs/feature-maturation-ladder.md` section 8, floors table.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This fixes server code, not a prompt, hook, config, skill or standards text, and adds no self-triggered controller.
