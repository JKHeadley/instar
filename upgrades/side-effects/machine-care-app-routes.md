# Side-Effects Review — Machine care from the owner's phone (CMT-1203, fourth slice)

**Version / slug:** `machine-care-app-routes`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `not required: the phone can only skip, undo a skip, move the window (all safe direction) or ask for the Restart now card, which still needs the owner's tap`

## Summary of the change

Machine self-maintenance Part F, the app's fixed addition to its device-signed list:

- `GET /mobile/machine-care`: the same pooled status the dashboard's Machine care page reads.
- `POST /mobile/machine-care/:machineId/:action` for `skip`, `unskip`, `window` and `restart`. `:machineId` must be this machine's mesh id or `self`; any other id gets 409 `other-machine`. Skip, Undo and window go through the same host record and audit as the dashboard, recorded as `mobile-device:<deviceId>`, and the answer carries `viaMobileDevice: true`.
- `restart` sends the owner the Restart now card (the same offer as the dashboard). Nothing restarts until the owner taps it there. The spec's in-app 2-minute confirm, which would let the app start the countdown itself, is not built. Until it is, the phone takes the same path as the dashboard.
- Both routes are owner phones only (`ownerOnly` device rules, re-checked in the route), and they refuse the agent's bearer token (403). So the agent cannot use the phone path to act on its own, as it cannot use the PIN-gated dashboard routes.
- Machine-local `WriteDomainRegistry` row for `POST /mobile/machine-care/`.

The app's screen ships in the app's own release; the dashboard page works on a phone until then.

## Decision-point inventory

- Device allowlist — add — two owner-only rules (`capacity-reads` and `permission-actions` buckets).
- Phone route admission — add — device principal with the owner role, else 403.

---

## 1. Over-block

A phone can change only the machine it is connected to. Changing another machine needs the app connected to that machine, until the signed relay exists.

---

## 2. Under-block

An owner phone with an active signature can skip or move the window without Face ID. The spec allows this: both are in the safe direction. Restart still needs the Telegram tap.

---

## 3. Level-of-abstraction fit

The routes sit beside the dashboard controls in `routes.ts` and call the same `DrainRehearsal` methods and `RestartNowController.offer()`. Device admission stays in the one allowlist in `mobilePairingRoutes.ts`.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No new judgment authority. The owner's explicit choices from their own signed device.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

None.

---

## 5. Interactions

- The dashboard controls are unchanged; both surfaces write the same `controls.json` with a different `by`.
- Team phones: the rules are `ownerOnly`, so they are never named in `TEAM_ROUTE_TIERS` and stay closed to members and guests.

---

## 6. External surfaces

HTTP: two device-signed routes. The restart action sends at most the one Restart now card per the controller's own rules.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Refusals are plain: "Only the owner's phone can change machine care here.", "Change this machine from the app connected to it.", and the window rule from the controls.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** (`hardware-bound-resource`): writes only this machine's host record and refuses other machine ids.

---

## 8. Rollback cost

Revert the code. An older app never calls these routes; a newer app gets 404 and falls back to the dashboard page.

---

## Conclusion

The owner's phone can read machine care and skip, undo or move the window for the machine it is connected to, and ask for the Restart now card. The agent's own token cannot. Clear to ship.

---

## Evidence pointers

- E2E: `tests/e2e/machine-care-app-alive.test.ts`. A phone paired through the real redeem/confirm path reads the status. A skip from it shows in the status and is recorded as the phone. A short window is refused and a valid one applies. Another machine's id is refused. The bearer is refused on both routes.

---

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `guard` — the phone routes add no self-action: they refuse the agent's own token, and a restart stays behind the owner's tap and the `machine-restart` Eternal Sentinel (`src/testing/selfActionRegistry.ts`, proven by `tests/unit/self-action-convergence.test.ts`, enforcement: ratchet).
