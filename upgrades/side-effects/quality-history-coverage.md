# Side-Effects Review — Quality history: account for every item and say what is not shown

**Version / slug:** `quality-history-coverage`
**Date:** `2026-11-09`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

This is a follow-up to PR #2994, after a live check of `GET /maturation/board?part=quality` (48 items; 11 `no-points` missing from the subline; `subjectsOmitted` 1634 and `notReadable['missing-contract']` 381 never shown on the page).
- `src/server/measurementQualityGlance.ts`: subjects are ranked as with a contract, then needing repair or with an unregistered target, then with no contract. Only the first two groups are read within the 400 limit. Subjects with no contract are counted as `noMeasurement` and never read. `subjectsOmitted` now counts only readable subjects beyond the limit.
- `dashboard/console/quality-history.js`: the subline names every status group. A first-screen coverage line says "This machine only. Not shown: …" and carries an ask link. The key adds a note when points were thinned. Results from older servers (which report `missing-contract` reads) are shown as "no measurement".
- Tests: unit, integration and e2e. Tier 1, 2 source files plus CSS, one commit attempt.

## Decision-point inventory

No decision-point surface; display and read ordering only.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. If more than 400 subjects have a contract, the remainder is still left out, but it is now counted on the first screen as "past the read limit".

---

## 3. Level-of-abstraction fit

The ranking uses the same owner fields that `readMeasurementDetail` checks, in the same order: error, then target, then contract. No second classifier of measurement state is introduced.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority; the response stays `advisory: true, authority: "none"`.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point.

---

## 5. Interactions

Fewer detail reads per request, because subjects with no contract are skipped. The cache and single-flight behaviour are unchanged. The per-item detail route is unchanged.

---

## 6. External surfaces

The read adds a `noMeasurement` field, and `notReadable` no longer carries `missing-contract` from this server. The page reads both the old and the new shape.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The headline, subline and coverage line come first and the charts follow. At 1280x728 six charts stay on the first screen. At 390x844 one full chart plus the next card's title are visible, because the coverage line takes about two lines.
2. **Zero raw internals as primary content?** Yes. The coverage line is plain words, and the reasons in the details are humanized.
3. **Destructive actions de-emphasized?** None present.
4. **Plain language + phone width?** Yes. No horizontal scroll at 390 px, checked in Chrome.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, as before. The first-screen line now says "This machine only." in words. No status surfaces change.

---

## 8. Rollback cost

Revert; no state.

---

## Conclusion

Closes the completeness gap the live check found, without changing what the charts claim.

---

## Second-pass review (if required)

Not required.

---

## Evidence pointers

- `tests/unit/quality-history-glance.test.ts`: subline covers every group, the coverage line sits above the charts with an ask link, old-server shape, `subjectRank`.
- `tests/integration/maturation-quality-glance-route.test.ts`: 450 unmeasured subjects sort before the measured ones. Both measured subjects are still read, `noMeasurement` is 450 and `subjectsOmitted` is 0.
- `tests/e2e/maturation-board-alive.test.ts`: the production route reports `noMeasurement` and no `missing-contract` reads.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
