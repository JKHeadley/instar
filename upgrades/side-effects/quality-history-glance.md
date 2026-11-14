# Side-Effects Review — Quality history at a glance

**Version / slug:** `quality-history-glance`
**Date:** `2026-11-09`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds a read-only `part=quality` to the existing `GET /maturation/board` (`src/server/maturationBoardRoutes.ts`, new `src/server/measurementQualityGlance.ts`) and a console view at `#/work/maturation?s=quality` (new `dashboard/console/quality-history.js`, wired in `maturation-board.js`, `maturation-board-model.js` state key `s`, standalone `dashboard/maturation/app.js`, CSS). The read takes one census of existing measurement owners (new `readMeasurementSubjects` in `measurementCoverageRead.ts`) and calls the existing `readMeasurementDetail` per subject with that census (new optional parameter in `measurementDetailRead.ts`). `measurementChart` gains an opt-in goal line and opt-out caption; its default output is unchanged. CLAUDE.md awareness section added to template and migrator. Tier 1: 9 source files, about 330 lines plus tests; one spec round (no external review), commit attempts noted in the PR.

## Decision-point inventory

No decision-point surface. The status (`off-goal` / `too-few-samples` / `at-goal` / `no-points`) and the ordering are display signals only; nothing reads them to block, allow, retry or notify.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Display gaps: only the first series of each metric is charted (older source/version histories stay in the per-item detail); items beyond 400 subjects / 600 rows / 1 MB are counted in `subjectsOmitted` / `itemsOmitted`, not drawn.

---

## 3. Level-of-abstraction fit

Right layer: a projection over the existing measurement owner, same census and detail reader the board already uses. No parallel registry, store or chart; the page reuses `measurementChart`. The new census helper exists so a whole-board read does not re-walk all inventories once per subject.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority. The response is `advisory: true, authority: "none"`; the off-goal status is a signal shown to a person with an ask link.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point. The latest point is compared against the contract's own threshold and minimum samples, the same comparison the ladder publishes; the result only orders a page.

---

## 5. Interactions

- Event loop: the census is one synchronous walk (as `part=coverage` already does); per-subject detail reads yield with `setImmediate` between subjects, the result is cached 60 s and concurrent requests share one in-flight read. The console's 30 s page refresh therefore hits the cache.
- Measured on Echo's live data: about 140 subjects, 292 rows, about 590 KB.
- `readMeasurementDetail` without the new parameter behaves exactly as before (the existing route and validator are unchanged).

---

## 6. External surfaces

New authenticated, dev-gated read `GET /maturation/board?part=quality` (503 on the fleet like the rest of the board). New console section reachable by `#/work/maturation?s=quality` and a "Quality history charts" link on the board. New CLAUDE.md section. No outbound messages, no writes.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes: the page opens on the answer sentence and the charts; at 390x844 two charts are on the first screen, at 1280x728 six (verified in Chrome, screenshots in the PR). Off-goal cards carry "Ask what to do".
2. **Zero raw internals as primary content?** Yes: names come from the inventory title or a humanized id, metric ids are humanized, no hashes or source refs are shown; read times and omissions sit in a collapsed "Where this comes from".
3. **Destructive actions de-emphasized?** No destructive actions on the page.
4. **Plain language + phone width?** Plain sentences ("Off goal: now 150, goal at most 48. Was 44 on Nov 4."); no horizontal scroll at 390 px (checked in the browser run); links are 28–32 px tall text links like the rest of the board.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine's series lives in its own measurement ledger, and the page reads this machine's (it names the read as "on this machine"). Another machine's detail stays reachable through the existing proxied `part=measurement&machine=` read. No status surfaces (`/status`, `/health`, `/capabilities`, `/channels`) change. The generated link is a relative console hash, valid on whichever machine serves the dashboard.

---

## 8. Rollback cost

Revert the commit. No data, config or state migration; the CLAUDE.md section on already-updated agents is inert text describing a route that would then answer like an unknown part.

---

## Conclusion

Read-only display over existing evidence, with honest labels for unverified comparisons. Clear to ship at Tier 1.

---

## Second-pass review (if required)

Not required: no gate, sentinel, watchdog, lifecycle or messaging decision is touched.

---

## Evidence pointers

- `tests/unit/quality-history-glance.test.ts` (thinning, status boundaries, ranking, page rendering, honesty labels).
- `tests/integration/maturation-quality-glance-route.test.ts` (real ledger → route, proof carried, ordering, cache).
- `tests/e2e/maturation-board-alive.test.ts` (production AgentServer route alive with verified baseline; 503 on the fleet).
- `tests/unit/PostUpdateMigrator-maturationBoardSection.test.ts` (awareness section migration).
- Browser screenshots at 390x844 and 1280x728 against Echo's real measurement data.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.

## Follow-up fix (local verify, 2026-11-09)

The first local verify failed `tests/unit/no-silent-fallbacks.test.ts` (495 against a baseline of 494). The cause was in this change: the scanner reads 20 lines after each catch, and the new cache code (`qualityInFlight = null;`) landed inside the window of the existing peer-read catch, which explicitly answers 503. That made the existing catch look like a silent state reset. Fix: the cache and single-flight logic moved into a `cachedQualityGlance` helper next to the cache declarations, so the route branch is just a read plus an explicit 503. The baseline stays at 494. A failed read is no longer cached and clears the in-flight slot.
