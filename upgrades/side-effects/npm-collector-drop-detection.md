# Side-Effects Review — npm collector: drop and gap detection, date-based comparisons

**Version / slug:** `npm-collector-drop-detection`
**Date:** `2026-11-17`
**Author:** `Dawn (workstation), landing work by instar-codey from 2026-10-24`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1. Two files of runtime change: `scripts/collect-metrics.py` (the operator's npm/GitHub telemetry collector, run by Dawn's `instar-metrics` job against `~/.instar/telemetry`) and its new stdlib test file `scripts/tests/test_collect_metrics_changes.py` (50 tests), plus a `.gitignore` entry for Python bytecode. The collector is a standalone operator script: it is not imported by `src/`, not shipped in the npm package's runtime, and not run by any user's agent. The change (a) lands the drop/gap detectors and structured `change_notes` built on branch `dawn/prop-instar-collector-drop-detection` on 2026-10-24 and never merged, and (b) makes the spike and week-over-week comparisons use calendar dates instead of ledger rows. Size: 3 files, ~1,050 LOC (mostly tests). Effort: one review pass, three commit attempts (the first two were the hooks not being installed in a fresh worktree and this gate asking for this artifact).

## Decision-point inventory

- `detect_significant_changes` npm_spike — modify — compares the end_date day with the calendar day before it (from the current daily_breakdown), not with the previous run's last_day.
- `detect_significant_changes` npm_drop — add — week below 60% of the previous calendar week or the previous run.
- `detect_significant_changes` npm_gap — add — 2+ interior zero-download days.
- `compute_trends` npm_week_prev — modify — sum of the 7 calendar days before the current week; None with a reason when any day is unknown.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The decisions only choose whether to send an informational Telegram alert to the operator and what to write into the telemetry ledger.

---

## 2. Under-block

No block/allow surface. As detectors: a drop smaller than 40% does not alert (by design; the 10-19 −31% week is a normal variation and stays quiet). When the ledger lacks a day in either 7-day window, npm_week_prev is None and the week-ago drop check is skipped for that run; the previous-run baseline still runs. A single interior zero day does not count as a gap.

---

## 3. Level-of-abstraction fit

Right layer. The collector is the only producer of these figures; computing them correctly where they are produced is cheaper and more reliable than having each reader (the `instar-metrics` job's report) recompute WoW by hand, which is what produced the wrong +177% and +10.9% claims.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It produces signals (ledger fields, change_notes with a `kind`, an operator alert). Nothing is blocked.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The thresholds (2x spike, 60% drop, 2 interior zero days) decide only whether to emit an informational alert; there are no conflicting live signals to arbitrate.

---

## 5. Interactions

- **Shadowing:** staleness used to return before every comparison; now it skips only the spike comparison, so drop and gap still run on stale data (a stalled npm feed is one cause of a collapsed week).
- **Double-fire:** spike and drop are different windows (day vs week) and can both alert on one run; each is labelled.
- **Races:** the collector appends one ledger row per run; reads happen before the append. No concurrency change.
- **Feedback loops:** `compute_trends` now reads up to 30 prior rows instead of 7. Values it writes (npm_week_cur/prev and windows) are not read back by the week computation, which uses only daily_breakdown.

---

## 6. External surfaces

- Other agents / install base: none. The script is not part of any agent's runtime.
- External systems: the operator Telegram alert text changes (spike now names both dates; a new drop alert). Alert delivery now resolves the the-portal checkout under `~/Projects` first instead of a hardcoded `~/Documents` path.
- Persistent state: new ledger rows carry `change_notes` as objects (`kind`, `message`, ...) instead of strings, and `trends` gains `npm_week_cur`, `npm_week_cur_window`, `npm_week_prev_window`, `npm_week_prev_unavailable`. Old rows keep strings; `format_summary` renders both shapes. The only reader is Dawn's `instar-metrics` skill, which already documents both shapes.
- Operator surface: no operator-facing actions.

---

## 7. Multi-machine posture

Machine-local by design: the collector runs on one machine against its own `~/.instar/telemetry` ledger, and the figures it measures (npm downloads, GitHub traffic) are global, so a second machine running it would produce the same numbers in its own ledger.

---

## 8. Rollback cost

Revert the commit. Ledger rows written meanwhile keep object-shaped `change_notes`, which the old `format_summary` ignores (it never printed change_notes), so no data repair is needed.
