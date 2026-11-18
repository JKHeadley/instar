---
title: "The Instar Mac app creates the agent and becomes its first trusted device"
slug: "mac-app-creates-agent"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mac-app-creates-agent.eli16.md"
status: "approved"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched, and no standard governs device approval). The feature was approved by Justin: topic 141385, 2026-11-16 13:12 PST, 'Excellent this is perfect I approve' for the easy-setup brief whose first build is the Mac app installing the agent."
review-convergence: "2026-11-16T21:51:43.444Z"
review-iterations: 4
review-completed-at: "2026-11-16T21:51:43.444Z"
review-report: "docs/specs/reports/mac-app-creates-agent-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# The Instar Mac app creates the agent and becomes its first trusted device

## Problem statement

Justin approved "easy setup for new people" on 2026-11-16 at 13:12 PST (topic 141385): a non-technical colleague goes from "download the Instar app" to a working agent with no terminal, no config fields, no required paid service and no Telegram. The approved brainstorm (document 675c5da4, version 2) puts "the Mac app installs the agent" first and "the app is the agent's first trusted device and first chat" second.

Today:

- The installer (`src/commands/install.ts`, `instar install`) is resumable and can be driven by another program: `--answers <file>`, `--yes`, `--resume`, and a ledger at `~/.instar/state/install-progress.json` with `status`, `cursor`, `awaiting` and `failure` (`src/commands/install/progress.ts`).
- It needs Node 20.12+ to run at all, and it stops and asks the person to install Node, tmux (Homebrew on a Mac) and git.
- Its last step (`owner-slot`) only helps a person at a terminal. With no terminal it returns `awaiting-person` with "run instar install --resume in your own terminal". With a terminal it prints a dashboard address, a PIN and a phone pairing link, and pairing that link needs a reachable https address with no port (Tailscale) plus a code read from a PIN-locked page.
- The Instar Mac app (`apps/instar-ios`, target `InstarMac`, branch `echo/mac-app-m1`) only connects to an existing agent. It is sandboxed in every build, including the Developer ID download (`InstarMac/InstarMac.entitlements`), so it cannot run the installer, write to `~/.instar`, or start tmux.
- There is no way to enroll an app device with the agent's own token. Redeem refuses plain `http://127.0.0.1:<port>` (local TLS required, `src/server/mobilePairingRoutes.ts:1252-1258`), and `normalizeRequestHost` refuses a host with any port other than 443 (`src/core/MobileOwnNames.ts:49`). Only browser devices have a loopback exception (`mobileBrowserDevices.ts:110-115`, `mobilePairingRoutes.ts:2821-2824`).

## Goal

On a Mac with nothing installed: open the downloaded Instar app → **Create my agent** → name → which AI account → browser sign-in → a few minutes of plain progress → the window becomes a chat with the new agent. The app is the agent's owner device, with no PIN, code, phone, Tailscale or Telegram. Target about 12 clicks and one sign-in.

## Design

### A. Instar: first owner device from the same Mac (`POST /mobile/local-owner-device`)

A new route in the mobile pairing router, mounted before the bearer check (like redeem). Its credential is a one-time **local ticket**, not the bearer: the app may not be able to read the bearer (it can move to the encrypted store), and the ticket proves more.

**The local ticket.** `writeLocalOwnerTicket(stateDir)` writes `<agentDir>/.instar/state/local-owner-ticket.json` = `{ ticket, expiresAt, failures: 0 }`: 32 random bytes base64url, expiry 30 minutes, written as a 0600 temporary file and renamed into place. Only the installer's `owner-slot` step writes it (§B); a `--resume` writes a fresh one over the old. Reading it proves the caller runs as the user who owns this agent's files, which is the real authority over the agent. The ticket file is 0600 from the moment it exists, independent of when the config is restricted.

**Request:** JSON `{ ticket, publicKey, timeMs, proof, label }`. `publicKey` is the app's P-256 public key in the encoding redeem accepts. `proof` is a strict low-S DER signature by that key over `instar-local-owner-v1\n<host>\n<publicKey>\n<sha256(ticket) hex>\n<timeMs>`, checked with the existing `verifyP256`; `timeMs` within 60 s of the server clock.

**Checks, in this order.** Each refusal changes nothing except where stated:

1. **Switches:** pairing on (`svc.enabled()`) and `mobilePairing.localOwnerDevice.enabled !== false`. Off ⇒ 404.
2. **Same Mac, before anything touches the ticket:** `isLoopbackPeer(req.socket.remoteAddress)`, `!hasForwardingHeaders(req.headers)` (the existing helper and prefix list, shared with browser devices), and the raw `Host` exactly `127.0.0.1:<own port>` (one spelling, so a retry always names the same host) ⇒ else 404, the same answer as no route, so nobody off this Mac can tell whether a ticket exists or spend its failures. This blocks a tunnel or Tailscale Serve, and the Host check blocks DNS rebinding from a web page. An `ssh -L` forward arrives as loopback with no headers, but it still needs the ticket, which only a local process running as the owner can read.
3. **Ledger present** (`ledger-unavailable` 503; asked only after step 2, so nothing off this Mac learns it). **Rate limit:** at most 5 calls per 10 minutes that passed step 2, counted in memory per server process (a restart resets it; each wrong guess also spends a ticket failure, so this only bounds work) ⇒ `rate-limited` 429.
4. **Ticket file:** none, unreadable, or expired ⇒ 404 (an expired file is deleted on this read). So the route does not exist on any agent the app did not just install, including every existing fleet agent.
5. **Ticket compare** (constant time over SHA-256 of both values): wrong ⇒ `bad-ticket` 403 and `failures + 1` written back; the third failure deletes the file.
6. **Proof** valid ⇒ else `proof-invalid` 400.
7. **Retry of the same enrollment:** a key with a revocation row in the device-key ledger (`keyLedger.isRevoked`) is refused first with `device-revoked` 409, whatever the registry says. Then: (a) if this registry holds an `active` record with `localBinding` and exactly this `publicKey`, answer 200 with its `{ deviceId, host, agentName }`. (b) If the registry has no record with this key but the device-key ledger has an activation row for it with `approvedVia: 'local-install'`, this machine's loopback host, a `machineId` (ledger signer) equal to this machine's ledger signer id, and no revocation row (a crash after the ledger row, before the registry write), write the registry record through `createActiveLocalOwner` (same device id from the row, `label` from this request, `localBinding.machineId` from `svc.deps.selfMachineId ?? null`), which keeps its first-owner refusal, and answer 200. Either way the ticket is deleted. A revoked record with this key, or a key whose ledger row was revoked, ⇒ `device-revoked` 409; the app then makes a new device key (a new agent id in its own list) and tries once more, which succeeds only if no other active owner exists.
8. **First owner only:** if any record is `active` and counts as owner (`role` absent or `'owner'`; phones, browsers and computers alike) ⇒ `owner-device-exists` 409 and the ticket is deleted. After the first owner device, every new device pairs the normal way with approval.
9. **Duplicate key** anywhere in the registry or ledger ⇒ `duplicate-key` 409.

The phone wrong-code pause (`pairingPaused`) and the pending-phone cap do not apply: this route creates no pending record and takes no typed code.

**Enroll** (one synchronous step, no await until the registry is written). There is no pending state, so nothing can expire half-way:

1. Make the device id (`crypto.randomUUID()`) and `at`.
2. Ledger row first, the durable intent: `keyLedger.recordActivation({ id, publicKey, host }, 'local-install', at)`.
3. One registry write with a new method `DeviceRegistry.createActiveLocalOwner({ id, publicKey, host, label, machineId: svc.deps.selfMachineId ?? null, approvedAt: at })`, which writes the whole record in a single read-modify-write: `status: 'active'`, `deviceKind: 'computer'`, `deviceName`/`label` from `label`, `fingerprint`, `host`, `approvedVia: 'local-install'`, `approvedAt`, `localBinding: { machineId }`, and no `role` (absent means owner, the existing shape). It refuses inside the same write if the key is now held or an active owner now exists (the race with a concurrent call), returning a reason the route maps to 409; on that refusal the route appends a ledger revocation row for the orphan activation from step 2, so it can never be rebuilt later. It reads the registry strictly (as `listStrict` does): only a missing file means empty; a file that exists but cannot be read or parsed makes the method throw before any write, and the route answers 503 `registry-unreadable`, so a damaged registry can never be read as "no owner" and overwritten. Step 7(b)'s rebuild uses the same strict method. Steps 7 to 9 read the registry strictly too.

`'local-install'` is added to `ApprovedVia`. Existing readers already handle it: the only wording map (`APPROVED_HOW`, browsers only) has a fallback, and document access treats a non-browser device by its role. The ledger row keeps today's phone shape (no new `client` value), so peers on older versions read it as valid. Only this route writes `localBinding`; redeem and every other writer never set it. On success the ticket file is deleted and the route answers 200 `{ deviceId, host, agentName }`. If the registry write fails after the ledger row, the route answers 503 and the ticket stays; the retry is handled by step 7(b).

**Fresh ticket for a finished install.** `instar install --app-ticket` reads the install ledger; when its `status` is `complete` and it has `appEnroll`, it writes a fresh ticket into that agent's folder and exits 0 (otherwise it exits non-zero with a plain reason). It takes the app's public key (`--app-ticket --key <publicKey>`) and refuses when that agent's ledger holds a non-revoked `local-install` activation row for a different key (another app already enrolled). A lost success, where the row is for this same key, still gets a ticket, and the retry ends at step 7(a). It changes nothing else. The app runs it whenever the route answers 404 (no or expired ticket) or the response was lost, then retries with the same key. A lost success therefore ends at step 7(a).

**Why this is not a new way around approval.** The principal is proven by the ticket: only a process that can read the agent's own 0600 files gets it, and such a process can already rewrite `.instar/state/mobile-devices.json` and the config directly. So a ticket-gated, same-Mac, first-owner-only route grants nothing that principal lacks; it replaces a hidden file edit with a checked, recorded path. It changes no trust or autonomy level, so trust journey stage 0 ("widening trust or autonomy needs the person", PR 3222) is unaffected: the device is the person's, created by the person clicking Create on this Mac.

**Signed requests from a `localBinding` device.** In `deviceAuthenticator`, a record with `localBinding` takes its own branch BEFORE the browser and `ownNames` branches, in both multi-route modes. It is accepted only when `isLoopbackHost(d.host)`, `isLoopbackPeer`, `!hasForwardingHeaders`, the raw `Host` equals `d.host` exactly, and, when both `d.localBinding.machineId` and this server's `selfMachineId` are non-null, they are equal. Any failure is `device-unauthorized` 401; it never falls through to another branch, so with multi-route off the stored host is never used without these checks. The signature format, time window, replay check and `DEVICE_ALLOWLIST` are unchanged. The private key lives in the Secure Enclave and cannot be exported. Document-page signatures (`documentPageRoutes.ts`) apply the same rule: a `localBinding` device counts only its own loopback host, from loopback. A `localBinding` device never gets a notification read token (push registration refuses it with `not-for-local-devices`), so the token branch, which runs before the host branches, can never admit it.

**Body size.** The route gets its own 4 KB JSON parser, mounted like redeem's, ahead of the global parser.

### B. Instar: the installer leaves the ticket for the app

- New answers-file field `forApp` (boolean, checked by `answersFileProblem` like `autostart`) and CLI flag `--for-app`, carried into the ledger's answers so a `--resume` keeps it.
- In `owner-slot`, when not interactive AND `forApp`: restrict the config file as today, write the local ticket (§A), record `appEnroll: { agentDir, port }` in the ledger, and return `done`. The ledger still holds no token, link, PIN or ticket; a folder and a port are not secrets.
- Without `forApp`, `owner-slot` behaves exactly as today.

The installer does not call the route: the app's key never leaves the app, so only the app can sign the proof. Enrollment is the app's step after the install completes (§C).

### C. The Mac app runs the install

**Distribution.** The Developer ID download build drops the app sandbox: a new `Direct` build configuration (a copy of Release) uses `InstarMac/InstarMacDirect.entitlements`, and `scripts/ship-mac.sh` archives with `-configuration Direct`. Debug uses the same entitlements so the flow can be tested. Release (TestFlight / App Store) keeps the sandboxed `InstarMac.entitlements`. It keeps network client and the keychain access group. The data-protection keychain and Secure Enclave key keep working; they need a signing identity and profile, not the sandbox. A sandboxed build (TestFlight/App Store) shows "Create my agent" as a link to the download page instead of the flow. `ProcessInfo` tells the app which it is: it is sandboxed when `APP_SANDBOX_CONTAINER_ID` is set.

**Tools.** Everything goes under `~/.instar/runtime/` (owned by the person, no admin password):

| Tool | Source | Check |
|---|---|---|
| Node | official `node-v<pinned>-darwin-<arch>.tar.gz` from nodejs.org | SHA-256 pinned in the app per arch; refuse on mismatch |
| tmux | universal binary built from source and shipped inside the app (`Contents/Resources/bin/tmux`, about 1 MB) | code-signed with the app |
| git | Apple's command line tools: if `xcode-select -p` fails, run `xcode-select --install` and show "Your Mac is adding developer tools. Click Install in the window that opened." Poll every 10 s, stopping after 30 minutes with a **Check again** button | `git --version` |
| Instar | `npm install --prefix ~/.instar/runtime/instar instar@<version>` with the downloaded Node | `instar --version` |

Every download states its size before it starts ("About 50 MB"). A pinned Node version is bumped with each app build.

Exact paths: Node at `~/.instar/runtime/node/` (the tarball's contents, `bin/node`, `bin/npm`); tmux copied from the app bundle to `~/.instar/runtime/bin/tmux` (replaced when its SHA-256 differs from the bundled copy); Instar at `~/.instar/runtime/instar/node_modules/instar/`, run as `~/.instar/runtime/node/bin/node ~/.instar/runtime/instar/node_modules/instar/dist/cli.js`. Before starting the installer the app runs `tmux -V`, `node -v` and `git --version` with exactly the PATH below and stops with a plain message if any fails.

**Running the installer.** The app writes an answers file (0600, removed afterwards) with `name`, `purpose`, `door` (`claude-code` or `codex-cli`), `autostart: true` and `forApp: true`, then runs the installer by its absolute path with `install --answers <file> --yes` and `PATH=~/.instar/runtime/bin:~/.instar/runtime/node/bin:/usr/bin:/bin:/usr/sbin:/sbin`. The agent's start-on-login job keeps the PATH the installer ran with (`installMacOSLaunchAgent` writes `process.env.PATH`), so tmux and Node are found after a reboot.

The app reads the ledger every second while the installer process runs (it stops reading when the process exits) and maps `cursor` to one plain line each ("Getting your AI tool ready", "Waiting for you to sign in", "Creating Scout", "Starting Scout", "Setting Scout to start when your Mac does", "Connecting this app"). On `awaiting-person` at the sign-in step the browser window is already open (the installer starts the sign-in detached); the app shows "Finish signing in in your browser" and runs `instar install --resume` every 5 s for the first 2 minutes, then every 15 s, and stops after 20 minutes with "Still waiting for you to sign in" and a **Check again** button. Only one installer process runs at a time. On `failed` it shows `failure.message` and a **Try again** button that runs `--resume`; `failure.nextStep` goes behind "Details". It never shows a terminal command as the only way forward. Quitting the app at any point is safe. The app saves the person's answers and the new agent's id (which names its device key) before the first download, so the welcome screen then offers **Continue setting up your agent**. Continue re-runs the setup from the top, and every step checks before it acts: Node is unpacked into `~/.instar/runtime/node.staging` and moved into place only after its fingerprint and `node -v` check pass, so a half-unpacked copy is never used; tmux is replaced only when its fingerprint differs; Instar counts as installed only when the marker `~/.instar/runtime/instar/.installed` exists, which the app writes after `npm install` exited 0 AND `node cli.js --version` printed a version; without the marker npm is simply run again; and the installer's own ledger covers everything after that. Only one setup runs at a time: the app holds `~/.instar/runtime/.app-setup.lock` for the whole flow, recording its own pid and the pid of the program it is running at that moment (Node's tar, npm, or the installer). A second copy of the app that finds a live app pid says "Setup is already running in another Instar window" instead of starting. When the app pid is dead but the recorded child is still alive (the app was force-quit), the new copy stops that child (SIGTERM, then SIGKILL after 10 s) and waits for it to exit before it starts; the installer additionally refuses to run twice through its own lock. On a normal quit the app stops its running child the same way.

**Becoming the first device.** Before the install starts the app makes its device key with the existing Secure Enclave helper and saves the key reference with the install (so **Continue** reuses the same key and never makes a new one). On `complete` it reads `appEnroll` from the ledger, reads the ticket file, signs the proof, and calls `POST http://127.0.0.1:<port>/mobile/local-owner-device` (retrying while the server answers connection-refused, up to 2 minutes, then **Try again**). On 404, a 503, or a lost response it runs `install --app-ticket --key <its public key>` and retries with the same key (up to 3 times, 5 s apart, then **Try again**). On 429 it waits 2 minutes before the next try and says "Waiting a moment before trying again". The port comes from the agent's own `.instar/config.json`, read at enrollment time, not from the ledger. On 200 it saves the agent (origin `http://127.0.0.1:<port>`, device id, device host `127.0.0.1:<port>` exactly, key reference) in its agent list and opens the agent's conversation. On `owner-device-exists` it says "This agent already has an owner device. Pair this Mac from that device." and opens the existing pairing screen. A local agent is pinned to its loopback origin: the app does not use `GET /mobile/routes` route switching for it, since other routes refuse a local device. Plain-http loopback is allowed by `NSAllowsLocalNetworking` in a new `InstarMac/Info.plist` merged with the Mac target's generated one (project.yml `INFOPLIST_FILE`); it has no effect on other addresses.

**First hello.** Once the conversation opens, the app sends the agent the fixed opening `[setup:first-hello]`; the agent answers with its hello and the short questions from the approved brainstorm. That greeting text and the first useful result are the separate spec for build step 3; this spec stops at an open, working conversation.

## Decision points touched

| Decision point | Classification | Why |
|---|---|---|
| `POST /mobile/local-owner-device` accept/refuse | invariant | Basis: irreversible-consequence; evidence: a wrong accept creates an owner device with full access to the person's agent, which no later judgment can undo before it is used. Each condition (same-Mac peer and Host, local ticket, key-possession proof, no active owner, rate limit) is a fact about the request, the ticket file or the registry, with no competing signals to weigh; a judgment layer here would only soften an authentication boundary. |
| `localBinding` signed-request branch in `deviceAuthenticator` | invariant | Basis: external-constraint; evidence: the existing device-signature contract (`MobileDeviceKeys.ts` canonical string, `loopbackBindingOk` for browsers) already decides authentication by exact peer, header and Host facts; this branch applies the same contract to one more record kind. |
| Installer `owner-slot` path choice (`forApp` set or not) | invariant | Basis: enumerable-domain; evidence: the input is a boolean in the answers file or ledger (`forApp` true or absent), so there are exactly two paths and nothing to judge. |

## Open questions

*(none)*

## Acceptance

1. Unit: the route answers 404 to a request that is not from this Mac (non-loopback peer, a forwarding header, wrong Host) before reading the ticket, and to a local request with no ticket file, with an expired one (and deletes it), and with the kill switch off; it refuses each failing check (wrong ticket, three wrong tickets delete the file, non-loopback peer, a forwarding header, wrong Host or port, a bad or stale proof, an active owner phone with no `role` field, an active owner browser, a duplicate key, rate limit) and succeeds on the happy path; the record has no `role`, `deviceKind: 'computer'`, `localBinding`, the exact loopback host, `approvedVia: 'local-install'`, a ledger activation row, and the ticket file is gone. A second call with the same key and a fresh ticket answers 200 with the same device id; with only the ledger row present (registry write lost), the retry writes the record from the row; a fresh `DeviceRegistry` instance reads back `localBinding`; a corrupt or unreadable registry file gives 503 and is left byte-for-byte unchanged; an active local record whose key has a ledger revocation row gives `device-revoked`; two concurrent calls with different keys produce exactly one owner. `install --app-ticket` writes a fresh ticket only for a completed `forApp` install.
2. Unit: `deviceAuthenticator` accepts a `localBinding` record only from a loopback peer, with no forwarding headers, the exact Host, and (when both are set) the same machine id, in both multi-route modes; with multi-route off a request through a forwarding header is refused (not checked against the stored host); a phone record with a loopback host and no `localBinding` is unchanged by this work.
3. Unit: `owner-slot` with `forApp` writes the 0600 ticket and `appEnroll` and never writes a token, link, PIN or ticket to the ledger; without `forApp`, its output and ledger are byte-for-byte as before.
4. Integration: the real server; enroll via the route; a request signed by that key to an allowlisted route returns 200 over loopback and 401 when the same request carries `X-Forwarded-For`.
5. E2E: production init path; the route is mounted (not 404/503).
6. Live: on a clean macOS user account on the Studio (no Node, no Homebrew, no tmux in PATH), the signed Developer ID app creates an agent with a real Claude sign-in, the window becomes the conversation, a message gets an answer, and after logging out and in the agent is running and the app still reaches it. Clicks and minutes recorded. Screenshots of every step.

## Rollback

The route is dark on every existing agent by construction: it answers 404 unless a fresh ticket file exists, and only the app-driven installer (`owner-slot` with `forApp`, or `--app-ticket` for that same completed install, which refuses once a different key has enrolled) writes one. A kill switch `mobilePairing.localOwnerDevice.enabled: false` makes the route 404 even with a ticket, which stops new enrollments only. Already-enrolled local devices keep working, because cutting them off would leave that person with no chat; a single device is removed the normal way (dashboard device list, revoke), and the person can still reach the agent's dashboard on this Mac with the PIN, which the agent tells them on request. The app side is a new flow; the existing pairing screens are unchanged.

A code revert is different from the kill switch: the reverted authenticator no longer knows `localBinding`, and with multi-route off it would check such a device's signature against its stored host from any peer. So a revert is always paired with revoking the enrolled local devices (dashboard device list); the kill switch is the preferred back-out.



## Maturation plan

- **test-agent-live:** a throwaway macOS user account on the Studio with no Node, Homebrew or tmux on its PATH; the signed Debug (unsandboxed) Mac app built from `echo/mac-create-agent`; Instar from a local build of this branch (`INSTAR_PACKAGE` pointed at the packed tarball). Acceptance 6 passes there: Create my agent through to an answered message, then log out and in and the app still reaches the agent. Target 2026-11-17, owner echo.
- **dev-agent-live:** the Direct (Developer ID, notarized) build, installed from its download zip on the Studio's own account, creates a second test agent with Justin's Claude sign-in only if he offers it, otherwise with a test account; the release carrying the server half is the one npm serves. Target 2026-11-18, owner echo.
- **fleet:** the next release after dev-agent-live. Owner echo, review due 2026-11-25. Existing agents are unaffected by construction: the route answers 404 without a ticket, and only an app-driven install writes one.
- **graduation criterion:** two clean app-driven creations (test-agent-live and dev-agent-live) with no terminal step, no refusal except the expected ones in the unit tests, and the agent still reachable from the app after a logout/login.
- **dark-window:** none: the route has no effect on any agent the app did not just create; the kill switch `mobilePairing.localOwnerDevice.enabled: false` exists for an incident.
- **ladder:** not applicable: no staged rollout of its own, it rides the release train and a revert undoes the server half

## Multi-machine

A local device is machine-local by design. Its record lives in `mobile-devices.json`, which stays on the machine that wrote it; only the device-key ledger replicates, and a ledger row alone authenticates nothing on another machine (signed requests look the record up in the local registry). The `localBinding.machineId` check adds a second guard once the agent has a mesh identity. If the agent later adds machines, the app on this Mac keeps working while the agent answers here, and other devices pair normally. Revoking the device writes a ledger revocation row, which replicates as for any device.

## Out of this spec

The first-hello text and first useful result (build step 3, its own spec), phone joining by scanning the Mac (already `mac-qr-pairing`), and Windows hosts. <!-- tracked: topic 143810 autonomous run tasks 3 and 6 -->
