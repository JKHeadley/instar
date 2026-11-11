# Side-Effects Review — Unified usage ledger, Slice 5 (console)

**Version / slug:** `unified-usage-ledger-slice5`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Fifth build slice of `docs/specs/unified-usage-ledger.md`: a "Token usage" section on the existing "What thinking costs" console page (`dashboard/console/costs.js`), directly under the page head, in the spec's order:

1. **Headline** — tokens and equivalent cost for the page's time window, with the unpriced share, not-reached and catching-up machines, a this-machine-only answer and partial counts stated beside it, plus one line saying the figure is list-price-equivalent, not what was billed.
2. **Usage over time** — stacked bars per hour (Today) or day (7/30 days), split by model or by engine (toggle), six named series at most with the rest folded into "Other", legend, per-bar hover, and a "Show as a table" view.
3. **Drill-down** — agent → machine → engine → model → conversation → session, as a tap-to-drill list of bars with a breadcrumb back up; a session opens its request rows (`/usage/events`).
4. **Top conversations, jobs and checks** by equivalent cost, conversations by name (pool topic names).
5. **Cache hit rate** over time (cache read ÷ all input; a bucket with no input has no point) and **by machine**, where a machine that did not answer says "not reached" instead of a zero.
6. **What is measured** — attributed, priced and complete-count shares, and every unknown in words (unread sources, disputed tokens, dropped calls, models with no price).

New files: `dashboard/console/usage-model.js` (all decisions, pure) and `dashboard/console/usage.js` (view, text via `textContent`/SVG text nodes). `console.css` gains `--series-1..6` for both themes and the section's styles. The section is absent when `/usage/summary` answers 503 (ledger off) or 404 (server predates it), so the fleet's page is unchanged.

**Decided during the build (reversible):** the spec names a sunburst for the drill-down; I built a tap-to-drill bar list instead. Bar lengths compare more accurately than wedge angles, labels stay readable at phone width, and it reaches the same levels and the same session detail. A sunburst can be added later over the same `/usage/tree` answer.

**Chart colours:** the six series hues were run through the palette validator against the console's own surfaces (`#0a0e17` dark, `#f7f9fb` light): all checks pass in dark; in light three hues are under 3:1 against the surface, which the rule allows only with visible labels or a table view — the chart carries both a legend and a table view.

**Rendered and looked at** in headless Chromium at 1280 and 390 wide, light and dark. That pass found and fixed: the chart and table pushing the section wider than a phone screen (grid tracks now `minmax(0, 1fr)`), a sub-1% share printing as "0%" (now "under 1%"), axis text scaling too large on desktop (charts capped at 760/420 px) and too small on a phone (a narrower drawing area under 520 px), and list blocks stretching vertically (now top-aligned).

Size: 2 new modules (~420 lines), `costs.js` +25 lines, CSS +45 lines, 1 new test file (12 tests).

## Decision-point inventory

- None. Read-only display.

## 1. Over-block

Nothing is blocked. The older sections of the page are unchanged and still render.

## 2. Under-block

Not applicable.

## 3. Level-of-abstraction fit

Same model/view split as the rest of the console; numbers come only from the Slice 4 read answers.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

Display only.

## 4b. Judgment-point check (Judgment Within Floors standard)

None.

## 5. Interactions

`console-costs.test.ts` (22 tests) passes unchanged. The page makes 8 more GETs (summary first; the rest only when the ledger is on).

## 6. External surfaces

A new section on an existing console page, visible only where the ledger is on.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Every failure reads as a plain sentence ("I could not read the breakdown: …"). Missing machines and unpriced tokens are named next to the totals, never hidden in a zero.

## 7. Multi-machine posture (Cross-Machine Coherence)

Reads go through `/usage/*`, which a standby proxies to the lease holder; the headline says so when only this machine answered.

## 8. Rollback cost

Turning the ledger off hides the section. Removing it is deleting two files and the hook in `costs.js`.

## Conclusion

Safe to ship dark with the ledger.

## Evidence pointers

- `tests/unit/console-usage.test.ts` — 12 tests: headline caveats and basis line; series fold to six with colour following the key; drill query order and parent encoding; drill model labels and openability; top lists by topic name with unpriced tokens; cache rate arithmetic and no-input buckets; machines naming not-reached; coverage shares and unknowns; hidden on 503/404; the shipped console booted in a DOM draws all eight blocks in the spec's order, drills into a machine with the right parent query, and omits the section when the ledger is off.
- `tests/unit/console-costs.test.ts`: 22 pass. Screenshots of the four renders were inspected during the build.
