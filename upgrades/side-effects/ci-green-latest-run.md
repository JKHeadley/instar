# Side-Effects Review — CI greenness must use the LATEST run per check

## Summary of the change

`StageTransitionValidator.ciIsGreen` iterated EVERY entry in GitHub's `statusCheckRollup` and refused
on any non-success conclusion. GitHub returns every run of every check, **including superseded ones**,
so a check that failed and was then re-run to green appears twice and the failed entry never
disappears.

Verified on the live PR #1641 (merged legitimately at 02:07:44Z):

```
rollup entries: 31 | names appearing more than once: eli16 (2), UX impact declaration (2),
                                                     UX assertions (messaging E2E) (2), UX merge safety (2)
eli16  COMPLETED  FAILURE  completedAt 2026-07-26T01:44:01Z
eli16  COMPLETED  SUCCESS  completedAt 2026-07-26T01:45:32Z
```

Branch protection merged the PR because it evaluates each check's CURRENT state. The tracker refused
it with `CI_NOT_GREEN` because it evaluated the stale run too — so **no correct merge whose CI had
ever been red could ever be recorded.**

Fix: `latestRunPerCheck` collapses the rollup to the newest run per check name (by `completedAt`,
falling back to `startedAt`) before `ciIsGreen` evaluates it. `GhPrView.statusCheckRollup`'s type
gains the `name`/`context`/`startedAt`/`completedAt` fields the dedupe needs; the route's existing
`gh pr view --json …statusCheckRollup` already returns them, so no query change.

## Decision-point inventory

- `ciIsGreen` feeds the `building → merged` GATE. This change makes the gate ACCEPT a case it
  previously refused, so it is the direction that needs the most scrutiny — see §1/§2.
- No other decision point, hook, sentinel, reaper, scheduler, migration or config surface is touched.
- `latestRunPerCheck` is a pure function over the rollup array.

## 1. Over-block

Strictly reduced, and that is the intent: a merged PR with a superseded failure is now recordable.
Nothing that used to pass now fails.

The one preserved refusal worth naming: a **latest** run that is still in flight (`status` not
`COMPLETED`) is still not green, asserted in its own test, so the dedupe cannot be used to skip a
pending check by pairing it with an older success.

## 2. Under-block — the part that matters

A dedupe is a potential laundering mechanism, so three properties are enforced and each is tested:

1. **Latest is authoritative in BOTH directions.** SUCCESS followed by a later FAILURE is NOT green.
   Without this, "keep the latest" would let anyone bury a red by arranging run order.
2. **Unorderable runs FAIL CLOSED.** Equal or missing timestamps ⇒ the FAILING run wins. An undatable
   success must never mask a red. (Three variants tested: no timestamps either way round, and equal
   timestamps.)
3. **Unnamed entries are keyed individually.** Bare status contexts with neither `name` nor `context`
   are never collapsed into each other, so a failing one cannot be replaced by a passing one.

Residual, stated: the dedupe trusts GitHub's timestamps. A platform that reported them wrongly could
mis-order runs — but the fail-closed rule bounds the damage to the unorderable case, and the
alternative (ignoring the rollup entirely, or trusting merge status alone) is strictly weaker.

## 3. Blast radius

One function plus one type widening in `src/core/StageTransitionValidator.ts`. `ciIsGreen` is private
to that module (`grep` for callers: only the `to === 'merged'` branch). The route passes the rollup
through unchanged. No response shape changes; no new code.

## 4. Rollback plan

Single-commit revert; no state, config, migration or artifact. Reverting restores the previous
(over-refusing) behaviour immediately.

## 5. Test coverage

`tests/unit/StageTransitionValidator.test.ts` (46 pass), five new cases: the live #1641 shape
(superseded FAILURE + later SUCCESS ⇒ green); the reverse (SUCCESS + later FAILURE ⇒ not green);
unorderable-runs-fail-closed across three variants; unnamed entries not collapsed; and an in-flight
latest run still not green.

No integration/e2e tier added: this is a pure predicate inside an existing gate whose route path is
already covered, and the decisive evidence is the end-to-end check below.

## 6. End-to-end evidence, gathered BEFORE the fix and after

The validator's real logic was run against the two real merged PRs with the route's exact helper
wiring:

```
before:  item 1 (PR 1641) -> CI_NOT_GREEN
         item 2 (PR 1644) -> MERGE_BASE_UNVERIFIABLE   (stale local ref; resolved by git fetch)
after:   item 1 (PR 1641) -> WOULD SUCCEED
         item 2 (PR 1644) -> WOULD SUCCEED
```

Note the second line: the `MERGE_BASE_UNVERIFIABLE` code shipped hours earlier in #1643 did its job
here on a real case — an unknown local SHA reported as *unverifiable* rather than as a false "not an
ancestor".

## 7. Third instance in one code path, in one evening

The completion-recording path has now yielded three independent defects tonight, each the same
underlying error:

| | defect | what it reported |
|---|---|---|
| #1640 | the `gh` binary was unreachable | a flat refusal |
| #1643 | a SourceTreeGuard refusal was caught and returned as `false` | "the merge is not on main" |
| this | a superseded check run read as the check's current state | "CI is not green" |

All three presented identically from outside — an opaque refusal — and each masked the next. That is
worth recording as a property of the path rather than three coincidences: **a code path whose failures
all render as one indistinguishable refusal will hide its own defects in series.** The general fix is
the one #1643 started: distinguish "could not determine" from "determined, and the answer is no".

## 8. How it was found

By refusing to assert. I was about to report that recording would work once the server updated, and
instead ran the validator's own logic against the real PRs. It returned two different refusals. That
cost two minutes and avoided discovering both blockers serially, each appearing to be a fresh
mystery. Habit worth keeping: **before claiming something will work once a dependency lands, execute
its logic now and read what it returns.**
