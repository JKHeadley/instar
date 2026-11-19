# Side-Effects Review — Work Board: My board

**Version / slug:** `work-board-my-board`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `not required (read-only view; no gate, sentinel, guard, watchdog, lifecycle or messaging decision)`

## Summary of the change

Adds one read-only field, `myBoard: { sections: [{ reason, words, cardIds, notStarted, more? }] }`, to the Work Board read (`boardJson`, used by `GET /work-board` and `GET /mobile/work-board`), driven by the converged and approved addendum `docs/specs/work-board-my-board.md` (amends `work-front-doors.md` §6). New exports in `src/core/workBoardViews.ts`: `myBoardReason`, `myBoardJson`, `MY_BOARD_ORDER`, `MY_BOARD_WORDS`. The waiting lane's sort gains a card-id tie-break so the soft cut is the same on every machine. One awareness entry (`src/data/awareness/work-board-my-board.md`) and one sentence in the capability index tell the agent about it. Tier 1: one source file (~75 lines), the capability index line, an awareness entry, one new unit file (9 tests) and three assertions on the existing integration and e2e board tests. Effort: 2 spec rounds (Tier-1 cap 3), one build pass. Depends on PR #3404 (turn, started/startedAt, lanes).

## Decision-point inventory

- `myBoardReason` — add: picks the one section a card is listed under. Pure function of status, open question addressee, carrier and lane; gates, blocks and routes nothing. Every card stays in the lanes.
- Waiting-lane sort — modify: equal `newestRecordAt` now ordered by card id before the existing soft cut. The cut and its number are unchanged.

---

## 1. Over-block

No issue identified: nothing is refused or hidden. Every card still appears in its lane; My board is an extra index into the same read.

## 2. Under-block

Not a gate. Known limit: in phase 1 a member's "reply" and "own" sections are always empty (no question or carrier can name a member yet), and "Cards you were added to" means every open card shared with the member, not a per-card people list (spec frontloaded decision 7).

## 3. Level-of-abstraction fit

Right layer: the one serializer every surface uses (`boardJson`), next to `turnFor` and the untouched-first ordering. Computing it server-side means the dashboard, iPhone, Mac and Android share one precedence rule instead of four.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`): a presentation signal with no authority. It cannot approve, block, hold or notify; taps still go through the existing PIN / Face ID paths.

## 5. Interactions

The Needs-you read (`boardFor`, `full: true`) and the Projects read also receive the field and ignore it. The soft-cut tie-break can change which of several cards with the identical timestamp is shown (before: map insertion order); the count is unchanged. No double-fire, no race: the field is derived inside the same synchronous read.

## 6. External surfaces

One additive JSON field on two existing routes. Older clients ignore it; newer clients reading an older agent fall back to lanes. Privacy: a member's sections are built only from cards that already passed the board's `mayRead` filter, and `more` counts only that viewer's own cut cards (integration test asserts ids resolve within the member's own read).

## 7. Multi-machine posture

Proxied-on-read from replicated state: derived on every read from the replicated `workBoard` card fold, plus the two per-read inputs the lanes already use (the reader's clock for `quiet`, the machine's in-memory capacity-wait state). Sections follow each machine's lanes; nothing machine-local is added, nothing stored, no notices, no URLs.

## 8. Rollback cost

Revert the commit and ship a patch. No data, config or migration; clients fall back to lanes when the field is absent.
