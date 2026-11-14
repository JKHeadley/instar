# Side-Effects Review — Locked-proof before-enter injections aimed at the duty

**Version / slug:** `locked-proof-before-enter-aim`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, test tooling only: `scripts/locked-proof/lib.mjs` (+~55), `scripts/locked-proof/driver.mjs` (+~8), `tests/unit/locked-proof-driver.test.ts` (+3 tests). Effort: no spec rounds, one test pass. Fixes fb-fcb17087-521 items 1 and 2: before-enter steps landed 15 to 891 ms after Enter because they were aimed from grant open and fired on a 250 ms poll; runs into a fresh `--out` folder silently ran with no calibration. Now: aim from the duty's `createdAt` + calibrated `createToEnterMs` − 170 ms, sleep to the aim point, poll at 50 ms until the duty appears; record `injectMinusEnterMs`/`limitMinusEnterMs`; fail a before-enter step that started after Enter; refuse runs lacking the needed calibration. Item 3 of that report (12.2a's kill after marker-create found by polling) is not changed here; it passed on its later run and stays a known timing-dependent case in the results page.

## Decision-point inventory

- Proof verdict `judge()` — modify — adds two failure reasons (step after Enter, limit after Enter). This is a test verdict, not a runtime decision; no agent behaviour depends on it.
- Driver `run` start — modify — refuses to start without the needed calibration.

---

## 1. Over-block

A live run where the injection starts a few ms before Enter but the action takes effect after Enter still passes; the measurable fact is the start time, which is what is recorded. A case where the Mac never reached Enter (the step worked) records no gap and is judged as before.

---

## 2. Under-block

The aim depends on createToEnterMs staying steady between calibration and run; a slow Mac can still miss, and the verdict now says so instead of passing. 12.2a's polling race (item 3) is unchanged and documented above.

---

## 3. Level-of-abstraction fit

Right layer: the timing and the verdict both live in the proof driver; the product is untouched.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Test harness verdicts only; nothing ships to agents.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

Deadline cases (15.3, 15.4) keep their own typing aim in `typePassword`; 15.3's before-enter step still fires as soon as the case waits. Other `at` values unchanged. Fired entries gain `startedAt`; existing readers use `t`, unchanged.

---

## 6. External surfaces

None outside the proof scripts. Existing `calibration.json` files without `createToEnterMs` must be redone for the four before-enter cases (the driver says so).

---

## 6b. Operator-surface quality

No operator surface touched — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the driver runs on the one proof Mac against its own test user.

---

## 8. Rollback cost

Revert; no state, no release-time effect.

---

## Conclusion

Test-only fix that makes the before-Enter cases test what they claim and fail honestly when they don't. Clear to ship.

## Second-pass review (if required)

Not required: test tooling, no gate or runtime decision.

## Evidence pointers

- `tests/unit/locked-proof-driver.test.ts` — 74 pass, three new tests named in the release fragment.
- fb-fcb17087-521 measurements: 15.5 +770 ms, 15.7 +891 ms (Nov 6 rerun), 15.1 +256, 15.5 +358, 15.7 +487 ms (Nov 5 clean run).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect, and no self-triggered controller added or changed — not applicable.
