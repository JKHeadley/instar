# Side-Effects Review — Restart now: the owner-tapped restart (CMT-1199, third slice)

**Version / slug:** `machine-restart-now`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `flagged: first code path that can restart a machine; the live proof (the owner's real tap on the Studio after deploy) is required before calling it done`

## Summary of the change

Machine self-maintenance Part E "Operator trigger" / Part F "Restart now": the first caller of `RestartActuator`. New `RestartNowController`:

- `offer()` (route `POST /machine-maintenance/restart-now/offer`, Bearer) sends the OWNER a card in their conversation: "Restart <machine> now?", what happens (5 minutes for running work to save its place, then restart), and — named first — a person using the machine (S3), low battery (S4) and a boot under 6 hours ago. Buttons `mc:rn:<nonce>` ("Restart now" / "Restart anyway") and `mc:rnx:<nonce>` ("Not now"), nonce single-use, 15 minutes. It refuses to offer when switched off, not enrolled, holds unread, S1 (OS update installing) or S2 (disk/firmware operation) active, or a countdown is already running. Nothing restarts from the route.
- `onTap()`: owner-only (`mc:` adapter branch, configured approver), live nonce, lifeline ingress guard armed. Re-reads holds: S1/S2 refuse; an S3/S4 not named on the tapped card gets a fresh card instead. `reserveEpisode({kind:'operator', overrideRecentBoot: card named it})`, then every running session of this agent gets one internal notice ("restarts at HH:MM, save your place"), the owner gets "Restarting at HH:MM" with a Cancel button (`mc:rnc:`).
- At T-0 (5 min) rung 1 runs through the actuator (`claimRung` re-checks the off switch, S1 and S2 inside the host lock, from holds read just before dispatch). Still up 8 minutes later: rung 2. Still up 8 minutes after that: the episode reads `outcome-unknown` and the owner is told plainly; nothing more is sent by itself. Cancel works only before rung 1.
- The countdown is a host file (`~/.instar/host-maintenance/restart-now.<agent>.json`), re-armed at server start; a countdown from an earlier boot is cleared, never dispatched (and `claimRung` refuses a wrong-boot dispatch anyway).
- `GET /machine-maintenance` carries `restartNow` (the active countdown or null).

Not in this slice (spec's short drain, later): closing new work through `MaintenanceGate`, lease handoff, cancel at T-3 and pause at T-1, the dashboard card, the lifeline `/lifeline restart-machine` path. Running sessions are told and resume from their place after boot, as after the 11-16 hand restart.

## Decision-point inventory

- Owner tap starts a restart — add — invariant: owner principal + live single-use card + provable tap + enrolled + switch on + no S1/S2; S3/S4/recent boot only when named on that card.
- Rung ladder — add — fixed: rung 1 at T-0, rung 2 at +8 min, unknown at +16 min; each dispatch through `claimRung`.

---

## 1. Over-block

An unread hold reading refuses the restart (S1/S2 cannot be cleared unread). On a Mac with `ps` unreadable this blocks Restart now; the owner is told why in one line. An unenrolled machine cannot use Restart now; enrolment is one tap.

---

## 2. Under-block

Everything runs as one OS user, so the tap proof is cooperative (spec Honest limits): a session that deliberately reads the ingress secret could forge a press. S1/S2 readings are unproven live (L7). Work that can't save its place in 5 minutes is interrupted; it resumes from its last saved point. Ordinary apps' unsaved changes are named on the card as at risk.

---

## 3. Level-of-abstraction fit

Uses the episode ledger, brakes and `claimRung` from the actuator slice, the owner-only `mc:` button branch and ingress guard from the enrolment slice, and `SessionManager.injectInternalMessage` (in-process, audited with source `machine-restart-now`) for the session notice. No new privileged command: the actuator's table is the only one.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No new judgment authority. The only authority to restart is the owner's own tap, verified deterministically; the checks are invariants from the spec's table.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic at a competing-signals point: the operator trigger is the spec's explicit human action ("a human action on the always-allow lane").

---

## 5. Interactions

The `mc:rn*` prefixes route to this controller; `mc:enrol`/`mc:dnm` still route to enrolment. An open automatic episode is taken over (generation bump) by the operator reserve, as the spec requires. The PostRestartProof attributes the boot through `observeBoot` and runs its proof after.

---

## 6. External surfaces

- Telegram: a card only when the offer route is called; one "Restarting at" message with Cancel per tap; one plain message if it doesn't happen or reads unknown.
- Sessions: one internal notice each at the tap, one on cancel or refusal.
- System: the machine restarts (the point). Only through the sudoers rule installed at enrolment.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. Leads with the question and the primary button.
2. No internals: machine name, clock time, plain hold wording.
3. "Not now" and Cancel are always offered; the risky variant reads "Restart anyway" when something was named.
4. Phone width: short lines, full-width buttons.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** (`hardware-bound-resource`): restarting a physical machine. Each machine offers and restarts only itself; a remote card by signed mandate is a later slice.

---

## 8. Rollback cost

Revert the code; a countdown file is ignored by older builds. A restart already sent cannot be undone (it is the action), which is why it needs the owner's tap.

---

## Conclusion

The owner can now restart an enrolled machine from one tap, with a 5-minute notice to running work, a Cancel, the spec's hard holds and brakes, and an honest unknown when the machine doesn't go down. Clear to ship behind enrolment; live proof on the Studio after deploy.

---

## Evidence pointers

- Unit: `tests/unit/machine-restart-now.test.ts` (real store + real actuator, injected spawn). Integration: `tests/integration/machine-maintenance-route.test.ts` (offer route). Guarantee: `tests/unit/machine-maintenance-watch-only.test.ts` pins the one actuator, the one dispatch and the one session notice in server.ts.

---

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `guard` — Restart now dispatches at most rung 1 then rung 2 per owner tap, each through `claimRung` under the real brakes already modelled as the `machine-restart` Eternal Sentinel in `src/testing/selfActionRegistry.ts`, proven by `tests/unit/self-action-convergence.test.ts` (enforcement: ratchet). The ladder ends in a terminal `outcome-unknown`; nothing re-sends by itself.
