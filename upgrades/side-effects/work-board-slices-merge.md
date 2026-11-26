# Side effects — combining Work Board slices 1, 2 and 3 into one PR

This PR folds three already-reviewed PRs into one branch so they need one Local Verify run instead of three:
#3396 (slice 1, project rows), #3400 (slice 2, cards appear) and #3394 (slice 3, card closeout and the
card's conversation). Each slice keeps its own approved spec, side-effects artifact, trace and second-pass
reviewer concurrence:

- `docs/specs/work-door-project-rows.md`, `upgrades/side-effects/work-door-project-rows.md`
- `docs/specs/work-board-cards-appear.md` (slice 2), `upgrades/side-effects/work-board-cards-appear.md`
- slice 3: `upgrades/side-effects/work-card-closeout.md` and `upgrades/eli16/work-card-closeout.md` (spec: `docs/specs/work-front-doors.md`)

## Merge order and conflicts

Merged onto origin/main 0afbf73fc in order 1, 2, 3. Slices 1 and 2 merged cleanly (ChiefOfStaffLoop.ts
auto-merged). Slice 3 had two conflicts, both resolved by keeping both sides and nothing else:

1. `src/core/WorkCardStore.ts` `SCHEMA_MAX`: slice 2 added `whyYou` and `coverKeys`; slice 3 added
   `closeNote`. The combined object holds all three. Slice 3's `CLOSE_AS` / `CloseAs` are kept as written.
2. `src/server/mobilePermissionsRoutes.ts` `buildAction` extra-field type and `actionExtras`: slice 1 added
   `itemId`, `checkRef`, `bindingRef`, `noteHash`; slice 3 added `closeAs`. Both field sets are carried. The
   project actions (slice 1) and the closeout tap fields (slice 3) are read by different `kind` branches, so
   neither reads the other's fields.

## One guard-test addition

`tests/unit/mobile-session-terminal.test.ts` names every owner-only phone route exactly. Slice 1 added two
owner-only rules (`/mobile/work/projects/check` and `/mobile/work/projects/(pause|done-item|finish)`) that the
named set did not list, so that guard failed on #3396. The four routes are added to the named set. Slices 2
and 3 add no new phone route (they use the existing work-card tap route). No source change.

## Behavior beyond keeping both sides

None. No line of either side was altered; the only new lines are the union of the two field lists and the
four test entries above. So no extra second-pass review is needed for the merge itself; each slice's own
reviewer concurrence stands.

## Rollback

Revert the merge commit for the slice to back out (each slice is one merge commit on this branch), or revert
the PR as a whole.
