# Side-Effects Review — Machine care controls: Skip once and Change window (CMT-1203, first slice)

**Version / slug:** `machine-care-controls`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `not required: both controls can only make a restart later or move it to another night window; neither can start one`

## Summary of the change

Machine self-maintenance Part F, the first two operator controls:

- **Skip once.** `POST /machine-maintenance/skip` sets `skipUntil` 72 hours after the tap. While it holds, the scheduled-restart planner (today the watch-only rehearsal) opens no new night. `POST /machine-maintenance/unskip` clears it.
- **Change window.** `POST /machine-maintenance/window {window:{start,end}}` sets this machine's restart window: two `HH:MM` clock times at least 2 hours apart (the same floor the config already enforces). `{reset:true}` returns to the config's window. It applies from the next night. A night already open keeps its T-0, because the rehearsal pins `originalRestartAt` when it opens.
- Both live in one host record, `~/.instar/host-maintenance/controls.json`, written under the host maintenance lock. Every agent on the machine plans from the same answer. The record keeps the last 20 changes with who and when.
- `GET /machine-maintenance` shows `controls` (`skipUntil`, `skipped`, `window`), and `settings.window` is the effective window.
- All three routes need a recent dashboard PIN unlock (`X-Instar-Operator-Session`), as the spec says ("operator session"). They are registered machine-local in `WriteDomainRegistry`.

Not in this slice: the dashboard "Machine care" page (the routes need its PIN session, so until it ships only the dashboard's own PIN flow can call them), the app's device-signed routes, Skip on the final-night question's buttons, and Skip closing an episode already draining as `rolled`. Today the night already open is a paper rehearsal, so letting it run on stops nothing real. Agent awareness ships with the page, so agents are never told about a control the owner has no surface for.

## Decision-point inventory

- Planner opens a night — modify — adds "not while skipped".
- Planner's window — modify — the owner's valid window replaces the config's from the next night.

---

## 1. Over-block

A Skip stops the rehearsal's nights for 72 hours, so the rehearsal evidence (14 nights) accrues more slowly. This is the intended effect of a skip.

---

## 2. Under-block

An unreadable or malformed controls file reads as no controls, so a skip in a corrupted file is ignored and the planner uses the config. Nothing restarts from the planner today (scheduled restart is still a rehearsal). When the real scheduled restart lands, its in-lock re-check must read the controls again. That is recorded as a requirement on that slice.

---

## 3. Level-of-abstraction fit

The pure decisions (`validWindow`, `withControls`, `isSkipped`) are in `planner.ts` with the other window arithmetic. The record is in `HostMaintenanceStore` next to the plan, behind the same lock. `DrainRehearsal` reads it each tick through an injected `controls` dep, so a tap applies without a restart.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No new judgment authority. These are explicit operator inputs, validated deterministically, in the safe direction only.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

There is no competing-signals point. The window floor (2 hours) is the spec's structural floor, the same one `normalizeSettings` enforces.

---

## 5. Interactions

- Restart now (operator trigger) is unaffected by Skip: an explicit owner tap is its own decision.
- The wedge trigger's `forcedDueAt` marks a night due early. A Skip holds that night too, because Skip means "this restart does not happen".
- `normalizeSettings` and the live config are unchanged. The owner's window is layered on top, and reset returns to the config.

---

## 6. External surfaces

HTTP: three POST routes (PIN-session gated) and one new `controls` field in `GET /machine-maintenance`. No messages are sent.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Errors are plain: "recent dashboard PIN unlock required", and for a bad window "start and end as HH:MM, at least 2 hours apart". The page that presents these is the next slice.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** (`hardware-bound-resource`): a restart window and a skip belong to one physical machine. The record lives outside the agent home and is never git-synced. Remote targets by signed mandate are a later slice, as for Restart now.

---

## 8. Rollback cost

Revert the code. Older builds ignore `controls.json`, and nothing else reads it.

---

## Conclusion

The owner's Skip once and Change window now exist for each machine as one host record that the planner obeys. Both can only make a restart later or move it. Clear to ship. The Machine care page follows.

---

## Evidence pointers

- Unit: `tests/unit/machine-maintenance-controls.test.ts` (planner both sides; rehearsal skip, unskip, skip during an open night, window next night, window during an open night, one host record across two agents, history cap, malformed file).
- Integration: `tests/integration/machine-maintenance-route.test.ts` (401 without a bearer, without a PIN session and with a wrong one; 503 dark; skip, unskip, window, bad window and reset through the real route, shown in the status).

---

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `guard` — these controls add no self-action. They only withhold or move the scheduled restart, which stays under the `machine-restart` Eternal Sentinel in `src/testing/selfActionRegistry.ts`, proven by `tests/unit/self-action-convergence.test.ts` (enforcement: ratchet).
