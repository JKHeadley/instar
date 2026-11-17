# Side-Effects Review — The Mac app creates the agent and becomes its first owner device

**Version / slug:** `mac-app-creates-agent`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Adds `POST /mobile/local-owner-device` (`src/server/mobileLocalOwnerDevice.ts`, mounted with the public pairing routes, own 4 KB parser in `AgentServer.ts`), the one-time local ticket (`src/core/localOwnerTicket.ts`), `DeviceRegistry.createActiveLocalOwner` with a strict registry read and the `localBinding` record field (`src/core/MobileDeviceKeys.ts`), `'local-install'` in `ApprovedVia`, a `localBinding` branch at the top of the host checks in `deviceAuthenticator` plus refusals of push registration and the notification-token branch for such devices (`src/server/mobilePairingRoutes.ts`), and the installer's `forApp` path in `owner-slot` plus `instar install --app-ticket --key` (`src/commands/install.ts`, `src/cli.ts`). Spec: `docs/specs/mac-app-creates-agent.md` (converged in 4 rounds, approved). Tier 2: auth/identity. Size: about 330 lines of source, 3 test files.

## Decision-point inventory

- `POST /mobile/local-owner-device` accept/refuse — add — the first owner device from the same Mac, gated by a 0600 ticket, same-Mac peer/Host/no-forwarding, key proof, first-owner-only, rate limit.
- `deviceAuthenticator` host branch — modify — a `localBinding` record takes its own branch before the browser and own-name branches; refusal never falls through.
- `/mobile/device/push` and the notification-token branch — modify — refuse a `localBinding` device.
- Document-page signatures (`src/server/documentPageRoutes.ts`) — modify — a `localBinding` device counts only its own loopback host, from loopback.
- Installer `owner-slot` — modify — new `forApp` path; without `forApp` unchanged.

---

## 1. Over-block

A person whose app enrolled, then lost the response, and whose 30-minute ticket expired, needs `--app-ticket` (the app runs it automatically). A person who already paired a phone as owner and then installs the Mac app cannot use this route (409); they pair the Mac the normal way, which is the intended path. A clock more than 60 s off makes the proof stale; the app says to check the clock.

## 2. Under-block

A process running as the same macOS user can read the ticket and enroll before the app does. Such a process can already rewrite the device registry and config directly, so this grants it nothing new (spec §A). An `ssh -L` forward arrives as loopback with no headers; it still needs the ticket file. Another macOS user on the same Mac also passes the same-Mac check: they cannot read the 0600 ticket, but they can spend the 5-call rate limit and burn the ticket with three wrong guesses (a local nuisance only; the app recovers with `--app-ticket`). Multi-machine: a peer with the same port shares the loopback Host string; the record lives only in this machine's registry and the machine id is checked when known.

## 3. Level-of-abstraction fit

It sits in the existing mobile pairing layer and reuses its primitives (`DeviceRegistry`, the device-key ledger, `verifyP256`, `hasForwardingHeaders`, `isLoopbackHost`) instead of a parallel device store. The authenticator change is a branch in the one existing authenticator.

## 4. Signal vs authority compliance

This is an authentication boundary built from facts about the request, the ticket file and the registry (peer address, headers, Host, a constant-time secret compare, a signature). It is deterministic by design, like redeem and browser enrollment; there is no brittle heuristic holding blocking authority over a judgment call.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point is added; every rule is classified `invariant` in the spec with its basis and evidence.

## 5. Interactions

- Redeem, browser enrollment and phone approval are unchanged; `createPending` is unchanged.
- The boot-time `expireAllPending` cannot touch this flow: it creates no pending record.
- The ledger reconcile backfills registry rows into the ledger; the route writes the ledger row first, so a reconcile after a lost registry write sees no registry row and does nothing; the route's own retry rebuilds it.
- Rate limits: the route has its own in-memory limiter; the wrong-code pairing pause does not apply (no typed code).

## 6. External surfaces

One new public route that answers 404 on every agent with no fresh ticket (all existing agents). A new CLI flag set on `instar install`. A new `approvedVia` value; older peers accept it (ledger validation takes any short string) and the only wording map has a fallback.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the device is bound to the loopback address of the Mac it was created on. The record lives in this machine's `mobile-devices.json` (not replicated); the ledger activation row replicates as for any device and authenticates nothing elsewhere. `localBinding.machineId` is checked when both sides know it. Revocation replicates through the ledger as for any device.

**Status surfaces:** no new status surface; feature evidence records under `mobilePairing.localOwnerDevice`.

## 8. Rollback cost

Prefer the kill switch `mobilePairing.localOwnerDevice.enabled: false`: it stops new enrollments and keeps enrolled devices working under every check above. A code revert is different and must be paired with revoking the enrolled local devices from the dashboard device list: after a revert, a `localBinding` record is read by the old authenticator. With multi-route on (the installer's default) its loopback host with a port fails the own-name check, so it stops working. With multi-route off the old code checks the signature against the stored host only, so the device would work from any peer, and push registration and the notification-token branch would accept it again. The key never leaves the Secure Enclave, so this needs that Mac's hardware, but the binding is gone. No data migration.

## Conclusion

Safe to ship: dark on every existing agent by construction, gated by a credential only the agent's own user can read, and covered by unit, integration and e2e tests.

## Second-pass review (if required)

**Reviewer:** second-pass subagent
**Independent read of the artifact: concur**

On re-read, all five earlier points are fixed. The Rollback section now prefers the kill switch and says a code revert must come with revoking the local devices; it names the multi-route-off case. Docpage now refuses a `localBinding` device unless it arrives over loopback at its exact stored host, and only that host counts as its own. `sameMacHost` accepts only `127.0.0.1:<port>`, so the 7(b) rebuild always sees the same host. Under-block now names the other-local-user nuisance. `readStrict` returns its own parsed value, and owner-slot refuses a bad port. The checks follow the spec in order. Records without `localBinding` are unchanged. Retry paths hold. Two small leftovers: the docpage branch does not check `localBinding.machineId` (the Host check is enough there), and the spec's own Rollback section has not gained the code-revert note.

## Evidence pointers

- `tests/unit/mobile-local-owner-device.test.ts` (18), `tests/unit/install-flow.test.ts` (2 added), `tests/integration/mac-app-creates-agent.test.ts`, `tests/e2e/mac-app-creates-agent-alive.test.ts`.

## After local verify

Local verify found two ratchet failures and both are fixed. Three device-record key reads in `mobileLocalOwnerDevice.ts` now go through `deviceKeyOf`, so a browser device's key is read the same way everywhere. The two missing-file fallbacks in `localOwnerTicket.ts` are intended (a missing file means nothing enrolled yet; any other read error refuses) and are now annotated.
