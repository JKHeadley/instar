---
title: "One file on a Windows PC extends the agent to that PC"
slug: windows-one-file-extender
author: echo
status: draft
parent-principle: "The Person Decides; the Agent Does the Rest"
eli16-overview: windows-one-file-extender.eli16.md
constitution-exceptions: "The Person Decides (app required to connect a PC: the app's Face ID approval is the only human-presence proof Instar has); needs Justin's yes"
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

What this spec builds is **not** another owner device. The Mac QR pairing (`docs/specs/mac-qr-pairing.md`) makes a paired computer an *owner device*: `role: 'owner'`, full access, able to mint codes and approve other devices (`src/server/mobilePairingRoutes.ts:1312-1316`). A Windows PC that the agent drives is the opposite direction: a machine the agent controls, which must hold **no** authority over the agent. Reusing the Mac pairing unchanged would let the agent, which runs commands as the PC's user and can therefore sign with the PC's key, act as an owner device on its own server.

## Proposed design

This is the **smallest safe form**, chosen under the convergence cut rule after round 4's findings rose (see the convergence report). It rests on three choices:

1. **The PC is a restricted `extender` device, not an owner device.** It can be driven by the agent and has no power over the agent.
2. **Each PC is bound to one agent machine, its *home machine*.** The PC connects only to it, pins only its key, and is redeemed, held, lowered and removed there. Sessions on the agent's other machines reach the PC by asking the home machine. The reason is the PC's trust: it must check every frame against keys the agent cannot add to on its own, and one pinned machine key plus the owner's phone key is the smallest such set. Draft 3's key set across machines produced holder handover, stale-holder and revocation-lag problems three rounds running; draft 4's remote "move" needed a standing mailbox on instar.sh that brought its own blocking, replay and cost problems. Here, changing the home machine is done at the PC: the person presses "Connect again" in the tray and scans once.
3. **The instar.sh drop is used only while a person is pairing,** exactly as the approved Mac pairing uses it, with a paste fallback. There is no standing channel outside the PC's socket.

This outbound-socket, one-server-per-endpoint shape is the standard remote-management agent pattern (MeshCentral's agent, Intune's management extension); what this spec adds is the owner's phone as the only door in, and an endpoint that holds no authority over its server.

### The person's journey

1. The person tells the agent they want it to use their Windows PC, or the agent offers. The agent replies in the conversation with the download link and one line on what will happen.
2. On the PC the person opens the link. It downloads `Instar-Connect.exe` for the PC's architecture (x64 or Arm64, from the browser's report; x64 when unknown). The same file serves every agent and person; it holds no secret and no agent address.
3. Double-click. Nothing asks for administrator rights.
4. The window says: "This lets an Instar agent use this PC as you." Two choices, neither pre-selected: **"Full control"** (the agent can do anything you can do on this PC) or **"Look only"** (the agent can see the screen and read your files, and change nothing; it can still read anything in those files). It then shows a QR code, with "Paste instead" below it.
5. On the phone: Instar app, "+", **"Connect a Windows PC"**, scan, pick the agent. The app shows which of the agent's machines will hold the PC (below) and lets the person pick another.
6. On the PC, the window shows the agent's name, its owner's name (each clipped to 40 characters with an ellipsis), the home machine's address and a short key fingerprint, with the warning: **"Only connect your own agent, from your own phone. No support person, bank or company will ever ask you to do this. If someone on a call or chat asked you to, press Cancel."** Connect becomes active after a short wait (default 8 seconds). If a known remote-control program (a shipped list: Quick Assist, AnyDesk, TeamViewer, ScreenConnect, Splashtop, RustDesk, LogMeIn, Chrome Remote Desktop, UltraViewer, Zoho Assist) is running, the warning is stronger ("A remote-control program is running. If someone else is controlling this PC, press Cancel"), the wait is longer (default 30 seconds), and the phone approval shows the same line. It is a warning, not a block: the person decides.
7. On Connect, the phone shows "<agent> will be able to <run programs and use files | see the screen and read files> on <PC name> as you", with the PC key fingerprint matching the one it scanned, and the person approves with Face ID. The PC closes to a tray icon. The agent says in the conversation: "I can now use <PC name>."

**Paste instead.** If the phone cannot reach instar.sh or the PC cannot read the drop, the app offers "Send as a link": the same sealed blob (sealed to the PC's one-time key `k`, so any channel is safe) goes out through the phone's share sheet, the person sends it to themselves by any route, and pastes it into the PC's "Paste instead" box.

Actions for the person: open a link, run the file, pick a choice, scan, Connect, approve on the phone.

### Device class: `extender` (no authority over the agent)

- A separate class, `extender`, set **by the server at mint**, never claimed by the device. The phone's "Connect a Windows PC" action, presence-signed, mints a code on an extender branch of the mint route whose `CodeEntry` carries a new field `deviceClass: 'extender'` (the existing `boundKey` carries the PC key `d`); `PairingPerson.role` is not widened. The extender branch skips the owner-pairing preconditions that do not apply (the Telegram approval path) and uses the existing address rules (`pairingOrigin()`, `redeemHostEligible()`).
- Extenders are **never written to the per-machine `DeviceRegistry`**, whose roles existing checks treat as owner-like when not `team` (`src/server/mobilePairingRoutes.ts:615-650`). The existing device middleware therefore never recognises an extender key; `/computers/link` authenticates only against the extender store. A deny-by-default unit test walks every mounted route and asserts an extender-signed request is refused everywhere else.
- Approval uses a new extender-only route, `POST /mobile/extenders/:id/approve`, which accepts only a presence-signed approval (Face ID) from the owner's paired phone. Older app builds never call it; the generic approve routes, the Telegram code and button, and the dashboard refuse extender requests.
- **The Instar app is required to connect a PC (security floor).** Admission gives the agent command over a person's computer, so it needs a human-presence approval the agent itself cannot produce (an operator session or a Telegram button proves the conversation, not a person at a phone). The app's presence signature is the only such approval Instar has; a dashboard passkey approval would meet the same need but does not exist and needs its own security spec. This is an exception to "neither the app nor the dashboard is required", recorded in the frontmatter and named in the approval ask. Android is not in v1's done line; it is tracked as its own item owned by the Android lane.

### Which machine is home

The machine that receives the phone's request proposes the home: among the agent's machines that have a pairing address, the one with the longest unbroken uptime over the past 7 days (from the machine registry), falling back to itself. The app shows the choice and lets the person pick any listed machine. The mint is made on the chosen machine (forwarded over mesh RPC), so the code, redemption, approval and first socket are all on the home machine.

### Stores

- `computerExtenders`: a new append-only replicated kind on the compliance-hold retention class (never pruned): extender records, mode changes, home-key rotations, revocations. Rows are written by the PC's home machine, signed with its machine key, and accepted only under that machine's pinned identity key (the `mobileDeviceKeyLedger` rule). Machines on older builds never read the new kind. It gets its `state-coherence-registry.json` entry, a reconciler registration (listed in `RECONCILER_ALLOWLIST`), and backup inclusion.
- The call audit is **machine-local on the home machine** (it is the only machine that sees the calls), read from other machines through a proxied read, and included in that machine's backup.

### Pairing hand-off (reuses the Mac sealed drop)

- The PC generates its device key: P-256 in Windows CNG under the person's profile, non-exportable, TPM-backed (Microsoft Platform Crypto Provider) when present, the software provider otherwise. Honest limit: a non-exportable key still signs for any process running as that Windows user, and malware running as that user can extract the software provider's key. That matches the person's own privilege; the extender class is what keeps such use from reaching the agent's owner powers.
- The QR uses the Mac flow's carriage (`mac-qr-pairing.md` §2-§6) in a new type `instar.sh/pair-pc` v1 carrying the drop slot `r`, the one-time seal key `k`, the device public key `d`, the PC name `n` (clipped to 40 characters), and `m`, the mode chosen on the PC. The drop slot is refreshed every 120 s, as on the Mac.
- The phone seals to the drop slot: the home machine's origin, the code, the agent and owner names (clipped to 40), the home machine's public key (Ed25519, 32 bytes) and the phone's presence public key (P-256, 65 bytes). At its largest (a 253-character host) this is about 1,100 base64url characters, under the drop's 2,048-character cap; the phone refuses to seal anything larger rather than truncate.
- The PC opens the drop (or the pasted link) and shows the Connect confirmation. On Connect it redeems at the home machine, proving possession of `d` and sending the mode signed by `d`; this creates a pending row. The phone then shows that row's mode and PC key fingerprint, and the person approves (the Mac order: redeem first, then presence approval).
- **Addresses.** The home machine's pairing address under the existing, approved rules (`docs/specs/install-experience.md` §6, approved by Justin 2026-11-02; `pairingOrigin()`): its Cloudflare named tunnel, or its Tailscale name. The program never installs Tailscale. An agent with neither is told so before minting and offered its existing address setup. The quick-tunnel limit is inherited from pairing as a whole, not added here; free addresses for every agent are the job of `docs/specs/hosted-relay.md`, which this program picks up without change when it ships.

### The PC checks the agent, not only the reverse

- The PC pins two keys: the home machine's key (for frames) and the owner's phone presence key (for raises and for owner-signed changes).
- At each socket handshake the home machine answers a fresh PC challenge signed with its machine key. Every later frame's signature covers the handshake transcript hash (both nonces, both keys, the connection id) and a per-connection sequence number, so a frame cannot be replayed on another connection, and the PC rejects a bad signature, another key, or a repeated or out-of-order sequence.
- **Owner-signed records** (raise, home-key rotation, phone-key change, and the owner's direct Lower or Remove below) are signed by the phone's presence key over a versioned purpose string (`instar-pc-order-v1`), the device id, the PC key fingerprint, the order kind, and an **order number** that the PC keeps durably and that must be exactly one more than the last it accepted. The PC reports its current order number in each handshake and the home machine mirrors it, so the phone signs the right number; a mismatch is refused and the phone re-reads and asks again. An old raise can therefore never be replayed after a later Lower.
- **Home key rotation** (including Machine Identity Recovery) reaches the PC only as a frame signed by the old key and countersigned as an owner-signed record. If the old key is gone (a lost disk), the person uses "Connect again" at the PC.
- **Owner phone change**: a new phone key reaches the PC only as an owner-signed record from the old phone; if the old phone is lost, the person uses "Connect again" at the PC. The tray's Stop, Disconnect and the Windows uninstall work without any phone.
- The device-signed upgrade request uses the existing device-signature scheme with its 60-second window and replay guard (`src/core/MobileDeviceKeys.ts:16-17`).

### What the agent can do (v1)

Two modes, held and enforced by the PC:

| Mode | What the agent can do |
|---|---|
| Full control | Run PowerShell commands as the person (never elevated, inside a Windows Job Object, with a time limit the calling session states, default 2 minutes); list, read, write and delete files the person can reach and stream files both ways; take screenshots; type and click; open the default browser on a page. |
| Look only | Take screenshots; list and read files the person can reach, except the credential folders below. Nothing that changes the PC. |

Honest capability statement, in the window and the consent text: **"Full control" means the agent can do anything you can do on this PC.** Command running, file writing and typing each amount to that, so they are not offered as separate switches. **"Look only" still lets the agent read what is in your files and on your screen**, which can include passwords shown on screen or saved in documents. By default Look only refuses a shipped list of credential locations (`%USERPROFILE%\.ssh`, browser profile folders for Edge, Chrome and Firefox, `.aws`, `.azure`, `.config\gcloud`, `.kube`, `.docker`, `%APPDATA%\Microsoft\Credentials` and `Protect`); the person can lift that on the PC.

- **Typing while you work.** Under Full control, typing and clicking wait until the person has not used the keyboard or mouse recently (default 30 seconds) and never act over a full-screen app. A sub-option, "may type and click while I am using the PC", lifts that. This is courtesy, not containment.
- **Lowering** (Full control to Look only, or disconnecting) can be done from the tray, from the app or from the web console; the home machine applies it before answering and sends it to the PC.
- **Raising** (Look only to Full control) needs an owner-signed record (Face ID on the phone), verified by the PC itself, so the agent cannot raise its own access. The phone shows a raise prompt only when the owner started it in the app, or when the PC asked for it from its tray: the tray request is signed by the PC's key `d` and is shown only within 2 minutes of signing. Under Look only the agent cannot run code on the PC, so it cannot produce that signature.
- **Protecting the mode from the agent.** The mode and the order number are stored with a MAC made with the PC's CNG key; a file that fails the check means Look only. Honest limit: under Full control the agent runs as the person and can sign with that key, so the MAC protects Look only and nothing under Full control. In every mode the program refuses, through its own file path, its own state and install folders, the HKCU Run key, the Startup folders and the Task Scheduler folder, and the input path refuses to act while the program's own window is in front. The consent text says that under Full control, Stop and Remove work only as long as the agent has not changed the PC to prevent them, and that changes the agent made stay after removal (the remover lists the startup entries and scheduled tasks the audit shows the agent created).
- **No elevation in v1.** A command that needs an administrator gets `needs-administrator`; the agent tells the person it cannot do that on this PC yet and never asks them to run it.

### Lasting safeguards against tech-support scams

The most likely abuse is a scammer talking a stranger into connecting the scammer's agent; the names the PC shows are chosen by that agent, so the safeguards do not rely on them alone:

- At each Windows sign-in the PC shows a notice for 15 seconds: "Connected to <agent>, owned by <owner>", with a one-click Disconnect.
- Whenever a new agent session starts using the PC, a toast names it ("<agent> started using this PC") with Stop; repeated calls from the same session do not repeat it. This is a consent signal on the controlled PC, not a chat notification.
- The tray icon changes while anything runs. **Stop** cancels everything (closes the Job Object, killing every child process) and refuses new calls until the person presses Resume.
- The download page and the window carry the same "no support person will ask" text. Owner of this threat: the easy-setup project.

### Agent side

- Route family `/computers` (dark behind `computers.enabled`): `GET /computers`, `POST /computers/:id/exec`, `/files/*`, `/screenshot`, `/input`, `/open-url`, `GET /computers/:id/audit`.
- **Calls from other machines.** A session on another machine submits the call to the home machine over mesh RPC as a small control message carrying a caller-made `callId`; the home machine deduplicates by `callId` (so a retried submit never runs a command twice), answers `accepted` at once, and the caller collects the result by `callId` (and stream tickets for anything large). A home machine that cannot be reached gives `home-offline`; a PC that is not connected gives `pc-offline`.
- **When the home machine is offline.** The agent tells the owner once per outage, in the conversation where the PC was asked for: "<PC name> is unreachable while <machine> is off. If <machine> is not coming back, press Connect again on the PC to move it to another of my machines."
- **Who may call.** The route filter admits only sessions serving the owner's own conversation, identified by the server's existing per-session origin credential (`OriginSessionRegistry`, the credential the reply scripts carry), and refuses scheduled jobs and other spawned sessions; the agent bearer token alone is refused. A session that receives typed input through `POST /sessions/:name/input` from anything other than the owner's own message (`src/server/routes.ts:13067`) loses `/computers` until the owner's next message. **Honest limit, stated in the consent text:** Instar's sessions all run as one computer user and can read each other's credentials, so this filter stops ordinary and accidental use by jobs, not a session deliberately working around it; and the owner's own conversation can read web pages, email and tool output. Under Full control, the agent as a whole, including anything it reads, can reach the PC. Look only is the choice for a person who does not want that.
- **Why not team sharing in v1.** A PC belongs to one person, and sharing it needs per-person session audiences bound into `/computers` plus a signed sharing grant per PC; neither exists. Team sharing of a PC is tracked as its own item on the easy-setup project with the Chief of Staff.
- **Results and files:** everything from the PC enters the agent's context as untrusted data, never instructions. An inline result defaults to 1 MB and the caller may ask for more; beyond the inline size nothing is cut: the result returns the start and the end of each stream (where errors usually are) with `overflow: { stream, omitted: { from, to }, totalBytes, ticket }` and a ticket for the whole stream. Larger results and all files travel through a **new resumable file relay** (modelled on the ticket pattern of `DesktopMeshStreamRelay`, which itself is a live-display pipe and is not reused): 256 KB chunks with resume by offset, written straight to disk, pausing (not closing) on backpressure, and also used to cross from the home machine to the calling machine. A file that would leave less free space than the Disk Steward's floor on the receiving machine is refused with `no-space`, naming the size.
- **Load:** each call has an id and chunks of different calls interleave. One slot is always kept for quick calls (screenshot, input); the home machine admits further calls while the socket's buffered amount stays under the PC's window and the PC's reported load allows, taking sessions in turn, and answers `pc-busy` beyond that.
- **Audit:** each call writes a metadata row on the home machine: when, which session and person asked, what kind, duration, exit code, byte counts, and the command text with credentials redacted; never file contents or output. Repeated screenshots and input merge into counted rows. Old rows move to the home machine's backup archive by age under the Disk Steward's space rules, never deleted. The read is paged by a `(time, rowId)` cursor, 100 rows a page.
- **Surfaces:** the web console gets a Devices page backed by `GET /computers` (online state, home machine, the mode the PC confirmed, audit, Lower, Remove). The iPhone app gets the "Connect a Windows PC" path with the home choice, the extender approval, the raise, the direct Lower/Remove and the PC's page; the app lane (`echo-instar-desktop-app`) builds it in this project from a contract in `.instar/vm-test/app-coordination.md`, tracked as a commitment, with its build number on this project's completion list.
- **Awareness:** one entry, `src/data/awareness/windows-pc-extender.md`, shown only when `computers.enabled` is on.
- **Config:** `computers.enabled: false` added to ConfigDefaults so existing agents get it through `migrateConfig`; Echo turns it on with its own config override. The switch is read live: turning it off takes effect without a restart.

### Connection, liveness and revocation

- The PC opens an outbound WebSocket to its home machine's origin. No listening port on the PC, no firewall change, no SSH. The upgrade uses the server's existing WebSocket manager, compression off, frame cap matched to the 256 KB chunk.
- Heartbeat: a ping every 30 seconds; two missed pongs drop the connection on both ends.
- **Lower and Remove** are applied on the home machine before success is returned: the row is written locally, the PC's queue closes for new calls, the frame is sent, and running calls the new mode forbids are cancelled. One machine holds both the socket and the decision, so no other machine can admit a call the owner has refused. Asked on another machine, the request is forwarded to the home machine. If that fails, the app sends the owner-signed Lower or Remove **directly to the home machine's own address** (which it has from pairing), and the home machine passes it to the PC, which verifies the phone's signature itself. If the home machine cannot be reached at all, it is not reaching the PC either; the app says the change applies when the home machine is back, and keeps retrying while open. A home machine that refuses to pass an owner order on is outside what v1 protects against; the person's tray Stop and uninstall still work.
- Reconnect: full-jitter backoff from 1 second doubling to a 5-minute ceiling. Refusals carry a kind and a wait:
  - `retry-after`: wait as told.
  - `update-required`: self-update (below), then reconnect.
  - `unknown-device`: keep retrying (the home machine may be restoring from backup).
  - `feature-off`: probe once a day.
  - `device-revoked`: remove only when the answer carries the revocation row signed by the pinned home key; otherwise treat as `unknown-device`.
  - A plain 404 on the socket path (a home machine on an older build) is treated as `feature-off`.
- **Breaker.** After 7 days without a handshake the breaker trips: the tray says "Can't reach <agent>'s <machine>" with Connect again, Stop trying and Remove, and attempts drop to once an hour. The PC never gives up on its own, because a home machine can be away for weeks; it stops only when the person chooses Stop trying or Remove, or on a signed revocation.

### Remover

- What triggers removal: the person's Disconnect in the tray or the Windows uninstall; a revocation row signed by the pinned home key; or an owner-signed Remove from the phone with the next order number.
- "Disconnect" in the tray, the Windows Settings > Apps uninstall entry (per-user, HKCU), and an owner Remove all end the same way: cancel running calls (close the Job Object), tell the home machine it is leaving (best effort), delete the CNG key, delete `%LOCALAPPDATA%\Instar\Connect\`, delete the HKCU Run and uninstall entries, then exit and delete the install folder `%LOCALAPPDATA%\Programs\Instar Connect\` through a one-shot cleanup started at exit.
- An owner Remove writes the signed revocation row first, then sends the frame; a PC that is offline removes itself at its next handshake. "Connect again" (to move to another machine) is a fresh pairing with a new key; the old record is revoked by the new home machine once the approval completes.

### Updates

- The handshake carries the protocol version and build number; the server answers `update-required` below its minimum. The PC fetches the manifest from the fixed release address `https://github.com/JKHeadley/instar/releases/latest/download/instar-connect-manifest.json` (never a URL the server supplies) and checks, before running anything: the manifest is signed by the **Instar Connect release key** (Ed25519, public key compiled into the program, private key held in the agent's vault and used only by the release step), with an RFC 3161 timestamp; the manifest lists the allowed Authenticode publisher identities (Artifact Signing identity-validation OIDs under `1.3.6.1.4.1.311.97.`, each with its Microsoft root); the downloaded build's Authenticode signature chains to a listed root with a listed identity; the SHA-256 matches; and the build is newer than the installed one. A change of publisher (for example to SageMind) is a new manifest list signed by the release key, so fielded PCs keep updating. The PC never runs a build that fails any check.

### Building, signing, publishing

- One self-contained .NET 8 single-file executable per architecture (win-x64, win-arm64). The capture and input classes from `InstarDesktopCompanion.cs` are compiled in; its `Main` and `TcpListener` are not, and a Windows test asserts the program opens no listening socket. Ed25519 verification uses a bundled library (the .NET 8 base library has none).
- Signed with Microsoft Artifact Signing under the individual identity **Justin Headley**, the publisher name of the Mac app. This needs an Azure subscription in Justin's name (about US$10 a month) and a one-time identity check with his ID. Both go to Justin as one four-part request (problem, exactly what changes, what yes does, what no or waiting does) after this spec is approved and before the first public release. If Microsoft does not enrol an individual in his country, that request names signing under SageMind instead. Unsigned builds are never published.
- Built and signed on a Windows host the agent controls (the Mama PC, with any other reachable Windows machine as fallback). Assets go to GitHub Releases of the instar repo; the download link (instar.sh/pc, the `site/` project) redirects to the right asset.
- **Release gate** (after approval, before the first public link): Defender file analysis; a fresh Windows install downloads and runs the signed build with Defender and SmartScreen on. A Defender detection fails the gate; SmartScreen's first-run warning for a new publisher passes it, and the download page says what the person will see and what to click.

## Maturation plan

- test-agent-live: a throwaway agent with a named-tunnel origin, the fake PC client (Node, same protocol) in unit, integration and E2E tests, then a side-loaded local unsigned build on the Mama PC against the throwaway.
- dev-agent-live: Echo, computers.enabled on by Echo's config override; the same side-loaded build on the Mama PC, connected from Justin's iPhone.
- fleet: default stays off until the graduation criterion is met; then the default changes in a release.
- graduation criterion: the live proof matrix passes on the Mama PC against Echo; the signed build passes the release gate; the full-wipe test passes on Justin's third machine; no operator-found defect in the following two weeks; the pairing funnel (QR shown, scanned, Connect, approved) is measured on the live proofs; and the recurring model review of the feature ladder reads it ready.
- ladder: test agent (throwaway), dev agent (Echo), fleet (default on)
- dark-window: from the first merge until the graduation criterion is met; entered in feature-ladders.json with owner easy setup (topic 143810) and a review date per rung.

### Tests

- Unit: an extender-signed request is refused on every mounted route except the handshake (deny-by-default walk); approval refuses every path except the extender-only route with a phone presence signature; `/computers` refuses the agent bearer token, a job's session, a session after non-owner input, and accepts an owner-conversation session; Look only refuses exec, write, input, open-url and the credential folders at the PC; owner-signed records with a wrong order number, purpose, device id or key fingerprint are refused, and an old raise after a Lower is refused; a frame from another connection or key is refused; a raise prompt from the agent without a fresh PC signature is not shown; a resubmitted `callId` runs once; overflow keeps head and tail and returns a ticket; refusal kinds map to the right PC behaviour.
- Integration: a fake PC pairs through the real phone-approval routes and the drop point (and once by paste), opens the socket, verifies the challenge, runs each call kind, hits `pc-busy`, streams a file with a resume and a backpressure pause, receives a call submitted from a second machine, is lowered, raised with a phone-signed record, and removed mid-call (calls are cancelled; it removes itself only on a valid trigger); an owner Lower sent directly to the home machine's address while mesh forwarding fails.
- E2E: the production boot path mounts `/computers`, answers 200 for a paired fake PC, and refuses with `feature-off` when off.
- Windows: pairing state machine, paste path, removal leaves nothing behind, reconnect and the 7-day breaker, idle rule, no listening socket, Job Object cancel, Look only enforced, the credential folders refused, the sign-in notice and the per-session toast, the remote-control warning.
- Live, through the real surfaces on the Mama PC with the side-loaded build: open the link, run, connect from the iPhone app with Face ID, the agent runs a command and takes a screenshot, the person presses Stop and Resume, the owner lowers to Look only from the app and raises again with Face ID, "Connect again" moves it to a second machine, the owner removes the PC and it cleans itself up. Done for this run is that proof against the throwaway and against Echo. The signed build, the public download link and the SmartScreen/Defender verdicts are the release gate; the full-wipe test on Justin's third machine is the graduation step, tracked as a commitment on the easy-setup project until the machine is available.

## Decision points touched

- Whether a PC may become an extender — invariant; basis: irreversible-consequence; evidence: an extender runs commands as the person, so admission is only the owner's presence-signed approval on the extender-only route for a server-minted extender code; no code alone, Telegram, dashboard or agent path.
- Whether an extender key is accepted on a route — invariant; basis: enumerable-domain; evidence: one accepting route (/computers/link), authenticated only against computerExtenders; every other mounted route refuses, checked by a walk of the route table.
- Whether a call runs on a PC — invariant; basis: enumerable-domain; evidence: two modes held by the PC, each call kind mapped to the modes that allow it, checked at the PC.
- Whether the mode may be raised — invariant; basis: irreversible-consequence; evidence: a raise gives command over the person's computer, so only an owner-signed record with the next order number, verified on the PC, is accepted.
- Whether an owner-signed record is current — invariant; basis: enumerable-domain; evidence: the PC accepts exactly last order number plus one, with matching purpose, device id and key fingerprint.
- Whether a call reaches /computers — invariant; basis: irreversible-consequence; evidence: a command on someone's PC cannot be undone, so only a session serving the owner's own conversation, by its origin credential, and not after non-owner input; stated as a filter, not an isolation boundary.
- Whether a PC removes itself — invariant; basis: irreversible-consequence; evidence: removal deletes the key; only the person at the PC, a revocation row signed by the pinned home key, or an owner-signed Remove with the next order number triggers it.
- Whether a frame is from the agent — invariant; basis: enumerable-domain; evidence: the PC accepts only the pinned home key, over this connection's handshake transcript, with an increasing sequence.
- Which machine holds a PC — invariant; basis: enumerable-domain; evidence: exactly one, the home machine recorded in its extender row; changed only by Connect again at the PC.
- Which machine is proposed as home — judgment-candidate; floor: only machines with a pairing address; default: longest unbroken uptime over 7 days; arbiter: the person, who picks on the phone.
- Connect wait on the PC — judgment-candidate; floor: Connect is never instant and the scam warning is always shown; default: 8 seconds, 30 when a remote-control program runs; arbiter: the person, who may Cancel at any time; reviewed at graduation from live-proof timings.
- Whether a running remote-control program stops pairing — judgment-candidate; floor: the stronger warning shows on the PC and on the phone approval; default: warn and wait longer, never block; arbiter: the owner's presence approval.
- Which folders Look only refuses — judgment-candidate; floor: the shipped credential list is refused by default; arbiter: the person on the PC, who can lift it.
- Typing while the person is active — judgment-candidate; floor: never over a full-screen app and never within the person's recent activity unless they lifted it; default: 30 seconds since the last input; arbiter: the person's sub-option.
- How long a tray raise request stays valid — judgment-candidate; floor: it must carry the PC's own signature; default: 2 minutes; arbiter: the owner, who approves or ignores it.
- How long a command may run — judgment-candidate; floor: Stop and the Job Object always cancel it, and the tray shows it running; default: 2 minutes; arbiter: the calling session states the time it needs.
- How many calls run at once — judgment-candidate; floor: one slot always free for quick calls, buffered bytes never above the PC's window; arbiter: the home machine, from the PC's reported load, taking sessions in turn.
- How much of a result is inline — judgment-candidate; floor: nothing is cut, head and tail are kept and a ticket names what was omitted; default: 1 MB; arbiter: the calling session.
- Whether a file transfer is refused — judgment-candidate; floor: never leave less than the Disk Steward's free-space floor; arbiter: the Disk Steward on the receiving machine.
- Reconnect timing and the breaker — judgment-candidate; floor: never faster than 1 second with full jitter, never more than once an hour after the breaker trips, the tray always shows the tripped state; default: trip after 7 days; arbiter: the server's refusal sets the wait inside the floor, and the person decides in the tray to keep trying, stop or remove; reviewed at graduation.
- How long audit rows stay online — judgment-candidate; floor: rows are archived, never deleted; arbiter: the Disk Steward's space rules.

## Multi-machine posture

- Extender records, mode changes, home-key rotations and revocations: unified, through the `computerExtenders` replicated kind (written by the home machine, signed by its key).
- The PC's binding to its home machine: unified as data (every machine sees which machine holds a PC and submits calls to it); the live socket terminates on the home machine only.
- machine-local-justification: physical-credential-locality — the PC pins the home machine's own signing key, which lives on that machine's disk and is never copied; only the holder of that key can answer the PC's handshake.
- The call audit: proxied-on-read from the home machine, which is the only machine that sees the calls.
- Calls from sessions on other machines: proxied to the home machine over mesh RPC by `callId`; results cross through the resumable file relay.
- Pairing codes: machine-local on the home machine.
- machine-local-justification: physical-credential-locality — the pairing code is a one-time secret held only as a hash on the machine that minted it, as the converged Mac pairing (docs/specs/mac-qr-pairing.md) declares.
- The home-offline notice: sent once per outage by the machine serving the owner's conversation.

## Rollback

- `computers.enabled: false` (read live) unmounts `/computers` except the handshake endpoint, which stays to answer `feature-off`. New calls are refused, running calls are cancelled, every connected PC gets a `feature-off` frame and its socket closes; PCs keep their pairing and probe once a day.
- A build in the field is retired by raising the minimum build (PCs self-update) or made inert by revocation.

## Frontloaded Decisions

- A separate `extender` class kept out of `DeviceRegistry`, with no authority over the agent.
- Each PC bound to one home machine, proposed by uptime and chosen by the person; moved by Connect again at the PC.
- The instar.sh drop used only during pairing, with a paste fallback; no standing remote channel.
- Two modes, Full control and Look only, with honest text about what each means; credential folders refused under Look only by default.
- Raise only by an owner-signed record verified on the PC; every owner-signed record carries the PC's next order number.
- Callers: owner-conversation sessions by origin credential, as a filter with its limit stated; no team sharing yet (tracked).
- Instar app (iPhone) required as a security floor; a constitution exception that needs Justin's yes, named in the approval ask. Android tracked by the Android lane.
- Scam safeguards: warning plus wait at Connect, stronger warning and longer wait (never a block) with a remote-control program running, a sign-in notice and a per-session toast.
- Addresses: the existing approved pairing rules (named tunnel or Tailscale); quick-tunnel support comes with the hosted relay.
- Per-user, no administrator, no elevation in v1.
- Updates trusted through a release key in the agent's vault that signs the allowed-publisher list.
- Signing: Microsoft Artifact Signing, about US$10 a month, publisher "Justin Headley"; asked of Justin as its own four-part request after approval, before the first public release. Done for this run does not wait for it.
- Hosting: GitHub Releases behind instar.sh/pc. Release host: the Mama PC.
- C#/.NET 8 single file, sharing capture and input code with the Windows companion.
- v1 scope: commands, files, screenshot, input, open a browser. Not v1: elevation, team sharing, remote move, quick-tunnel and same-network addresses, Android, Instar sessions on the PC, other operating systems.

## Open questions

*(none)*
