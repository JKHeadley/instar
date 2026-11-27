# Side-Effects Review — Machine care page (CMT-1203, second slice)

**Version / slug:** `machine-care-page`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `not required: a read page over existing routes; its buttons call only routes that already exist and keep their own gates (PIN session for Skip and window, the owner's Telegram tap for Sign up and Restart now)`

## Summary of the change

Machine self-maintenance Part F surfaces: the dashboard "Machine care" page at `#/capacity/machine-care`.

- One plain sentence per machine from `GET /machine-maintenance?scope=pool`: signed up or not (and why not: someone else signed in, or a login screen after restart, with the owner's one fix), the restart hours, that weekly restarts are practice only while the status says `watch-only`, when it last started, a skip and until when, and a countdown running.
- For the machine serving the page only: **Sign up** (`POST /machine-maintenance/enrol/offer`), **Restart now** (`POST /machine-maintenance/restart-now/offer`), **Skip once** / **Undo skip** and **Change window** (PIN-session routes from #3303). Sign up and Restart now only send the owner a Telegram card; nothing happens until the owner taps it there.
- Other machines show their sentence and "To change <name>, open its own dashboard." Machines that did not answer are named with the reason.
- Reachable from the Capacity tiles on the Agent door, from the Machines page (a link under the restart-care line), and by the phone app's short name `machine-care`.
- Agent awareness entry `src/data/awareness/machine-care-page.md`: send the operator the page instead of acting.

Not in this slice: **Off** (the spec's `/remove` and `/do-not-maintain` routes do not exist yet), controls for a remote machine (signed relay), and the app's device-signed routes. Each is a later CMT-1203 slice.

## Decision-point inventory

- Which controls a row shows — add — pure, from the status: only the serving machine, only while machine care is on; Sign up only when `offerable`; Restart now only when enrolled and no countdown is running; Skip or Undo by `controls.skipped`.

---

## 1. Over-block

A remote machine's row has no buttons, so the owner must open that machine's dashboard. That is the honest limit until the signed relay exists.

---

## 2. Under-block

The buttons cannot do more than their routes allow: Skip and window need the PIN session (the page asks for the PIN and sends `X-Instar-Operator-Session`), and Sign up and Restart now are offers whose effect needs the owner's Telegram tap. A page bug could at worst send an offer the owner then ignores.

---

## 3. Level-of-abstraction fit

The words and the control choices are in `machine-care-model.js` (pure, unit-tested both sides). `machine-care.js` only renders and calls the routes, like every other console page.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No new judgment authority. The page shows the status and passes the owner's explicit choices to existing gated routes.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing signals: the row's controls follow directly from fields in the status.

---

## 5. Interactions

- The Machines page keeps its restart-care line and gains one link to this page.
- The console nav gains one Capacity tile; `NATIVE_PATHS`, `NATIVE_PAGES` and the phone alias stay in step (front-doors test).
- A failed or older-server read: a failed read shows the reason, never an empty all-fine page; an older server answering only for itself is shown as this machine.

---

## 6. External surfaces

Dashboard: one new page and one link. No new HTTP route. The page sends the existing offers (each sends at most one Telegram card per the controllers' own rules).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Every server answer is turned into plain words (`controlAnswer`): PIN needed again, the 2-hour rule, a busy store, the controller's own refusal reason, "I sent you a card in Telegram. Tap … there". No ids, codes or file paths on the page. Layout reuses the console's card, button and details styles, so it works at phone width.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

The page reads the pooled view (any machine can serve it). Controls act only on the serving machine, which is what the routes act on (`machine-local BY DESIGN`, `hardware-bound-resource`); remote targets by signed mandate are a later slice.

---

## 8. Rollback cost

Revert the code. The page and the link disappear; no state was added.

---

## Conclusion

The owner now has the Machine care page the spec describes, for this machine's Sign up, Skip once, Change window and Restart now, with every machine's state in one sentence. Clear to ship. Off, remote controls and the app's routes follow.

---

## Evidence pointers

- Unit: `tests/unit/console-machine-care.test.ts` (each sentence and control choice on both sides, failed read, older server, pool order and unreachable machines, every server answer in words, nav; the page in jsdom: Restart now sends no PIN proof and reports the Telegram card, Skip asks for the PIN and sends the unlock proof, a remote machine has no buttons).
- Integration: `tests/integration/console-static-serving.test.ts` (both files served as JavaScript).
- E2E: `tests/e2e/machine-maintenance-lifecycle.test.ts` (the real status route through the page model: "can't tell" without an enrolment reader, Skip and window offered, a skip turns into Undo).

---

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `guard` — the page adds no self-action. Its buttons reach the existing offer and control routes; any restart stays under the `machine-restart` Eternal Sentinel in `src/testing/selfActionRegistry.ts`, proven by `tests/unit/self-action-convergence.test.ts` (enforcement: ratchet).
