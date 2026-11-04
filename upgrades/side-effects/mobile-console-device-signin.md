# Side-Effects Review — Owner phone opens the console without the dashboard PIN

**Version / slug:** `mobile-console-device-signin`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 2 (touches sign-in and credentials). An owner's paired iPhone can open the agent console without typing the dashboard PIN. The app enrols a second Secure Enclave key (the presence key, which signs only after Face ID / Touch ID / the passcode) with a proof of possession, asks for a single-use server challenge, signs it with that key, and receives a 60-second single-use ticket bound to the device and the signed Host. The console page redeems the ticket once at a public route for exactly the token `/dashboard/unlock` returns (never the operator session). New: `src/server/mobileConsoleTicket.ts`, three allowlisted device routes, `POST /dashboard/console-ticket` (exact-path bearer exemption), `DeviceRecord.presenceKey` + `setPresenceKey`, config switch `mobilePairing.consoleTicket.enabled` (default on), `dashboard/console/ticket-model.js` and a boot step in `console.js`, a CLAUDE.md line rewrite + migration, an amendment note in `mobile-device-keys.md`. App: `PresenceKey.swift`, `ConsoleSignIn.swift`, `ConsoleView.swift` rewrite (non-persistent store for device-key agents, origin-guarded injection, one-shot script, one-time purge), `AppLock` keeps its authenticated `LAContext`. Size: about 15 files, ~900 LOC including tests. Effort: 5 spec review rounds (cap 6), one commit attempt planned.

## Decision-point inventory

- Presence-key enrollment: device, owner, local TLS, switch, valid key format, proof of possession, set once — **add**, invariant.
- Challenge / mint: device, owner, local TLS, switch, challenge single-use and bound to device+Host, presence signature — **add**, invariant.
- Redeem: local TLS, switch, ticket single-use + Host-bound, device still active owner (registry + ledger + person), throughput limit on unknown tickets only — **add**, invariant.
- App plan (token / ticket / PIN) — **add**, invariant; every failure falls back to today's PIN box.
- Bearer-gate exemption for `POST /dashboard/console-ticket` — **add**, exact method + path.

---

## 1. Over-block

- A legitimate owner whose phone has no passcode, or whose presence key was deleted by removing the passcode, gets the PIN box (409 → "pair again" note). Intended.
- A lease move of a shared tunnel hostname between mint and redeem (within 60 s) answers 401 → PIN box. Rare and safe.
- A Host rewrite by a front (`httpHostHeader`) would make every redeem 401 → PIN box. Instar's fronts pass the Host through (pairing and multi-route already depend on it).
- Behind the tunnel all remote callers share the loopback address, so the 10/min per-address limit on unknown tickets is effectively global; a known ticket is judged before the limit, so the operator is never blocked by it.

## 2. Under-block

- The token handed to the console outlives a revocation that happens while the console is open, until the screen closes or the API token is rotated (same as a PIN-unlocked tab). Tracked as feedback `fb-d588d77a-cf8` (device-bound console session).
- The server cannot verify the presence key's Secure Enclave origin or `.userPresence` policy (no App Attest); an attacker controlling the app process before first enrollment could enrol a software key. Same attacker could read a typed PIN.
- The phone passcode stands in for the PIN (`.userPresence` accepts it). Stated in the spec.
- A third-party local proxy that accepts plain HTTP and forwards over loopback passes `arrivedOverLocalTls`; the app only ever posts to `https`, and this is the same limit device signatures already accept.

## 3. Level-of-abstraction fit

Reuses the PIN unlock's console credential and storage path (the console stores the token exactly as after a PIN unlock), the device authenticator for the signed requests, `arrivedOverLocalTls` for transport, the device registry + key ledger + person resolution for revocation. A device-bound session would be the deeper fix and sits at the bearer-gate layer; it is out of this change's scope by the brief and tracked as feedback.

## 4. Signal vs authority compliance

Every gate is a cryptographic or exact check (signature, single-use secret, registry status, transport), the hard-invariant class `docs/signal-vs-authority.md` exempts from the judgment requirement. The audit log is a record, never a gate; a failed write is reported through DegradationReporter and does not affect the answer.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points. All decision points are invariants (spec "Decision points touched" table), each with a deterministic fallback to today's PIN box.

## 5. Interactions

- `authMiddleware`: one new exact-path exemption placed beside `/dashboard/unlock`; the route is also registered before the gate, so the gate never sees it. GET on the path still needs a bearer (tested).
- `deviceAuthenticator`: three new allowlist rows (JSON bodies, `active` only); the shared per-device rate limit and replay set apply as for every device route. Mint replay safety does not depend on the replay set (single-use challenges).
- `/dashboard/unlock` and its PIN budget: untouched. The console still falls back to it.
- Device revocation: the redeem re-reads registry + ledger, so revocation wins without a hook in the revoke route.
- PostUpdateMigrator: the new line rewrite composes with the earlier Tailscale and word-code rewrites (different match conditions; tested with the word-code fresh text).

## 6. External surfaces

- New public HTTP route `POST /dashboard/console-ticket` (input: a 256-bit single-use secret; output: the API token).
- Three new device routes visible to paired phones.
- A new audit file `.instar/state/mobile-console-tickets.jsonl` (metadata only, rotated at 1 MB).
- The iPhone app's console web view for device-key agents becomes non-persistent and purges a stale stored token once; on an older server the operator types the PIN on every console open.
- CLAUDE.md wording for the mobile pairing section changes on update.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes: the console opens signed in; when it cannot, the PIN box is the first and only thing shown, as today.
2. **Zero raw internals as primary content?** Yes: no ticket, challenge or key is ever rendered; the only new text is the app's plain note "Sign-in without the PIN needs this phone paired again (remove it, then pair)."
3. **Destructive actions de-emphasized?** No destructive action added.
4. **Plain language + phone width?** The change is the removal of a step on the phone; the console's existing phone layout is unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, with markers in the spec's posture section: challenges and tickets live in one process's memory and redeem for that machine's own API token (hardware-bound-resource); the presence key sits on the device record of the machine the phone paired with, which is the only machine that can verify that phone (physical-credential-locality, consistent with `mobile-device-keys.md`); the audit log sits beside the per-machine registry. No user-facing notices. Durable state: only the presence key on the device record (follows the device record). Generated URL: `redeemOrigin` is the Host the phone itself signed for; a ticket redeemed elsewhere fails to the PIN box.

## 8. Rollback cost

Revert the server PR and ship a patch: routes vanish, apps fall back to the PIN box, memory-only tickets expire in 60 s, the `presenceKey` field becomes inert, the audit file is inert. The CLAUDE.md line on already-updated installs would overstate the feature until a later update; no data migration. The app ships separately (Echo, TestFlight); an app already on phones keeps the non-persistent store (which the device-keys spec required anyway).

---

## Conclusion

The review and five spec rounds changed the design materially: a server-verifiable presence key replaced an app-side "owner verified" flag; single-use server challenges replaced a clock-based restart check; the redeem became Host-bound, TLS/loopback-only, switch-checked, and throttles only unknown tickets; enrollment gained proof of possession; the device-keys spec exception was made explicit and a device-bound session was filed as feedback. Clear to ship pending the second-pass concurrence below.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent (claude-opus-5-5), 2026-11-03
**Independent read of the artifact: concur**

Concur with the review. Verified against the code: the redeem answers only `{ token }`; single-use deletes happen before any other check for challenges and tickets; the redeem re-reads registry, key ledger and owner role; transport is checked first; the bearer exemption is exact method + path; the app injection is a JSON literal guarded by `location.origin`, main frame only, removed after first navigation. One non-blocking gap raised and fixed before commit: after a passcode is removed and set again, iOS replaces the presence key while the app still believed it was enrolled, so every open silently fell back to the PIN box; the app now clears its enrolled flag on a `401` from the mint (other than an expired challenge), so the next open re-enrols, gets `409`, and shows the "pair again" note.

---

## Evidence pointers

- **User-role live proof (real Chromium, real console page, throwaway agent on a real port, phone stand-in signing as the app does):** valid ticket on an owner phone → signed in, no PIN box, ticket gone from session storage; same ticket again → PIN box; unknown ticket → PIN box; no ticket → PIN box; ticket minted then phone revoked → PIN box; MSP phone → mint refused `403 owner-phone-required`. Result: PASS. The first run FAILED on the valid-ticket row and found a real defect: a phone paired on an address the device authenticator's strict host parser rejects (an IP with a port) could never redeem, because the redeem compared a null normalized Host. Fixed with one shared `normalHost` used on both sides, and pinned by a unit test. Limits: the proof ran over plain HTTP on loopback (which the redeem accepts as loopback), not through a TLS front; the iOS Secure Enclave paths (context reuse without a second prompt, invalidated context, passcode removal) run first on the operator's phone and each fails safe to the PIN box.
- **App:** `xcodebuild test` on the iPhone 17 Pro simulator: 158 tests, 0 failures, including 10 new `ConsoleSignInTests`.

- Spec: `docs/specs/mobile-console-device-signin.md`; convergence report `docs/specs/reports/mobile-console-device-signin-convergence.md`.
- Tests: `tests/unit/mobile-console-ticket.test.ts`, `tests/unit/dashboard-console-ticket-model.test.ts`, `tests/unit/mobile-console-ticket-awareness.test.ts`, `tests/integration/mobile-console-ticket-routes.test.ts`, `tests/e2e/mobile-console-ticket-lifecycle.test.ts`; app `apps/instar-ios/Tests/InstarAppTests/ConsoleSignInTests.swift` (agent-home repo).
