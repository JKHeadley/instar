# Side-Effects Review — Machine care Off (CMT-1203, third slice)

**Version / slug:** `machine-care-off`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `not required: Off can only stop restarts; its one root step removes the one file enrolment installed, by its fixed path`

## Summary of the change

Machine self-maintenance Part F, the page's **Off** (the spec's `/remove`, the card's Remove action):

- `EnrolmentController.remove(by)`: the enrolment record is moved aside to `enrolment.removed.json` with who and when (never deleted), this machine's enrolment offers are cleared so the owner can sign up again from the page, and the reboot rule `/etc/sudoers.d/instar-reboot` is taken out where passwordless sudo works (`sudo -n true`, `sudo -n rm -f <fixed path>`, `sudo -k`). Without passwordless sudo the record is still removed, the rule is left (inert: nothing restarts without the record), and the answer says so.
- `POST /machine-maintenance/remove`: recent dashboard PIN unlock required (401), 503 when enrolment is not wired. Registered machine-local in `WriteDomainRegistry`.
- The restart actuator's in-lock fresh check now refuses when the enrolment record is absent (`machine not signed up`). So Off stops a Restart now countdown already running at the moment it would dispatch, not only new offers and taps.
- The Machine care page shows **Turn off** for a signed-up machine, with a confirm naming the machine, then the PIN.

Not in this slice: the host `do-not-maintain` marker from the page (the enrolment card's "Not this machine" already writes it), remote machines and the app's routes.

## Decision-point inventory

- Restart actuator fresh check — modify — adds "refuse when not signed up", read synchronously inside the host lock.
- Enrolment offer dedupe — modify (by data) — Off clears this machine's offers, so the next Sign up sends a fresh card.

---

## 1. Over-block

Off stops every restart on this machine, including the owner's own Restart now, until the owner signs up again. That is what Off means; the page says it in the confirm.

---

## 2. Under-block

Where the rule cannot be removed (no passwordless sudo), the file stays. It grants only the two restart lines and is unused, because both restart paths refuse without the record. The spec's one-time administrator drop for that case is a later slice.

---

## 3. Level-of-abstraction fit

Removal sits in `EnrolmentController` next to the install it reverses, with the same injected runner. The in-lock refusal sits in the actuator's existing `freshCheck`, beside "machine care switched off".

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No new judgment authority. An explicit operator choice, in the safe direction only.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

None: a file exists or it does not.

---

## 5. Interactions

- Restart now: refused at offer and tap (`enrolled` reads false) and, for a countdown already running, at dispatch inside the lock. The controller already closes the episode and tells the owner when a dispatch is refused.
- The watch-only guarantee test pins every sudo call in `EnrolmentController`; the three Off calls are added to that pinned list, so any other root step still fails the test.
- Enrolment readiness reads the record with `readEnrolment`; after Off it reads not enrolled and offerable again.

---

## 6. External surfaces

HTTP: one POST route (PIN-session gated). Dashboard: one button with a confirm. One root step (rm of the fixed rule path) where passwordless sudo exists.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Plain answers: "Turned off. This machine won’t be restarted, and its restart permission is removed. Sign up again any time.", or that the permission is still installed but unused, or "This machine was not signed up, so nothing changed."

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** (`hardware-bound-resource`): the record and the rule belong to one physical machine, outside the agent home, never git-synced. Remote targets by signed mandate are a later slice.

---

## 8. Rollback cost

Revert the code. A machine turned off stays off (no record) until the owner signs up again; the record set aside is kept for reference.

---

## Conclusion

The owner can turn machine care off for this machine from the page, and that stops every restart path, a running countdown included. Clear to ship.

---

## Evidence pointers

- Unit: `tests/unit/machine-enrolment-controller.test.ts` (record aside and rule removed with the exact sudo calls; no passwordless sudo leaves the rule and says so; not signed up changes nothing; Sign up offers a fresh card after Off), `tests/unit/machine-maintenance-watch-only.test.ts` (Off's three sudo calls pinned), `tests/unit/console-machine-care.test.ts` (Turn off shown only when signed up, its answers in words, the confirm and the PIN proof in jsdom).
- Integration: `tests/integration/machine-maintenance-route.test.ts` (401 without a bearer, without and with a wrong PIN unlock; 503 dark; the record set aside and the rule calls through the real route).
- E2E: `tests/e2e/machine-maintenance-lifecycle.test.ts` (the route alive and PIN-gated on the production wiring; the in-lock refusal present in `server.ts`).

---

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `guard` — Off adds no self-action; it removes the permission and the record the `machine-restart` Eternal Sentinel's path requires (`src/testing/selfActionRegistry.ts`, proven by `tests/unit/self-action-convergence.test.ts`, enforcement: ratchet).
