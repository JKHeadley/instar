# Side-Effects Review — Maturation Board

**Version / slug:** `maturation-board`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `not required (read-only, no decision point; see Decision-point inventory)`

## Summary of the change

Adds a read-only board of every maturing feature (spec `docs/specs/maturation-board.md`, Tier 2
by declaration because it adds a published interface). New: `src/monitoring/MaturationBoard.ts`
(pure builder: review validation, joins, deadlines, closed conflict table, three-state follow-up),
`src/server/maturationBoardRoutes.ts` (`GET /maturation/board`, parts local/owners/review/probe,
pool merge), dashboard `maturation-board{,-model}.js` + standalone `dashboard/maturation/`, a
console Work tile and native page, styles. Changed: `AgentServer.ts` hoists the analyst's
`DarkFlagMaturationRegistry` instance onto a field and mounts the route; `types.ts` adds the
`maturationBoard` config type; `devGatedFeatures.ts` registers the gate; CLAUDE.md template +
`migrateClaudeMd` section. Tier 2, ~1,600 LOC incl. tests; spec 3 review rounds; 1 build pass.

## Decision-point inventory

No decision-point surface. The board gates, blocks, filters and routes nothing; it reads and
displays. The only conditional outputs are display arithmetic (past a date, unchanged reviews)
and a closed comparison table (conflicts) that resolves nothing.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Display filters: plain task initiatives and
digest-bookkeeping-only rollouts are not listed as features (counted instead); a bare guard row
alone is not a feature. A feature tracked only by guard posture would therefore not appear unless
the review or a rollout/D7/dark-flag record names it — the review covers ~180 features, so the
gap is small and stated.

## 2. Under-block

No block/allow surface. Display gaps, all stated on the page: dates are empty for features with no
recorded deadline (the two existing reviews stored none as data; JSON reviews from 2026-10-30 on
carry `expectedBy`); compound review ids display but do not join to owner records; an initiative
linked only by text is not counted as a follow-up (by design).

## 3. Level-of-abstraction fit

A view over existing owners, as feature-maturation-discipline D6 requires: no registry, store,
timer or scorer. Readiness stays D7's; the stuck-too-long judgement stays D4's (named future owner).
It deliberately does not call `/growth/*`, whose reads write files.

## 4. Signal vs authority compliance

Neither: it is a read-only display. It holds no authority (`authority: 'none'` in every response),
and nothing consumes it to decide anything.

## 4b. Judgment-point check

No judgment point added. Verdicts are passed through verbatim from the review job, which is the
existing judgment layer (two model families within floors).

## 5. Interactions

- `DarkFlagMaturationRegistry`: the board calls `load()` (pure read) on the analyst's own instance;
  the analyst remains the only writer. A missing/corrupt/foreign file is reported as can't-tell.
- Guard inventory: built with the same inputs as `GET /guards` (one config read per uncached call).
- D7 `localSummary(168)`: a read; no new table or timer.
- Pool reads add at most 12 rebuilds/minute, 4 peers per batch, 750 ms per peer; 60 s response cache.
- Console: a tile probe (`?part=probe`) once per page load; the page refreshes every 30 s in the
  console and every 60 s standalone, both served from the 60 s cache.

## 6. External surfaces

New authenticated route and a static page (static files carry no data, like the console). Review
and commitment text is rendered with `textContent` only (jsdom test injects markup and confirms it
stays text). The weekly review job's message links the page once it answers (agent config, done
separately on the Studio).

## 6b. Operator-surface quality

Phone-first: first view is one headline sentence and five tiles (Dashboard UX F10); tapping a tile
opens the filtered list; filter state lives in the URL so a link reproduces a view; cards under
720 px; light and dark themes; every colour chip also carries the word. Screenshots of the served
page at 1280 px and 390 px were read before shipping. "Can't tell" and "No date set" are shown
honestly instead of guessed values.

## 7. Multi-machine posture

Unified via proxied-on-read: each machine reports its own live owner facts, machine-tagged and never
merged into one value; review rows come from the machine with the newest valid review (date ≤
tomorrow; ties to the lowest machine id), bound by hash to the digest that won; a machine that did
not answer is named; an offline review machine is labelled and its commitment statuses are never
shown as current. Review files themselves are single-machine today (not introduced here; tracked as
ACT-006).

## 8. Rollback cost

Set `maturationBoard.enabled: false` (or revert): the route 503s, the tile hides, the page shows the
off state, the review job leaves the link out. Nothing persisted; no migration to undo. The only
non-route code change, the registry hoist, keeps the same instance and behaviour for the analyst.

## Conclusion

Ships as a dark-on-fleet, live-on-dev read-only view. No decision point, no persisted state, no
authority.

## Evidence pointers

- Spec + convergence: `docs/specs/maturation-board.md`, `docs/specs/reports/maturation-board-convergence.md`
- Tests: `tests/unit/maturation-board.test.ts`, `tests/unit/console-maturation-board.test.ts`,
  `tests/integration/maturation-board-route.test.ts`, `tests/e2e/maturation-board-alive.test.ts`,
  `tests/unit/PostUpdateMigrator-maturationBoardSection.test.ts`

## Addendum — 2026-10-30 (follow-on commit)

Two catch blocks in `maturationBoardRoutes.ts` now carry the `@silent-fallback-ok` justification
(neither is silent: a peer failure becomes a named `sources[]` row; a build failure is logged and
answered as an explicit 500). The growth-analyst wiring test now checks the hoisted line, which still
proves the analyst receives a real, machine-scoped registry. No behaviour change beyond the log line.
