---
title: "An owner's paired phone opens the console without the dashboard PIN"
slug: "mobile-console-device-signin"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mobile-console-device-signin.eli16.md"
status: "approved"
approved: true
approved-by: "Justin (operator), Telegram topic 134088, 2026-11-03 21:48 PST: asked that a phone already unlocked with Face ID not be asked for the dashboard PIN (CMT-1293). The design grants nothing beyond what a PIN unlock gives the same operator (the same API token, never the operator session)."
review-convergence: "2026-11-04T06:27:21.791Z"
review-iterations: 6
review-completed-at: "2026-11-04T06:27:21.791Z"
review-report: "docs/specs/reports/mobile-console-device-signin-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 1
---

## 1. Problem

On 2026-11-03 the operator opened the console from the Instar iPhone app (topic 134088, CMT-1293) and was asked for the dashboard PIN right after unlocking the app with Face ID: "Does it really make sense to require a PIN here when the user has already bio-authenticated?" It does not. The phone is an owner phone, paired with its own Secure Enclave key, and the operator has just authenticated on it. The PIN asks the same person to prove the same thing a second time.

The prompt appears because the app's console web view only opens signed in when the app holds the agent's API token. Phones paired with a pairing link or word code hold no token (by design, `mobile-device-keys.md`); they sign every request with the device key. The console's JavaScript only knows the token, so it falls back to the PIN box.

## 2. What exists (instar main bfca6f0e9, app in the agent home)

- **PIN unlock.** `POST /dashboard/unlock {pin}` (`AgentServer.ts`) is public, refused off a secure transport only when remote desktop is on (`dashboardUnlockRefused`), rate-limited per IP and globally with a durable budget, and on success returns `{ token: <API token>, operatorSessionToken, operatorSessionExpiresAt }`. The console (`dashboard/console/console.js`) stores only `token` in `localStorage['instar_token']` and drops the operator session; every action that needs operator proof asks for the PIN again in that one request (`askPin`).
- **Device keys.** `deviceAuthenticator` (`mobilePairingRoutes.ts`) verifies a signed request (device id, time within ±60 s, host, method, path, body), refuses a revoked device (registry status or a device-key-ledger revocation row), applies the exact `DEVICE_ALLOWLIST`, a per-device rate limit and an in-memory, size-bounded replay set, and resolves the phone's person (`owner` or `msp`). Owner-only device routes already exist (`ownerPhone`).
- **How a phone becomes an owner phone.** A pairing link is minted by a bearer caller; the phone registers its key; the confirmation code goes only to the owner's private Telegram chat or to a PIN-unlocked dashboard session; only typing that code activates the phone. A link's role is `owner` unless it names an MSP person. So an active owner phone exists only because the operator, through their Telegram account or their PIN, approved it.
- **The app.** `ConsoleView.swift` loads `agent.consoleURL` in a `WKWebView` with `websiteDataStore = .default()` and, only when the agent has a token, injects it into `localStorage` at document start for any page the view loads. For device-key agents nothing is injected, so the PIN box appears; once typed, the API token is written into the persistent default store and survives app restarts and device revocation. `mobile-device-keys.md` §2.3 says this web view should be non-persistent; the code drifted.
- **App lock.** `AppLock.swift` asks for device-owner authentication (Face ID / Touch ID / passcode) on launch and on return to the foreground. On a phone with no passcode it cannot ask and simply opens.

## 3. Design

The console keeps exactly one session mechanism: the PIN unlock's. What changes is how the phone proves it may have that session. Instead of typing the PIN, the phone proves two things the server can check: it holds the paired device key, and its owner has just authenticated on it (a second Secure Enclave key that cannot sign without Face ID, Touch ID or the passcode).

### 3.1 The presence key (enrolled once per phone)

The app creates a second P-256 key in the Secure Enclave, tagged per agent, with access control `.privateKeyUsage` + `.userPresence` and protection class `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`: the Secure Enclave refuses to sign with it until the device owner authenticates. A phone with no passcode cannot create it, so it keeps the PIN box. iOS deletes the key if the passcode is later removed; the next enrollment then answers `409`, and the app says to pair the phone again (§3.6). Re-pairing creates a new device record, so set-once never blocks recovery.

New device route `POST /mobile/device/presence-key { publicKey, proof }`, added to `DEVICE_ALLOWLIST` for `active` devices and subject to the same gate as the two routes in §3.2 (local TLS or loopback, owner phone, feature switch on). `publicKey` uses the device key's wire format and validation (`mobile-device-keys.md` §2.1: a base64url 65-byte uncompressed X9.63 P-256 point on the curve), and must differ from the device key. `proof` is a presence-key signature over `instar-presence-enroll-v1\n<deviceId>\n<host>\n<publicKey>`, verified before anything is stored: the phone proves it holds the key and that the key signs (which runs the owner check once at enrollment), so a wrong or broken key is refused at once (`400 presence-proof-invalid`) instead of being stored and failing every later mint. It stores the key on the device's registry record (`presenceKey`). It is set **once**: the same key again (compared as decoded bytes) answers `200` (idempotent); a different key answers `409 presence-key-set` and changes nothing. Replacing it means revoking and re-pairing the phone. The key is shown nowhere and is dropped with the device record when the phone is revoked and pruned.

### 3.2 Mint a console ticket

Two device routes, both added to `DEVICE_ALLOWLIST` for `active` devices. All three device routes (these two and §3.1's) require that the request **arrived over this machine's local TLS front or loopback** (`arrivedOverLocalTls`: a TLS socket, or a loopback peer, which is how the Cloudflare tunnel connector and Tailscale serve reach the server), the phone's person be the `owner`, and the feature switch be on (§3.7):

1. `POST /mobile/console-ticket/challenge` (body `{}`) → `{ challenge, expiresAt }`: 32 random bytes, base64url, kept in process memory with the device id and the signed Host for **60 seconds**, at most 4 per device and 64 in total (oldest dropped first).
2. `POST /mobile/console-ticket { challenge, presenceSig }`. The handler, in order:
   - `403 device-signature-required` unless the principal is a device; `403 owner-phone-required` unless the person is the owner; `409 presence-key-missing` when the device has no presence key.
   - Consume the challenge (deleted before any other check, so it is single-use). Unknown, expired, issued to another device or for another Host → `401 challenge-invalid`. A signed mint captured and replayed later, including after a restart, names a challenge that no longer exists. This makes mint safe without relying on the replay set, which is in memory and size-bounded.
   - Verify `presenceSig` (DER ECDSA-P256-SHA256, strict low-S, the same checks as device signatures) with the presence key over `instar-console-ticket-v1\n<deviceId>\n<host>\n<challenge>`. Invalid → `401 presence-invalid`.
   - Mint the ticket: 32 random bytes, base64url. Only its SHA-256 is kept, in process memory, with the device id, the signed Host and an expiry of **60 seconds**; at most 4 per device and 64 in total.
   - Audit `minted`; answer `200 { ticket, expiresAt, redeemOrigin }` with `Cache-Control: no-store`, where `redeemOrigin` is `https://<signed Host>`.

`503` from all three routes when the console-ticket switch is off or no API token is configured. With mobile pairing itself off, device headers authenticate nothing (`mobile-device-keys.md` §2.7), so the bearer gate refuses these requests `401` before any handler runs.

### 3.3 Redeem it once (the console page)

New public route `POST /dashboard/console-ticket {ticket}`, registered beside `/dashboard/unlock` before the bearer gate and exempted in `authMiddleware` by exact method and path (another method is not exempt). The handler:

1. Refused `403` unless the request arrived over this machine's local TLS front or loopback (`arrivedOverLocalTls`), **whether or not remote desktop is on**. Instar's own fronts on loopback (the Cloudflare tunnel connector, Tailscale serve) accept only HTTPS, so through them the ticket and token never cross a network in clear text. `arrivedOverLocalTls` cannot tell a third-party local proxy that accepts plain HTTP from one of those fronts; such a proxy is outside this guarantee, as it already is for device signatures, which use the same check (this is stricter than the PIN unlock, which skips the check unless remote desktop is on). On the client side the app only ever posts to an `https` `redeemOrigin`, so a front that would also accept plain HTTP at its edge is never used in clear text by this flow.
2. `503` when mobile pairing or the console-ticket switch is off, or no API token is configured: turning the switch off also stops tickets already minted from being redeemed.
3. `400` when the body has no string `ticket` of at most 128 characters.
4. Consume: look up the ticket's SHA-256 and **delete it before anything else**. A known ticket is always judged, whatever other callers are doing. Unknown or expired → a throughput limit applies to this path only (10 a minute per client address, 120 a minute in total, in memory; over it → `429`), then `401 ticket-invalid`; these refusals touch no disk except the aggregated row of §3.4. So an anonymous caller cannot crowd out the operator's real ticket. Behind the tunnel and Tailscale serve every remote caller shares the loopback address, so the per-address limit is effectively global there; that is harmless precisely because a known ticket is judged before any limit. The ticket must be redeemed through the Host it was minted for (the request's `Host` header and the signed Host, which is the Host the device signature was verified against: with multi-route, the request's own `Host` among this machine's proven names; otherwise the host stored when the phone paired, itself read from the pairing request's `Host`. Both fronts pass the original `Host` through, which pairing and multi-route already depend on; both normalized the way the device authenticator normalizes them: lowercase, `:443` and a trailing dot removed); another Host → `401 ticket-invalid`.
5. Re-check the device **now**: pairing still on, the device still `active` in the registry, no revocation row in the device-key ledger, its person still the owner. Otherwise `401 device-not-active`.
6. Audit `redeemed`; answer `200 { token }` with `Cache-Control: no-store`. The answer carries **only** the API token, the value `/dashboard/unlock` returns. It never carries an operator session token, so every PIN-confirmed action in the console still asks for the PIN.

### 3.4 The audit trail

`<stateDir>/state/mobile-console-tickets.jsonl`: `{ at, event, deviceId, reason?, ticketRef? }`, where `ticketRef` is the first 12 hex characters of the ticket's SHA-256. Rows: `minted`, `redeemed`, `presence-key-set`, and `refused` with its reason (`challenge-invalid`, `presence-invalid`, `presence-proof-invalid`, `host-mismatch`, `device-not-active`) **only when a real ticket, challenge or device was involved**. Refusals of unknown tickets and throttled calls from anonymous callers (each still answered with its refusal status) are counted in memory and written as one `refused-unknown { count }` row at most once a minute. Never the ticket, challenge or token. Rotated by `maybeRotateJsonl` at 1 MB. A failed audit write is reported through `DegradationReporter` and does not block the request; the audit is a record, not a gate.

### 3.5 The console page

`console.js` boot gains one step, in a small testable module `dashboard/console/ticket-model.js`:

1. Read the ticket from `sessionStorage['instar_console_ticket']` and **remove it immediately**, before any request, on every outcome.
2. If the stored token is valid → start (as today).
3. Else, if a ticket was read → `POST /dashboard/console-ticket`; on `200` store the token exactly as the PIN unlock does and start.
4. Else → the PIN box (as today). Every failure in step 3 lands here.

The ticket never appears in a URL: not in the query string and not in the fragment.

### 3.6 The iPhone app

For the console home only: `ConsoleView` with `path == nil` **and** an agent whose base address is a bare origin (an agent whose base address is a full link, such as a private view, opens that link as today, with no ticket).

- **Plan** (pure, unit-tested `ConsoleSignIn.plan`): agent has a token → today's injection; agent has a device id, console home, and the presence key exists or can be created → ticket; otherwise → no injection (PIN box).
- **Signature encoding:** the Secure Enclave does not promise low-S signatures, so every presence signature (enrollment proof and challenge) goes through the same low-S, minimal-DER normalization the app already applies to device signatures (`DeviceKey.lowSDER`), as `mobile-device-keys.md` §2.3 requires; the server's strict low-S check then accepts it.
- **Ticket path:** enroll the presence key once (§3.1); request a challenge; sign it with the presence key, passing the app lock's retained, evaluated `LAContext` (`kSecUseAuthenticationContext`) when the app was unlocked within the last 5 minutes (an app-side window; the Secure Enclave accepts any context the system still holds as authenticated), so the operator sees no second prompt; after that window, or when the system has invalidated the context, iOS shows its own Face ID prompt. A `409 presence-key-set` (the phone lost its presence key but kept its device key) shows a one-line note under the PIN box: remove and pair the phone again to restore sign-in without the PIN. Send the mint with `resendable: false` to the address that issued the challenge, and only over an `https` route. On `401 challenge-invalid` (for example a slow Face ID prompt outlived the challenge), fetch one new challenge and try once more. Open the console at `redeemOrigin` + `/dashboard/console/`, so the redeem goes to the Host, and therefore the machine, that minted it. If that first load is redirected to another origin (for example a Cloudflare Access login), the origin guard stops the ticket and the console shows the PIN box. Any failure, including a non-JSON or redirected answer (for example a Cloudflare Access login page in front of the agent), opens the console with no ticket (PIN box).
- **Injection:** a `WKUserScript`, main frame only, at document start, whose ticket and origin are JSON-encoded literals, that writes `sessionStorage['instar_console_ticket']` only when `location.origin` equals `redeemOrigin` (scheme, host and port). The script is removed when the first navigation finishes or fails (including a provisional failure), so a reload or a link followed later never re-injects the used ticket.
- **Non-persistent web view for device-key agents.** A device-key agent's console web view uses `WKWebsiteDataStore.nonPersistent()`, as `mobile-device-keys.md` §2.3 already requires: the token from a ticket or a typed PIN lives only in memory while that screen is open. Token agents keep the default store (unchanged; their token is in the keychain already).
- **One-time purge of the old token.** For a device-key agent, the app removes the default store's local-storage records whose WebKit record name (WebKit's own site grouping, read from `WKWebsiteDataRecord.displayName`, never recomputed by the app) covers that agent's host, unless a token agent in the app shares that domain (it would lose its saved console sign-in; then the purge is skipped and the old record stays, reported in the app's log). The purge is marked done per agent only in the removal's completion callback; a failure leaves it unmarked, so the next open tries again.
- **Origin guard on the existing token injection too.** The bearer-token injection for token agents gets the same `location.origin` guard, so a link followed inside the web view never receives the token.

### 3.7 Switch, awareness and migration parity

- **Switch:** `mobilePairing.consoleTicket.enabled`, omitted ⇒ on wherever mobile pairing is on. Off → the three device routes answer `503` and the app shows the PIN box. Read live.
- **CLAUDE.md:** in `MOBILE_PAIRING_CLAUDEMD_SECTION`, the sentence "The phone never receives the API token and never gets an operator session; it can only make a fixed list of read requests (...) plus confirm and revoke itself." is replaced by one that stays true: the phone stores no API token and never gets an operator session; its signed requests are limited to a fixed list (reads, confirm and revoke itself, plus the owner-phone console sign-in); an owner phone opens the console without the PIN through a one-minute single-use ticket that needs the owner's Face ID / passcode, and the console it opens keeps nothing on disk; PIN-confirmed actions still ask for the PIN; MSP phones and phones without a passcode see the PIN box. `migrateClaudeMd` replaces the old line in place when a line starts with `The operator can add this agent to the Instar iPhone app` and contains `never receives the API token`; the fresh line contains neither phrase's old wording, so a second run changes nothing. New installs get the same line from the same function (a test asserts byte equality).
- **Spec amendment:** `mobile-device-keys.md` §2.3 and its summary bullets gain one sentence each: an owner phone's console web view may hold the API token in memory while open, obtained through `mobile-console-device-signin.md` (the PIN unlock already allowed the same); the device key remains the only stored credential.
- No config migration (the switch's default is the omitted value).

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Presence key: set once, refuse a different key | invariant | First enrollment binds; a change needs re-pairing. No competing signals. |
| Challenge and mint: device, owner, local TLS, challenge known, presence signature valid | invariant | Cryptographic and exact checks, the same family the device authenticator applies. |
| Redeem: ticket known, unexpired, unused, same Host | invariant | A single-use secret either matches or it does not. |
| Redeem: device still active and owner at redeem time | invariant | Revocation must win immediately; reads the same registry and ledger the authenticator reads. |
| Redeem: local TLS or loopback only; rate limit | invariant | Fixed transport and throughput floors; exceeding them falls back to the PIN box. |
| App: ticket vs PIN vs token (`ConsoleSignIn.plan`) | invariant | Deterministic from what the app holds; every failure falls back to the PIN box, today's behaviour. |
| App: owner authenticated | invariant | Decided by the Secure Enclave for a key the honest app enrolled (the presence key will not sign otherwise); the server checks the signature, not the key's provenance (see Verify the state). |

## Verify the state, not its symbol

- **Owner authenticated on the phone.** Symbol: a valid `presenceSig`. State claimed: the device owner passed Face ID / Touch ID / passcode on this phone recently. Corroboration: the presence key lives in the Secure Enclave with `.userPresence`, so the enclave itself refuses to sign without that authentication; the server verifies the signature against the key enrolled for that device. Not proven: that the person is the operator rather than someone who knows the phone's passcode (stated in Security). Unmeasurable (no passcode, no Secure Enclave, enrollment refused): no ticket → PIN box.
- **What the presence key buys, in one line.** The server checks the owner's presence itself, against an app compromised after enrollment that does not wait for the owner; it does not stop an attacker who controls the app from the start or who knows the passcode. The cost is a re-pair after the passcode is removed.
- **What the 5-minute reuse proves.** The window is app logic: the enclave accepts any context the system still holds as authenticated. What the enclave itself guarantees is narrower and still the point: an app compromised after enrollment cannot mint without an owner authentication that the system still holds valid. The app invalidates its retained context whenever it locks (on going to the background), so that lifetime is one foreground session. An app-side check alone (no presence key) was rejected because the server could not tell it ran.
- **What the presence signature does not prove.** The server cannot see that the enrolled presence key is a Secure Enclave key with `.userPresence`; that is a property of the app build that enrolled it. App Attest would prove it and was considered: it adds an Apple service dependency and a second enrollment protocol for a guarantee that an attacker controlling the app process (the only one who could enroll a software key) already defeats on the PIN path. So the claim is: an honest app enrolled this key, and the enclave enforces presence for it.
- **Device still allowed at redeem.** Symbol: the registry and ledger rows. State: the operator has not revoked this phone. Corroboration: the same two sources the device authenticator trusts on every request. Unmeasurable (pairing off, registry unreadable): refuse → PIN box.
- **Audit row.** A record, not proof, and not a gate. The graduation check reads it as a signal.

## Security

- **Authority equals a PIN unlock, minus the operator session.** The redeem returns the same API token `/dashboard/unlock` returns, to the operator's own approved phone, and nothing more: no operator session token, so PIN-confirmed actions still ask for the PIN. The PIN (something the operator knows) is replaced by the phone's owner authentication, which the server verifies through the presence key, plus possession of the paired device key.
- **Deliberate change to the device-keys rule.** `mobile-device-keys.md` promised that nothing a device receives outlives its revocation. The console web view already broke this whenever the PIN was typed in the app (and kept the token on disk). This spec makes the exception explicit and narrower: on a device-key agent the token reaches the phone's console only through an owner-authenticated ticket or a typed PIN (both as today's PIN unlock allows), lives only in memory while the console is open, and the stale on-disk copy is purged, except where a token agent in the app shares the same site (the purge would sign that agent out; that record is left and the skip is logged). A phone revoked while its console is open keeps its local copy of that token until the screen closes; the token itself stays valid on the server, for that copy or any copy taken from it, until the API token is rotated, exactly as for a PIN-unlocked browser tab. The inherited limit, that the console's whole authority is one unscoped token, is filed as feedback `fb-d588d77a-cf8` for a device-bound console session.
- **Why a ticket, not the token straight from the mint.** The mint already proves everything the redeem re-checks, so the app could receive the token directly. The ticket keeps the token out of the app's native code entirely (no network-stack buffers, no user script carrying it, nothing to leak into logs or crash reports): it is created on the server and handed only to the console page on its own origin, through the same storage path the PIN unlock uses. The cost is one public route whose only input is a 256-bit single-use secret.
- **Why not passkeys.** WebAuthn in the web view would need an associated-domains entitlement for every agent's hostname, which arbitrary agent hosts cannot provide.
- **What a captured or stolen key gets.** The device key and presence key cannot leave the Secure Enclave. Someone holding the unlocked phone still needs the owner's Face ID or passcode to mint. Someone controlling the app process on an unlocked phone could wait for the owner to authenticate; that attacker could equally read a PIN typed into the same app, so the PIN offered no protection there.
- **The passcode stands in for the PIN.** `.userPresence` accepts the phone passcode as well as biometrics. Someone who has watched the passcode being typed and takes the phone can open the console. The same person could watch the PIN being typed. This matches the operator's request ("already bio-authenticated") and iOS's own fallback; stated here so it is a known trade.
- **Enrollment window.** An attacker controlling the app process before the app first enrolls its presence key could enroll their own. Same attacker class as above; after the first enrollment the key cannot change without re-pairing.
- **Leak paths closed:** no ticket or token in any URL; ticket, challenge and presence-key requests only over local TLS or loopback; injection limited to the minting origin and removed after first use; tickets and challenges stored only as hashes or in memory; audit holds no secret; 60-second single-use lifetimes; replay, including across a restart, defeated by single-use challenges.
- **MSP phones**, phones without a passcode, and token agents behave as today.

## Multi-machine posture

Challenges and tickets are minted and redeemed on one machine, in that machine's memory, bound to the Host they were signed for. The app opens the console at that Host. If that Host's traffic moves to another machine between mint and redeem (a lease move on a shared tunnel name, within the same 60 seconds), the other machine does not know the ticket, answers `401`, and the console shows the PIN box: safe, and rare. The token returned is that machine's own API token, so the console the app opens talks to that machine, as a PIN-unlocked console on that Host does today. The presence key is stored on the device's registry record on the machine the phone is paired with, like the device key itself. The audit log is per machine, like the device registry it describes.
- machine-local-justification: hardware-bound-resource impossible-because="challenges and tickets are secrets held only in one server process's memory and redeem for the API token stored on that machine's disk; another machine cannot verify or honour them" permanence=permanent
- machine-local-justification: physical-credential-locality impossible-because="the presence key is meaningful only beside the device key it was enrolled with, and that device record is verified only on the machine serving the hostname the phone signs for (mobile-device-keys.md); a copy elsewhere could never be consulted" permanence=permanent
- machine-local-justification: hardware-bound-resource impossible-because="the audit log records events of the per-machine ticket store and device registry it sits beside" permanence=permanent

## Tests

- **Unit (server)** `tests/unit/mobile-console-ticket.test.ts`: challenge and ticket stores (43-character base64url, hashes only, single-use, 60 s expiry, Host and device binding, per-device 4 and total 64 caps); presence-signature verification (valid, wrong key, wrong challenge, wrong host, high-S, malformed); redeem logic refuses unknown, used, expired, other-Host tickets, a revoked device (registry and ledger), an MSP person and pairing off, and returns only `{ token }`; the rate limiter; audit rows never contain a secret, and unknown-ticket refusals aggregate.
- **Unit (console)** `tests/unit/dashboard-console-ticket-model.test.ts`: the ticket is removed from session storage before the request; a valid stored token wins without a redeem; a ticket redeems and stores the token; every failure returns to the PIN path.
- **Integration** `tests/integration/mobile-console-ticket-routes.test.ts`: on a real server with an owner device paired through the real flow: enroll a presence key (again with the same key → 200, another key → 409); challenge → mint → redeem returns the API token once and `401` the second time; the token opens `GET /sessions`; a bearer caller gets `403` at mint; an MSP phone gets `403`; a replayed mint (same signed request) gets `401`; a mint whose challenge came from a server instance before a restart gets `401`; a ticket redeemed on a second server instance gets `401`; revoking the device between mint and redeem gives `401`; a redeem over a non-loopback, non-TLS connection gets `403`; GET on the redeem path is not exempt from the bearer gate; a burst of unknown tickets past the limit does not stop a real ticket from redeeming; switch off between mint and redeem → `503`; switch off → `503`; a failing audit write is reported and does not fail the request; no secret appears in the audit file.
- **E2E** `tests/e2e/mobile-console-ticket-lifecycle.test.ts`: on the production init path, the challenge, mint and redeem routes are alive (not 404/503) and a redeemed ticket's token opens `GET /sessions`.
- **Migration** in the PostUpdateMigrator test: the sentence is replaced once, new and migrated text are identical, a second run changes nothing.
- **App unit** `apps/instar-ios/Tests/InstarAppTests/ConsoleSignInTests.swift` (listed in `project.yml`): the plan table; the presence message bytes; the mint and challenge answer parsers; the injection script's origin guard (scheme, host and port) and JSON escaping; the purge decision (skipped when a token agent shares the domain).

## Maturation plan

- **test-agent-live:** the integration and E2E tests on a real server boot.
- **user-role live proof (before the operator is asked to try it):** on a throwaway agent served over HTTPS (a loopback TLS front), a script acting as the phone (a P-256 device key and presence key, paired through the real word-code flow, signing exactly as the app does) enrolls, mints, and a real browser (Playwright) opens the real console page with that ticket in session storage and must land signed in with no PIN box; then with a used ticket, an expired ticket, a revoked phone and an MSP phone, each of which must show the PIN box. The app is built and run in the iOS simulator against that agent, opening the console through the ticket path. The simulator runs the same code: as `DeviceKey` already does, the key-creation attributes omit the Secure Enclave token only under `targetEnvironment(simulator)`, so the presence key is a keychain software key there with the same `.userPresence` access control (the simulator's own authentication prompt). Context reuse without a second prompt, an invalidated context, and passcode removal need the Secure Enclave and are first exercised on a physical phone, the operator's own (no test device exists); every one of those paths fails safe to the PIN box, today's behaviour, and the dev-agent-live step below checks the no-prompt case explicitly. The scenario matrix is recorded in the PR.
- **dev-agent-live:** the operator opens the console from the app on an owner phone for a development agent and it opens signed in without the PIN and without a second Face ID prompt; the audit file shows `presence-key-set`, the mint and the redeem. A skipped purge is logged by the app and counted in the graduation signal.
- **fleet:** rides `mobilePairing.enabled` with its own switch (§3.7, default on). Servers without the routes answer the app with `403 device-not-allowed`, and the app falls back to the PIN box.
- **graduation criterion:** (a signal, not a gate) one week of console opens from the app on an owner phone with no PIN prompt, and no `refused` audit rows other than expected expiries and Host mismatches after lease moves.
- **dark-window:** none; the feature ships live wherever mobile pairing is on (a user-facing fix ships live). If no owner-phone console open has redeemed a ticket within 30 days of the server release and a matching app build, the reason and a new date are recorded on CMT-1293.

## Open questions
*(none)*

## Frontloaded Decisions
1. **Ticket and challenge lifetime 60 s, single use, 4 per device and 64 total.** The app redeems within seconds; anything longer widens exposure.
2. **The redeem returns only the API token**, never the operator session: strictly within a PIN unlock, and per-action PIN confirmation stays.
3. **Owner phones only.** MSP phones keep the PIN box.
4. **No attempt lockout on redeem**, only a throughput limit on the unknown-ticket path (10/min per address, 120/min total). A 256-bit secret is not guessable; a lockout, or a limit applied before the lookup, would let an attacker block the operator.
5. **The presence key accepts the passcode as well as biometrics** (`.userPresence`), matching iOS's fallback and the app lock.
6. **The device-bound console session is not built here.** It would mean a second console session mechanism accepted by the bearer gate, the WebSocket, the job-events stream and about 14 inline token comparisons, against the brief's direction to reuse the PIN unlock's session. Recorded as feedback `fb-d588d77a-cf8`.
7. **Device-key agents' web view becomes non-persistent**, honouring `mobile-device-keys.md`. On an older server without the routes, the PIN is asked each time the console opens instead of once; accepted, because the old behaviour kept the API token on disk past revocation.
8. **Approval source:** the operator's request in topic 134088 (2026-11-03 21:48 PST). The design grants nothing beyond what a PIN unlock gives the same operator.

## Rollback

Revert the server PR: the routes disappear, an app with the ticket path gets `403 device-not-allowed` from enrollment and mint alike and shows the PIN box. Tickets and challenges are memory-only and expire in 60 s. Stored presence keys are an unused field on device records. The audit file is inert. The CLAUDE.md sentence would then overstate the console sign-in until a later update rewrites it; the revert restores the old section text for new installs only. The app is shipped separately: an app build already on phones keeps the non-persistent web view and the purge (what the device-keys spec already required), so device-key users type the PIN on every console open until a server with the routes or a new app build is in place. A newer server with an older app changes nothing for that app: it still persists a typed PIN's token on disk, which only an app update can remove.
