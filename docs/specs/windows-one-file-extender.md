---
title: "One file on a Windows PC extends the agent to that PC"
slug: windows-one-file-extender
author: echo
status: draft
parent-principle: "The Person Decides; the Agent Does the Rest"
eli16-overview: windows-one-file-extender.eli16.md
---

# One file on a Windows PC extends the agent to that PC

## Problem statement

Justin, topic 144319, message 4609198818115544, 2026-11-18 13:57 PST: "I really really really like the idea of a single file that can be run on a Windows machine that gives an agent access", the ideal way "to extend an agent to a machine, other than using the official In[star app]". The Chief of Staff put it on the easy-setup project (topic 143810) the same day with five requirements: one signed file; pairing approved from the owner's app; nothing stored that a stolen file could reuse; a remover; and a full-wipe test on Justin's third machine when it is available.

Today a person who wants their agent to use a Windows PC has no path unless an Instar agent already runs inside WSL on that PC:

- The Remote Desktop companion (`scripts/install-windows-desktop-companion.ps1`, `src/native/remote-desktop/windows/InstarDesktopCompanion.cs`) is compiled on the PC by PowerShell and listens on loopback/WSL only; it serves an agent on the same PC.
- `instar pair` / `instar join` adds a whole mesh machine. It needs a terminal, Node and the instar package, and the typed code alone authenticates the join; the owner's phone is never asked (`src/commands/machine.ts:466-469`).
- The Windows-app lane's test zip (`.instar/lanes/windows-app/instar-test-pc-setup.zip`) is four files, needs an administrator, installs Tailscale and the SSH server, and adds one hardcoded public key.
- No Windows code signing or packaged `.exe` exists anywhere in the repo.
- Email cannot carry an attachment (`src/email/transports.ts:66`), so the file reaches a PC by a link.

What this spec builds is **not** another owner device. The Mac QR pairing (`docs/specs/mac-qr-pairing.md`) makes a paired computer an *owner device*: `role: 'owner'`, full access, able to mint codes and approve other devices (`src/server/mobilePairingRoutes.ts:1312-1316`). A Windows PC that the agent drives is the opposite direction: a machine the agent controls, which must hold **no** authority over the agent. Reusing the Mac pairing unchanged would let the agent, which runs commands as the PC's user and can therefore sign with the PC's key, act as an owner device on its own server. This spec defines a separate, restricted device class for that reason.

## Proposed design

The design rests on two choices made after three review rounds:

1. **The PC is a restricted `extender` device, not an owner device.** It can be driven by the agent and has no power over the agent.
2. **Each PC is bound to one agent machine: the machine that paired it (its *home machine*).** The PC connects only to that machine, pins only that machine's key, and is redeemed, held, lowered and removed there. Sessions on the agent's other machines reach the PC by asking the home machine. This removes every cross-machine race of draft 3 (holder handover, stale holders, redemption on the wrong machine, revocation lag between machines). The reason is the PC's trust, not convenience: the PC must check every frame against keys the agent cannot add to on its own, and a single pinned machine key plus the owner's phone key is the smallest such set. Availability is kept by an owner-approved **move**: when the home machine is off or retired, one Face ID tap in the app moves the PC to another of the agent's machines, with no re-pairing (see Moving a PC).

This outbound-socket, one-server-per-endpoint shape is the standard remote-management agent pattern (MeshCentral's agent, Intune's management extension); what this spec adds is the owner's phone as the only door in, and an endpoint that holds no authority over its server.

### The person's journey

1. The person tells the agent they want it to use their Windows PC, or the agent offers. The agent replies in the conversation with a link to the download and says in one line what will happen.
2. On the PC the person opens the link. It downloads `Instar-Connect.exe` for the PC's architecture (x64 or Arm64, from the browser's report; x64 when unknown). The same file serves every agent and person; it holds no secret and no agent address.
3. Double-click. Nothing asks for administrator rights.
4. The window says, in plain words: "This lets an Instar agent use this PC as you." Two choices, neither pre-selected: **"Full control"** (the agent can do anything you can do on this PC) or **"Look only"** (the agent can see the screen and read files, and change nothing). It then shows a QR code.
5. On the phone: Instar app, "+", **"Connect a Windows PC"**, scan, pick the agent.
6. On the PC, the window shows the agent's name, its owner's name, the home machine's address and a short key fingerprint, with the warning: **"Only connect your own agent, from your own phone. No support person, bank or company will ever ask you to do this. If someone on a call or chat asked you to, press Cancel."** Connect becomes active after a short wait (default 8 seconds). If a known remote-control program (Quick Assist, AnyDesk, TeamViewer and similar, from a list shipped with the program) is running, the warning is stronger ("A remote-control program is running. If someone else is controlling this PC, press Cancel"), the wait is longer (default 30 seconds), and the phone approval in step 7 shows the same line. It is a warning, not a block: the person decides.
7. On Connect, the phone shows: "<agent> will be able to <run programs and use files | see the screen and read files> on <PC name> as you", and the person approves with Face ID. The PC closes to a tray icon. The agent says in the conversation: "I can now use <PC name>."

Actions for the person: open a link, run the file, pick a choice, scan, Connect, approve on the phone. No account, no admin, no settings.

### Device class: `extender` (no authority over the agent)

- A separate class, `extender`, set **by the server at mint**, never claimed by the device. The phone's "Connect a Windows PC" action mints a code whose `CodeEntry` carries a new field `deviceClass: 'extender'` (the existing `boundKey` carries the PC key `d`); `PairingPerson.role` is not widened. `deviceKind`, which is client-claimed display text, plays no part.
- Extenders are **never written to the per-machine `DeviceRegistry`**, whose roles existing checks treat as owner-like when not `team` (`src/server/mobilePairingRoutes.ts:615-650`). The existing device middleware therefore never recognises an extender key; `/computers/link` authenticates only against the extender store. A deny-by-default unit test walks every mounted route and asserts an extender-signed request is refused everywhere else.
- Approval uses a new extender-only route, `POST /mobile/extenders/:id/approve`, which accepts only a presence-signed approval (Face ID) from the owner's paired phone. Older app builds never call it; the generic approve routes, the Telegram code and button, and the dashboard refuse extender requests.
- **The Instar app is required to connect a PC (security floor).** Admission gives the agent command over a person's computer, so it needs a human-presence approval the agent itself cannot produce (an operator session or a Telegram button proves the conversation, not a person at a phone). The only such approval Instar has today is the app's presence signature; a dashboard passkey (WebAuthn) approval would meet the same need but does not exist yet and needs its own security spec, so it is not added here. An owner without the app is told so and offered the app pairing first. This is an exception to "neither the app nor the dashboard is required" and is named as such in the approval ask.

### Stores

- `computerExtenders`: a new append-only replicated kind, never pruned: extender records, mode changes, home-key rotations, revocations. Rows are written by the PC's home machine (a move row by the new home, carrying the phone's signature; a pending-revocation request by any machine), signed with the writer's machine key, and accepted only under that machine's pinned identity key (the `mobileDeviceKeyLedger` rule). Machines on older builds never read the new kind, so they can never mistake an extender for an owner device. It gets its `state-coherence-registry.json` entry, a reconciler registration (added to `RECONCILER_ALLOWLIST`), and backup inclusion.
- `computerAudit`: a separate replicated kind for call metadata (see Audit), archived by age.

### Pairing hand-off (reuses the Mac sealed drop)

- The PC generates its device key: P-256 in Windows CNG under the person's profile, non-exportable, TPM-backed (Microsoft Platform Crypto Provider) when present, the software provider otherwise. Honest limit: a non-exportable key still signs for any process running as that Windows user, and malware running as that user can extract the software provider's key. That matches the person's own privilege; the extender class is what keeps such use from reaching the agent's owner powers.
- The QR uses the Mac flow's carriage (`mac-qr-pairing.md` §2-§6) in a new type `instar.sh/pair-pc` v1 carrying the drop slot `r`, the one-time seal key `k`, the device public key `d`, the PC name `n` (clipped to 40 characters), and `m`, the mode chosen on the PC. The drop slot is refreshed every 120 s, as on the Mac.
- The phone asks the machine it is talking to for the code. That machine becomes the **home machine** and must have an address the PC can reach (below); if it has none, the phone says so before minting. The phone seals to the drop slot: the home machine's origin, the code, the agent and owner names (clipped to 40 characters), the home machine's public key (Ed25519, 32 bytes) and the phone's presence public key (P-256, 65 bytes). At its largest (a 253-character host) this is about 1,100 base64url characters, under the drop's 2,048-character cap; the phone refuses to seal anything larger rather than truncate.
- The PC opens the drop and shows the Connect confirmation. On Connect it redeems at the home machine, proving possession of `d` and sending the mode signed by `d`; this creates a pending row. The phone then shows that row's mode and the person approves (the Mac order: redeem first, then presence approval). Redemption, approval and the first socket all happen on the same machine, where the code lives.
- **Addresses (v1), all free.** The home machine's Cloudflare tunnel, either a named tunnel or the free quick tunnel every agent can run, or its Tailscale name when the PC already runs Tailscale (the program never installs it). A quick tunnel's address changes when the machine restarts, so the PC also learns addresses from the **address beacon** below. An agent with no tunnel at all is offered its existing quick-tunnel setup, which needs no account or purchase. A same-network address and the hosted relay (`docs/specs/hosted-relay.md`) are later address options, each tracked as its own item on the easy-setup project.
- **Address beacon.** While a PC is not connected, its home machine publishes a small record `{deviceId, origin, issuedAt}` signed by the home key, sealed to the PC's key `d`, to the existing instar.sh drop point (`mac-qr-pairing.md` §5) in a slot named by a hash of `d` and the current 120-second window, re-written each window. The PC, while it cannot reach its last address, reads the current and previous window's slot with backoff, accepts only a record signed by its pinned home key (or a move record, below), and tries that origin. Cost: at most one write per disconnected PC every 2 minutes on the existing Vercel plan, under the drop's existing rate limit. Someone who knows `d` can occupy a slot to delay reconnection by a window; they cannot redirect the PC, because records are signed. When the PC connects, publishing stops.

### The PC checks the agent, not only the reverse

- The PC pins two keys: the home machine's key (for frames) and the owner's phone presence key (for raising the mode and for owner-signed changes).
- At each socket handshake the home machine answers a fresh PC challenge signed with its machine key.
- Every frame from the agent is signed by the home machine's key and carries a sequence number that increases per connection; the PC rejects a bad signature, another key, or a repeated or out-of-order sequence.
- **Home key rotation** (including Machine Identity Recovery) reaches the PC only as a frame signed by the old key and countersigned by the owner's phone presence key; it is written to `computerExtenders`. If the old key is gone (a lost disk), the owner's move record to the same machine's new key (Moving a PC) re-pins it with one Face ID tap.
- **Moving a PC.** In the app, the PC's page offers "Move to <machine>" (shown first when the home machine has not been seen for an hour). With Face ID the phone signs a move record `{deviceId, newHomeKey, newHomeOrigin, moveSeq}` with its presence key. The new home machine writes it to `computerExtenders` and publishes it on the address beacon; the PC accepts it only with a valid signature from the pinned phone key and a higher `moveSeq`, pins the new key, and connects there. From then on the PC refuses the old home key, and the old home machine, on its return, reads the move row and forwards calls instead of holding the PC. The agent cannot move a PC on its own.
- **Owner phone change**: a new phone key reaches the PC only as a frame signed by the old phone's presence key; if the old phone is lost, the owner connects the PC again (the tray's Disconnect and Stop keep working without any phone).
- The device-signed upgrade request uses the existing device-signature scheme with its 60-second window and replay guard (`src/core/MobileDeviceKeys.ts:16-17`).

### What the agent can do (v1)

Two modes, held and enforced by the PC:

| Mode | What the agent can do |
|---|---|
| Full control | Run PowerShell commands as the person (never elevated, inside a Windows Job Object, with a time limit the calling session states, default 2 minutes); list, read, write and delete files the person can reach and stream files both ways; take screenshots; type and click; open the default browser on a page. |
| Look only | Take screenshots; list and read files the person can reach. Nothing that changes the PC. |

Honest capability statement, in the window and the consent text: **"Full control" means the agent can do anything you can do on this PC.** Command running, file writing and typing each amount to that, so they are not offered as separate switches that would suggest a limit they cannot keep. "Look only" is a real limit: the PC has no code path that writes, runs or types in that mode.

- **Typing while you work.** Under Full control, typing and clicking wait until the person has not used the keyboard or mouse recently (default 30 seconds) and never act over a full-screen app. A sub-option, "may type and click while I am using the PC", lifts that. This is courtesy for the person at the PC, not containment.
- **Changing mode.** Lowering (Full control to Look only, or disconnecting) can be done from the tray, from the app, or from the web console; the home machine sends it to the PC as a frame and the PC applies it. Raising (Look only to Full control) needs a frame signed by the owner's phone presence key (Face ID on the phone); the PC verifies that signature itself, so the agent cannot raise its own access. The app's raise works from the phone alone; the tray's "Allow full control" sends the request to the phone for that approval.
- **Protecting the mode from the agent.** The mode is stored with a MAC made with the PC's CNG key; a file that fails the check means Look only. Honest limit: under Full control the agent runs as the person and can sign with that key, so the MAC protects Look only (where the agent cannot run code on the PC) and nothing under Full control. The program also refuses, in every mode, to touch its own state and install folders, the HKCU Run key, the Startup folders and the Task Scheduler folder through its file path, and the input path refuses to act while the program's own window is in front. The consent text says that under Full control, Stop and Remove work only as long as the agent has not changed the PC to prevent them, and that changes the agent made stay after removal (the remover lists the startup entries and scheduled tasks the audit shows the agent created).
- **No elevation in v1.** A command that needs an administrator gets `needs-administrator`; the agent tells the person it cannot do that on this PC yet and never asks them to run it.

### Lasting safeguards against tech-support scams

The most likely abuse is a scammer talking a stranger into connecting the scammer's agent. Beyond the warning at Connect:

- At each Windows sign-in the PC shows a notice for 15 seconds: "Connected to <agent>, owned by <owner>", with a one-click Disconnect.
- Whenever a new agent session starts using the PC, a toast names the agent ("<agent> started using this PC") with Stop; repeated calls from the same session do not repeat it. This is a consent signal on the controlled PC, not a chat notification.
- The tray icon changes while anything runs. **Stop** cancels everything (closes the Job Object, killing every child process) and refuses new calls until the person presses Resume.
- Owner: the easy-setup project; the download page and the window carry the same "no support person will ask" text.

### Agent side

- Route family `/computers` (dark behind `computers.enabled`): `GET /computers`, `POST /computers/:id/exec`, `/files/*`, `/screenshot`, `/input`, `/open-url`, `GET /computers/:id/audit`. A call on a machine that is not the PC's home machine is forwarded over mesh RPC (small control frames) to the home machine, which answers `pc-offline` at once if the PC is not connected, or `home-offline` (from the forwarding machine) if the home machine cannot be reached.
- **Who may call (v1: the owner's own conversations).** Today owner sessions get the full agent bearer token; server-issued per-session tokens exist only for scoped audiences (`SessionManager.issueSessionToken`, `src/core/SessionManager.ts:8491`; `isScopedAudience` excludes the owner). This spec adds a server-issued token kind for **interactive sessions serving the owner's own conversation**, recorded by the server per session id. `/computers` requires that token; the agent bearer token alone is refused. Scheduled jobs and other spawned sessions have no such token and are refused in v1, so a hostile email read by a job cannot become a command on the PC. Residual risk, stated in the consent text: outside content the owner pastes into their own conversation is read by a session that can use the PC. The home machine checks the token's session against the issuing machine's record over mesh RPC before running a forwarded call.
- **Why not team sharing in v1.** A PC belongs to one person, and sharing it needs per-person session audiences bound into `/computers` plus a signed sharing grant per PC; neither exists. Team sharing of a PC is tracked as its own item on the easy-setup project with the Chief of Staff, not promised here.
- **Results and files:** everything from the PC enters the agent's context as untrusted data, never instructions. An inline result defaults to 1 MB and the caller may ask for more; beyond the inline size nothing is cut: the result returns its first part with `overflow: { stream, part: 'head', totalBytes, ticket }` naming the stream (stdout or stderr) and a ticket for the rest. Larger results and all files travel through a ticketed stream relay (the `DesktopMeshStreamRelay` pattern, also used to cross from the home machine to the calling machine) in 256 KB chunks with resume by offset, straight to disk. A file that would leave less free space than the Disk Steward's floor on the receiving machine is refused with `no-space`, naming the size; there is no other per-file cap.
- **Load:** each call has an id and chunks of different calls interleave. One slot is always kept for quick calls (screenshot, input); the home machine admits further calls while the socket's buffered amount stays under the PC's window and the PC's reported load allows, and answers `pc-busy` beyond that.
- **Audit:** each call writes a metadata row in `computerAudit`: when, which session and person asked, what kind, duration, exit code, byte counts, and the command text with credentials redacted; never file contents or output. Repeated screenshots and input merge into counted rows. Old rows move to the agent's backup archive by age under the Disk Steward's space rules, never deleted. The read is paged by a `(time, rowId)` cursor, 100 rows a page.
- **Surfaces:** the web console gets a Devices page backed by `GET /computers` (online state, the home machine, the mode the PC confirmed, audit, Lower, Remove). The iPhone app gets the "Connect a Windows PC" scan path, the extender approval, the raise and the PC's device page; that work is done in this project by the app lane (`echo-instar-desktop-app`) from a contract written into `.instar/vm-test/app-coordination.md` and tracked as a commitment, and its build number is on this project's completion list. Android is not in v1's done line; it is tracked as its own item owned by the Android lane.
- **Awareness:** one entry, `src/data/awareness/windows-pc-extender.md`, shown only when `computers.enabled` is on.
- **Config:** `computers.enabled: false` added to ConfigDefaults so existing agents get it through `migrateConfig`; Echo turns it on with its own config override.

### Connection, liveness and revocation

- The PC opens an outbound WebSocket to its home machine's origin. No listening port on the PC, no firewall change, no SSH. The upgrade uses the server's existing WebSocket manager, compression off, frame cap matched to the 256 KB chunk.
- Heartbeat: a ping every 30 seconds; two missed pongs drop the connection on both ends.
- **Lower and Remove** are applied on the home machine before success is returned: the row is written, the PC's queue is closed for new calls, a Lower or Remove frame is sent, and running calls the new mode forbids are cancelled. Because one machine holds both the socket and the decision, there is no window in which another machine admits a call the owner has refused. Requested from another machine, the request is forwarded to the home machine.
- **Owner orders that do not depend on the home machine.** A Lower or Remove made in the app is also signed by the phone's presence key (the Face ID approval the app already asks for) and published by the phone itself, sealed to `d`, on the address beacon's separate orders slot; the machine that received the request re-publishes it each window until the home machine's confirming row replicates back. The PC reads the orders slot every 60 seconds while connected (as well as on every attempt while disconnected) and applies any valid phone-signed order at once: Lower cancels the calls the new mode forbids, Remove runs the remover. So a home machine that is cut off from the rest of the agent but still reaches the PC cannot keep it working against the owner's order for more than about two minutes, and the tray's Stop works with no network at all. Console Lowers carry only a machine signature and go through the home machine. Cost: one read a minute per connected PC on the existing drop.
- To keep a restarted home machine from re-admitting a revoked PC, the requesting machine writes a `pending-revocation` request row, and the home machine, after any restart, accepts no PC handshake until it has completed one `computerExtenders` sync with the lease holder (or is the lease holder); until then it answers `retry-after`.
- Reconnect: full-jitter backoff from 1 second doubling to a 5-minute ceiling. Refusals carry a kind and a wait:
  - `retry-after`: wait as told.
  - `update-required`: self-update (below), then reconnect.
  - `unknown-device`: keep retrying (the home machine may be restoring from backup).
  - `feature-off`: probe once a day.
  - `device-revoked`: remove only when the answer carries the signed revocation row; otherwise treat as `unknown-device`.
- **Breaker.** After 7 days without a handshake the breaker trips: the tray says "Can't reach <agent>'s <machine>" with Reconnect, Stop trying and Remove, and attempts (socket and beacon) drop to once an hour, 24 small requests a day. The PC never gives up on its own, because a home machine can be away for weeks (an owner travelling) and a PC that stopped would stay silently disconnected; it stops only when the person chooses Stop trying or Remove, or on a signed revocation, which removes it at once. `feature-off` keeps the daily probe.

### Remover

- "Disconnect" in the tray, the Windows Settings > Apps uninstall entry (per-user, HKCU), and an owner Remove all end the same way on the PC: cancel running calls (close the Job Object), tell the home machine it is leaving (best effort), delete the CNG key, delete `%LOCALAPPDATA%\Instar\Connect\`, delete the HKCU Run and uninstall entries, then exit and delete its install folder `%LOCALAPPDATA%\Programs\Instar Connect\` through a one-shot cleanup started at exit.
- An owner Remove writes the signed revocation row first, then sends the frame; a PC that is offline removes itself at its next handshake.

### Updates

- The handshake carries the protocol version and build number; the server answers `update-required` below its minimum. The PC fetches the manifest from the fixed release address `https://github.com/JKHeadley/instar/releases/latest/download/instar-connect-manifest.json` (never a URL the server supplies), downloads the build, and checks: the Authenticode signature chains to the Microsoft root used by Artifact Signing and the leaf certificate carries the publisher's identity-validation OID (under `1.3.6.1.4.1.311.97.`), pinned at build time (not the subject name, which other verified individuals can share); the manifest's detached CMS signature passes the same rule and carries an RFC 3161 timestamp (the signing certificates last about three days); the SHA-256 matches the manifest; and the build is newer than the installed one. Then it replaces itself through the exit-time step. The PC never runs a build that fails any check.

### Building, signing, publishing

- One self-contained .NET 8 single-file executable per architecture (win-x64, win-arm64). The capture and input classes from `InstarDesktopCompanion.cs` are compiled in; its `Main` and `TcpListener` are not, and a Windows test asserts the program opens no listening socket. Ed25519 verification uses a bundled library (the .NET 8 base library has none).
- Signed with Microsoft Artifact Signing under the individual identity **Justin Headley**, the publisher name of the Mac app. This needs an Azure subscription in Justin's name (about US$10 a month) and a one-time identity check with his ID; both are asked of Justin together as one four-part request after this spec is approved and before the first public release. If Microsoft does not enrol an individual in his country, that request names signing under SageMind instead. Unsigned builds are never published.
- Built and signed on a Windows host the agent controls (the Mama PC, with any other reachable Windows machine as fallback). Assets go to GitHub Releases of the instar repo; the download link (instar.sh/pc, the `site/` project) redirects to the right asset.
- **Release gate** (after approval, before the first public link): Defender file analysis; a fresh Windows install downloads and runs the signed build with Defender and SmartScreen on. A Defender detection fails the gate; SmartScreen's first-run warning for a new publisher passes it, and the download page says what the person will see and what to click.

## Maturation plan

- test-agent-live: a throwaway agent with a named-tunnel origin, the fake PC client (Node, same protocol) in unit, integration and E2E tests, then a side-loaded local unsigned build on the Mama PC against the throwaway.
- dev-agent-live: Echo, computers.enabled on by Echo's config override; the same side-loaded build on the Mama PC, connected from Justin's iPhone.
- fleet: default stays off until the graduation criterion is met; then the default changes in a release.
- graduation criterion: the live proof matrix passes on the Mama PC against Echo; the signed build passes the release gate; the full-wipe test passes on Justin's third machine; no operator-found defect in the following two weeks; and the recurring model review of the feature ladder reads it ready.
- ladder: test agent (throwaway), dev agent (Echo), fleet (default on)
- dark-window: from the first merge until the graduation criterion is met; entered in feature-ladders.json with owner easy setup (topic 143810) and a review date per rung.

### Tests

- Unit: an extender-signed request is refused on every mounted route except the handshake (deny-by-default walk); approval refuses every path except the extender-only route with a phone presence signature; `/computers` refuses the agent bearer token, a job's session, a forged header, and accepts an owner interactive-session token; Look only refuses exec, write, input and open-url at the PC; a raise without a valid phone presence signature is refused at the PC; refusal kinds map to the right PC behaviour; overflow returns a ticket; a frame from any key other than the home key is refused; a restarted home machine answers `retry-after` until synced.
- Integration: a fake PC pairs through the real phone-approval routes and the drop point, opens the socket, verifies the challenge, runs each call kind, hits `pc-busy`, streams a file with a resume, receives a forwarded call from a second machine, follows a quick-tunnel address change through the beacon, is moved to a second machine by a phone-signed move record (and refuses the old home key and a machine-signed move afterwards), and is lowered and then removed mid-call (calls are cancelled; it removes itself only on the signed row).
- E2E: the production boot path mounts `/computers`, answers 200 for a paired fake PC, and refuses with `feature-off` when off.
- Windows: pairing state machine, removal leaves nothing behind, reconnect, 7-day notice and parking, idle rule, no listening socket, Job Object cancel, Look only enforced, the sign-in notice and the per-session toast, the remote-control warning.
- Live, through the real surfaces on the Mama PC with the side-loaded build: open the link, run, connect from the iPhone app with Face ID, the agent runs a command and takes a screenshot, the person presses Stop and Resume, the owner lowers to Look only from the app and raises again with Face ID, the owner removes the PC and it cleans itself up. Done for this run is that proof against the throwaway and against Echo. The signed build, the public download link and the SmartScreen/Defender verdicts are the release gate; the full-wipe test on Justin's third machine is the graduation step, tracked as a commitment on the easy-setup project until the machine is available.

## Decision points touched

- Whether a PC may become an extender — invariant; basis: irreversible-consequence; evidence: an extender runs commands as the person, so admission is only the owner's presence-signed approval on the extender-only route for a server-minted extender code; no code alone, Telegram, dashboard or agent path.
- Whether an extender key is accepted on a route — invariant; basis: enumerable-domain; evidence: one accepting route (/computers/link), authenticated only against computerExtenders; every other mounted route refuses, checked by a walk of the route table.
- Whether a call runs on a PC — invariant; basis: enumerable-domain; evidence: two modes held by the PC, each call kind mapped to the modes that allow it, checked at the PC.
- Whether the mode may be raised — invariant; basis: irreversible-consequence; evidence: a raise gives command over the person's computer, so only a frame signed by the pinned owner phone presence key is accepted, verified on the PC.
- Who may call /computers — invariant; basis: irreversible-consequence; evidence: a command on someone's PC cannot be undone, so only a server-issued token for an interactive session serving the owner's own conversation qualifies.
- Whether a PC removes itself — invariant; basis: irreversible-consequence; evidence: removal deletes the key; only a revocation row signed by the pinned home key triggers it.
- Whether a frame is from the agent — invariant; basis: enumerable-domain; evidence: the PC accepts only the pinned home key, with an increasing per-connection sequence.
- Which machine holds a PC — invariant; basis: enumerable-domain; evidence: exactly one, the home machine that minted its code, recorded in its extender row.
- Whether the PC applies an owner order received outside the socket — invariant; basis: irreversible-consequence; evidence: a Lower or Remove that waits on a partitioned home machine leaves the owner's refusal unapplied; only orders signed by the pinned phone key are accepted, and only orders that reduce access.
- Whether a restarted home machine admits a PC — invariant; basis: irreversible-consequence; evidence: admitting a revoked PC would run commands the owner refused; one completed sync with the lease holder first.
- Connect wait on the PC — judgment-candidate; floor: Connect is never instant and the scam warning is always shown; default: 8 seconds, 30 when a remote-control program runs; arbiter: the person, who may Cancel at any time; the length is a starting value reviewed at graduation from live-proof timings.
- Whether a running remote-control program stops pairing — judgment-candidate; floor: the stronger warning shows on the PC and on the phone approval; default: warn and wait longer, never block; arbiter: the owner's presence approval.
- Typing while the person is active — judgment-candidate; floor: never over a full-screen app and never within the person's recent activity unless they lifted it; default: 30 seconds since the last input; arbiter: the person's sub-option.
- How long a command may run — judgment-candidate; floor: Stop and the Job Object always cancel it, and the tray shows it running; default: 2 minutes; arbiter: the calling session states the time it needs.
- How many calls run at once — judgment-candidate; floor: one slot always free for quick calls, buffered bytes never above the PC's window; arbiter: the home machine, from the PC's reported load.
- How much of a result is inline — judgment-candidate; floor: nothing is cut, overflow returns a ticket naming what was not inline; default: 1 MB; arbiter: the calling session.
- Whether a file transfer is refused — judgment-candidate; floor: never leave less than the Disk Steward's free-space floor; arbiter: the Disk Steward on the receiving machine.
- Reconnect timing and the breaker — judgment-candidate; floor: never faster than 1 second with full jitter, never more than one attempt an hour once the breaker has tripped, and the tray always shows the tripped state; default: trip after 7 days without a handshake; arbiter: the server's refusal sets the wait inside the floor, and the person decides in the tray whether to keep trying, stop or remove; the 7-day value is reviewed at graduation from live disconnect data.
- Whether a PC changes its home machine — invariant; basis: irreversible-consequence; evidence: the new home gains command of the PC, so only a move record signed by the pinned owner phone presence key, with a higher move number, is accepted.
- How long audit rows stay online — judgment-candidate; floor: rows are archived, never deleted; arbiter: the Disk Steward's space rules.

## Multi-machine posture

- Extender records, mode changes, home-key rotations, revocations and pending-revocation requests: unified, through the `computerExtenders` replicated kind (written by the home machine, signed by its key; pending-revocation requests by any machine, signed by theirs).
- Audit rows: unified, through `computerAudit`.
- The PC's binding to its home machine: unified as data (every machine sees which machine holds a PC and forwards to it); the live socket terminates on the home machine only, because the PC pins that machine's signing key.
- machine-local-justification: physical-credential-locality — the PC pins the home machine's own signing key, which lives on that machine's disk and is never copied; the live socket can only be answered by the holder of that key.
- Pairing codes: machine-local on the minting (home) machine.
- machine-local-justification: physical-credential-locality — the pairing code is a one-time secret held only as a hash on the machine that minted it, as the converged Mac pairing (docs/specs/mac-qr-pairing.md) declares.
- Address beacon records: on the existing instar.sh drop, transient (one 120-second window each), written by the home machine or, for a move, the new home.
- Calls from sessions on other machines: proxied to the home machine over mesh RPC; results cross through the ticketed stream relay.

## Rollback

- `computers.enabled: false` unmounts `/computers` except the handshake endpoint, which stays to answer `feature-off`. On the switch: new calls are refused, running calls are cancelled, every connected PC gets a `feature-off` frame and its socket closes; PCs keep their pairing and probe once a day.
- A build in the field is retired by raising the minimum build (PCs self-update) or made inert by revocation.

## Frontloaded Decisions

- A separate `extender` class kept out of `DeviceRegistry`, with no authority over the agent.
- Each PC bound to its home machine (the machine that minted its code); the owner moves it to another machine with one Face ID tap when that machine is off or retired.
- Two modes, Full control and Look only, instead of switches that implied limits they could not keep.
- Raise only with the owner's phone presence signature verified on the PC; lower from tray, app or console.
- Callers: interactive owner-conversation sessions only, by a new server-issued token kind; jobs refused; no team sharing yet (tracked).
- Instar app (iPhone) required as a security floor, named as a constitution exception in the approval ask; Android tracked by the Android lane.
- Scam safeguards: warning plus wait at Connect, stronger warning and longer wait (never a block) with a remote-control program running, a sign-in notice and a per-session toast.
- Addresses: the home machine's named or quick tunnel (free), or Tailscale when the PC already has it, with the address beacon on the existing instar.sh drop for changing addresses and moves; no install of Tailscale or SSH, no listening port.
- Per-user, no administrator, no elevation in v1.
- Signing: Microsoft Artifact Signing, about US$10 a month, publisher "Justin Headley"; asked of Justin as its own four-part request after approval, before the first public release. Done for this run does not wait for it.
- Hosting: GitHub Releases behind instar.sh/pc. Release host: the Mama PC.
- C#/.NET 8 single file, sharing capture and input code with the Windows companion.
- v1 scope: commands, files, screenshot, input, open a browser. Not v1: elevation, team sharing, same-network and relay addresses, Android, Instar sessions on the PC, other operating systems.

## Open questions

*(none)*
