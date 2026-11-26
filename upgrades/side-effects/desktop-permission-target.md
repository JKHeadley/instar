# Side-Effects Review — desktop permission prompt on non-front targets

**Version / slug:** `desktop-permission-target`
**Date:** `2026-11-01`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1: 2 source files changed, 1 added, 2 test files; effort 0 spec rounds. `POST /desktop/request-permission` read `ctx.directDesktopAccess`, which `AgentServer` sets only on the designated front, so every target answered 503. New `src/server/desktopRouteContext.ts` splits the constructed target into the front-only handle and a target-side `desktopRequestPermission` function; `AgentServer.ts` spreads that into the route context and `routes.ts` uses the new function in that one route. Front-only logic keeps its exact comparison.

## Decision-point inventory

- `/desktop/request-permission availability` — modify — now keyed on "this machine constructed a target" instead of "this machine is the front".
- `front-only desktop routes` — pass-through — still gated on `ctx.directDesktopAccess`.

---

## 1. Over-block

No new refusals. A non-front target that used to answer 503 now answers 200, 409 (host cannot show prompts, for example Windows) or 429 (paced).

---

## 2. Under-block

The route now runs on more machines. Anyone holding that machine's Bearer token, with the intent header, can make a prompt appear on its screen once a minute. That matches the front's existing exposure and grants nothing. No gap identified beyond that.

---

## 3. Level-of-abstraction fit

Right layer. The split sits at the one wiring point where front and target are told apart, and the route stays thin. `DirectDesktopAccess.requestPermission` already owns the disabled and unsupported checks.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface beyond availability of an existing route, decided by a constructed-object check, not brittle logic.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic added at a competing-signals decision point. Availability is a structural fact.

---

## 5. Interactions

Only `requestPermission` is exposed to non-front routes; `targetInfo`, `begin`, `status`, `ticket`, `cursor` and `revoke` are not. The kill switch still applies: `requestPermission` throws when disabled, giving 409. `desktopLocalDiagnostics` is unaffected. The pacing variable is per server process, so each machine paces itself.

---

## 6. External surfaces

One HTTP status changes on non-front targets, from 503 to 200, 409 or 429. A macOS system prompt can appear on that Mac when called. Docs in the capability index and the CLAUDE.md template already describe the route without a front restriction, so no migration is needed.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** A permission prompt belongs to the physical screen of the machine it runs on, and the route acts only on its own host. No user-facing notice, durable state or generated URL.

machine-local-justification: hardware-bound-resource

---

## 8. Rollback cost

Revert the commit and ship a patch. No state, config or data migration.

---

## Conclusion

Narrow fix to a wrong gate on one route. Safe to ship.

## Second-pass review (if required)

Not required: no messaging, session lifecycle, sentinel or gate logic is changed, and the route grants nothing.

## Evidence pointers

`tests/unit/desktop-route-context.test.ts` and `tests/integration/desktop-routes.test.ts`. Live evidence is in `upgrades/next/desktop-permission-target.md`.
