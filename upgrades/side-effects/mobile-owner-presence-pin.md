# Side-Effects Review — Remote Desktop with Face ID and the Dashboard PIN page

**Version / slug:** `mobile-owner-presence-pin`
**Date:** `2026-11-06`
**Author:** `Echo`
**Second-pass reviewer:** `required (auth/credentials) — six rounds of independent reviewers in /spec-converge; see docs/specs/reports/mobile-owner-presence-pin-convergence.md`

## Summary of the change

Tier 2 (an authorization boundary and a secret reveal). Spec: `docs/specs/mobile-owner-presence-pin.md`, converged over 6 rounds.

New modules:
- `src/server/mobileOwnerPresenceRoutes.ts`: the four owner-phone routes, the `/desktop` caller binding, `revealablePin` and the switch.
- `src/server/PhoneDesktopSessionStore.ts`: desktop-only, phone-bound sessions, with the owner check reused for one second.

Wiring:
- `AgentServer.verifyDesktopOperatorSession` replaces the dashboard verifier at the desktop sites only. Those sites are the `DirectDesktopAccess` validator, the mesh front, setup, targets, requests, cursor and displays.
- A PIN change clears the phone sessions too.
- `routes.ts` mounts the routes and the binding, and its desktop sites use `verifyDesktopSession`. That falls back to the dashboard verifier where no phone verifier exists.
- `DEVICE_ALLOWLIST` gains:
  - 4 owner-presence rows (12/min);
  - the app's desktop calls: 20/min for peer reads, 12/min for writes, 240/min for polls.
- The presence-key enrolment route also opens when this switch is on.

Registration and docs:
- `ConsoleTicketAudit` takes a file name.
- Registered in `DEV_GATED_FEATURES`, `feature-ladders.json`, `CapabilityIndex` and the CLAUDE.md template, with a migration.

## Decision-point inventory

- **Owner-presence gate**: added, invariant. Each step is a deterministic cryptographic or ledger fact.
- **Desktop session check**: modified. It now accepts a phone desktop session at the desktop sites only; it is still invariant.
- **`/desktop` caller binding**: added, invariant. A phone session must arrive on its own phone's signed request.

---

## 1. Over-block

- **A bad registry read ends a phone session.** If the device registry can't be read, the phone's desktop session ends (fail-closed), and the phone unlocks again with Face ID.
- **A failed notice blocks the reveal.** When a private chat is reachable but the send fails, the reveal is refused with `409 notice-failed`. Trying again works once the chat is back.
- **Telegram-less owners.** No legitimate user is blocked: they still get the PIN, with `noticed: false`.

## 2. Under-block

- **A thief with the passcode.** Someone who steals the phone and knows its passcode can open Remote Desktop and read the PIN. This is the same trust the existing permission approvals rest on, stated in spec §3.
- **The PIN reaches the API token.** A revealed PIN leads to the API token through a browser unlock, and there is no rotation today; that is a later work (feedback fb-51a654a6-270).
- **No chat, no live signal.** On agents with no private chat, a reveal is silent apart from its audit row.

## 3. Level-of-abstraction fit

- **Gate.** The gate copies the permission-action gate (`mobilePermissionsRoutes` `writeGate`) and reuses its primitives: `BoundSecretStore`, `verifyPresenceSignature`, `activeOwnerPhone`, `signedHost`.
- **Desktop session.** The desktop session is checked where the desktop routes already check sessions. There is no new authority path beside them.
- **Caller binding.** The binding is a router-level check placed before the routes, and a source ratchet test pins it.

## 4. Signal vs authority compliance

All checks are deterministic authentication, so `invariant` applies (`docs/signal-vs-authority.md`). There is no brittle heuristic with blocking authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

There is no judgment point. Every decision follows from a typed fact.

## 5. Interactions

- **Dashboard sessions.** Dashboard operator sessions behave as before. Phone sessions are invisible to every non-desktop operator-session route; a test pins the feature-switch route refusing one.
- **Console ticket.** The console ticket is unchanged, except that its presence-key enrolment route also opens when this switch is on. Its switch-off test was updated.
- **Locked-screen settings.** `POST /desktop/locked/settings` stays dashboard-only.
- **Mesh.** The mesh broker refreshes the front session every 5 seconds, so a phone revocation reaches desktops on other machines within about that.

## 6. External surfaces

- **New routes.** Four new owner-only device routes, plus eleven desktop routes that now accept the owner phone's signature.
- **Notice.** A new private-chat notice on PIN reveal.
- **App behaviour.** New app behaviour on app branch `echo/needs-you-actions`. The app falls back to the PIN box on an older agent (404 or `device-not-allowed`).
- **Browser.** The browser path is unchanged.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

- Every answer has an app screen with a next step (spec §2.6 tables).
- The PIN page holds one line of explanation.
- The PIN is shown only to the owner phone.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design (spec §4), with `physical-credential-locality` markers:

- **Challenges and phone sessions** are live credentials. Desktops on other machines go through the broker's machine-signed assertion.
- **Presence keys** are verified on the paired machine.
- **The revealed PIN** is the value this process compares.
- **The audit** is written next to them.

The notice comes from the machine that revealed. A standby without the Telegram owner reveals with `noticed: false`. There are no URLs. No status surface changes.

## 8. Rollback cost

- **Switch off.** Turn the switch off (`mobilePairing.ownerPresence.enabled: false`, read live). Phone sessions end at the next check, and the app falls back to the PIN box.
- **Revert.** A code revert also works.
- **State.** The only state is an append-only audit file.

---

## Conclusion

Clear to ship once the spec is approved. Review drove these changes:

- **Narrower session.** It went from the dashboard operator session to a desktop-only, phone-bound one.
- **No API token on the phone.**
- **Notice and re-check.** A confirmed notice before a reveal, and a re-check after the wait.
- **Code fixes:**
  - a per-frame disk read;
  - production `ownerDM` never failing;
  - a Face ID inactive bounce in the app;
  - redirect forwarding in the app.

## Second-pass review (if required)

**Reviewer:** six rounds of independent reviewer subagents (security, adversarial, integration, scalability, decision-completeness, lessons-aware) plus GPT-tier and clean-door external reviewers.
**Independent read of the artifact: concur.** The round-6 findings were fixed in place.

## Evidence pointers

- `tests/unit/mobile-owner-presence.test.ts`
- `tests/integration/mobile-owner-presence.test.ts`
- `tests/e2e/mobile-owner-presence-alive.test.ts`
- `tests/unit/mobile-session-terminal.test.ts` (allowlist set)
- `tests/integration/mobile-console-ticket-routes.test.ts`
- `tests/integration/desktop-routes.test.ts`, `tests/integration/desktop-setup-routes.test.ts` (unchanged, passing)

---

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a` (negative declaration)
- **reason:** a one-shot, user-driven action, not a self-triggered loop. The owner notice fires only when the owner taps Show PIN after a fresh Face ID, at most once per phone per 10 minutes, and is never retried. The session store's expiry and eviction run inline on use; there is no timer, retry or respawn.
