# Side-Effects Review — enrolment: the owner's one tap (CMT-1200, second slice)

**Version / slug:** `machine-enrolment-tap`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required by tier rules; flagged for the live proof (L6) before any restart path uses the record`

## Summary of the change

Machine self-maintenance Part C. New `EnrolmentController`: `offer()` sends ONE message per machine and set of facts (readiness mode) into the owner's conversation (lifeline topic) with the spec's card text, the open apps (via `lsappinfo`, no Apple Events), the co-resident agents, the one owner step when the machine is attended, and two buttons bound to a single-use 24 h nonce: "Yes, keep it healthy" (`mc:enrol:`) and "Not this machine" (`mc:dnm:`). `onTap()`: the Telegram adapter's new `mc:` branch passes `fromIsOwner` from the configured approver (P-class, owner-only, as the `ns:` taps); the controller refuses a non-owner, a stale/foreign/used nonce, a guard that cannot prove taps (`LifelineIngressGuard.tapsProvable()`, published by routes.ts), an active refusal or an existing enrolment. On Approve it installs the reboot rule in one root step only where `sudo -n true` already works: the exact restart lines from `RestartActuator`, written to a staging directory inside `/etc/sudoers.d` (skipped by sudo because of its dot), validated with `visudo -cf`, chowned root and chmod 0440, renamed to `/etc/sudoers.d/instar-reboot`, then `sudo -k`, then read back byte for byte and checked in `sudo -n -l`. It writes `~/.instar/host-maintenance/enrolment.json` (`proving` when unattended-ready and the rule is in, else `attended`; principal `telegram:<id>`, the nonce as proof). "Not this machine" writes the host do-not-maintain marker. New route `POST /machine-maintenance/enrol/offer` (Bearer; registered machine-local in `WriteDomainRegistry`). Still nothing restarts: no caller of `RestartActuator` exists.

## Decision-point inventory

- Owner tap acceptance — add — invariant: owner principal + live nonce + provable tap + no refusal.
- Rule install — add — a privileged system write, only on the owner's tap, only with passwordless sudo, with read-back.

---

## 1. Over-block

A machine whose lifeline has not proved itself since start cannot be enrolled until it does; the reply says to try again in a minute. A machine without passwordless sudo is enrolled `attended` (reminders only), which the spec accepts for v1 except the macOS administrator dialog, not built here.

---

## 2. Under-block

Everything runs as one OS user, so the proof is cooperative (spec Honest limits): a session that deliberately reads the ingress secret could forge a tap. The Telegram path is the only tap surface in this slice; the dashboard card and a remote machine's signed mandate are later slices.

---

## 3. Level-of-abstraction fit

Reuses the adapter's owner-only button pattern, the ingress guard's existing `tapsProvable()` (the same check pairing uses), and the actuator's command table for the rule text, so the rule and the dispatched commands cannot drift.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over other work. The only authority is the owner's own tap, verified deterministically.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point: "may this machine ever be restarted" is the spec's `invariant` row (owner's verified tap, per machine).

---

## 5. Interactions

The `mc:` branch runs before the `ns:` branch in the callback dispatch; no other prefix starts with `mc:`. The offer route writes only host files under the agent's own login. The record is read by the existing `EnrolmentStatusReader` (cached 10 minutes).

---

## 6. External surfaces

- Telegram: one offer message per machine per set of facts, sent only when the route is called.
- System: `/etc/sudoers.d/instar-reboot` on the owner's tap, exactly the restart lines. Removal: delete that file (spec: `instar nuke` and the card's Remove do this in a later slice).
- Operator surface: the tap is phone-completable in Telegram.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. Leads with the primary action: the question and the "Yes, keep it healthy" button are the whole message.
2. No raw internals: machine name, plain card text, app names; the nonce is only in button data.
3. Destructive de-emphasized: "Not this machine" is the second button and is the safe direction.
4. Plain language and phone width: one short paragraph, two full-width buttons.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** (`hardware-bound-resource`): consent to restart a physical machine and the OS grant on it. Each machine offers for itself; the pool read shows each machine's `enrolment`.

---

## 8. Rollback cost

Revert the code; an installed `/etc/sudoers.d/instar-reboot` is inert without a caller (and the actuator refuses without an enrolment path), and can be deleted. Host files are ignored by older builds.

---

## Conclusion

The owner's one tap, as the spec describes, minus the dashboard card and the macOS administrator dialog. Nothing restarts. Clear to ship; the live L6 proof (a real tap from the owner's phone) comes before any restart path reads the record.

---

## Evidence pointers

- Unit: `tests/unit/machine-enrolment-controller.test.ts`. Integration: `tests/integration/machine-maintenance-route.test.ts` (offer route).

---

## Class-Closure Declaration (display-only mirror)

No defect fixed and no self-triggered loop added (the offer runs only when the route is called).
