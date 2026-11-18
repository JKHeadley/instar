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

What this spec builds is **not** another owner device. The Mac QR pairing (`docs/specs/mac-qr-pairing.md`) makes a paired computer an *owner device*: `role: 'owner'`, full access, able to mint codes and approve other devices (`src/server/mobilePairingRoutes.ts:1312-1316`, `mac-qr-pairing.md` §Security). A Windows PC that the agent drives is the opposite direction: a machine the agent controls, which must hold **no** authority over the agent. Reusing the Mac pairing unchanged would let the agent, which runs commands as the PC's user and can therefore sign with the PC's key, act as an owner device on its own server. This spec defines a separate device class for that reason.

## Proposed design

### The person's journey

1. The person tells the agent they want it to use their Windows PC, or the agent offers. The agent replies in the conversation with the short address **instar.sh/pc** (typeable on the PC) and a tappable link, and says in one line what will happen.
2. On the PC the person opens instar.sh/pc. It downloads `Instar-Connect.exe` for the PC's architecture (x64 or Arm64, chosen from the browser's report; x64 when unknown). The same file serves every agent and person; it holds no secret and no agent address.
3. Double-click. Windows shows the publisher "Justin Headley" (see Signing). Nothing asks for administrator rights.
4. The window shows, in plain words: "This lets an Instar agent use this PC as you." Two choices, neither pre-selected: **"Full use of this PC"** (for your own PC) or **"Choose what it may do"** (the switches in "What the agent can do"). It then shows a QR code.
5. On the phone: Instar app (iPhone or Android), "+", **"Connect a Windows PC"**, scan, pick the agent.
6. On the PC, the window shows the agent's name, its owner's name, its address and a short key fingerprint, with a warning in plain words: **"Only connect your own agent, from your own phone. No support person, bank or company will ever ask you to do this. If someone on a call or chat asked you to, press Cancel."** The Connect button becomes active after 8 seconds. Connect is refused while a known remote-control program (Quick Assist, AnyDesk, TeamViewer and similar, from a list that ships with the program) is running.
7. On Connect, the phone shows: "<agent> will be able to run programs and use files on <PC name> as you", with the choices made on the PC, and the person approves with Face ID or the phone's fingerprint. The PC closes to a tray icon. The agent says in the conversation: "I can now use <PC name>."

Actions for the person: open a typed link, run the file, pick a choice, scan, wait and Connect, approve on the phone. No account, no admin, no settings.

### Device class: `extender` (no authority over the agent)

- A separate device class, `extender`, set **by the server at mint**, never claimed by the device. The phone's "Connect a Windows PC" action mints a code whose `CodeEntry` carries a new field `deviceClass: 'extender'` (the existing `boundKey` carries the PC key `d`); `PairingPerson.role` is not widened. `deviceKind`, which today is client-claimed display text, plays no part.
- Extenders are **never written to the per-machine `DeviceRegistry`**, whose roles (`owner`/`msp`/`team`) existing checks treat as owner-like when not `team` (`src/server/mobilePairingRoutes.ts:615-650`). They live only in the new `computerExtenders` store. The existing device middleware therefore never recognises an extender key, and `/computers/link` authenticates only against `computerExtenders`. A deny-by-default unit test walks every mounted route and asserts an extender-signed request is refused.
- Extender approval uses a new extender-only route, `POST /mobile/extenders/:id/approve`, which accepts only a presence-signed approval from the owner's phone (Face ID, or the fingerprint on Android). Older app builds never call it, so they cannot show an extender in their generic approval list with owner wording; the generic approve routes, the Telegram code and button, and the dashboard refuse extender requests. An owner without the Instar app cannot connect a PC; the agent says so and offers to pair the app first (Justin, topic 143810: the Instar app is the primary route).
- Extender records live in a **new replicated store kind**, `computerExtenders`, not in the existing `mobileDeviceKeyLedger`. Machines on older builds never read the new kind, so they can never mistake an extender for an owner device. Rows are signed by the machine that wrote them and accepted only under that machine's pinned identity key, the same rule `mobileDeviceKeyLedger` uses. The kind gets its `state-coherence-registry.json` entry, a reconciler registration, and backup inclusion.

### Pairing hand-off (reuses the Mac sealed drop)

- The PC generates its device key: P-256 in Windows CNG under the person's profile, non-exportable, TPM-backed (Microsoft Platform Crypto Provider) when present, the software provider otherwise. Honest limit: a non-exportable key still signs for any process running as that Windows user, and the software provider's key can be extracted by malware running as that user. That matches the person's own privilege; the extender class above is what keeps such use from reaching the agent's owner powers.
- The QR uses the Mac flow's carriage (`mac-qr-pairing.md` §2-§6) in a new type: `instar.sh/pair-pc` v1 carrying the drop slot `r`, the one-time seal key `k`, the device public key `d`, the PC name `n`, and `s`, the switch choices made on the PC screen. The drop slot is refreshed every 120 s, as on the Mac.
- The phone mints the extender code bound to `d`, then seals to the drop slot: the agent's origin list (below), the code, the agent and owner names, and the agent's **machine key set** (below). The PC collects and opens it, then shows the Connect confirmation. Nothing is typed; the Mac's "short code" does not exist here.
- On Connect the PC redeems, proving possession of `d` and sending `s`, the switch choices, signed by `d`; this creates a pending extender row. The phone then shows that row's choices and the person approves (the Mac order: redeem first, then presence approval).
- **Addresses.** The PC accepts the same proven addresses pairing accepts (`docs/specs/install-experience.md` §6): a Cloudflare named tunnel (works anywhere); the agent's same-network address, whose certificate the PC pins from the sealed drop (works when the PC is on the same network as an agent machine, the common home case); and a Tailscale name, used only when the PC already runs Tailscale (the program never installs it). The sealed drop carries every address the agent has, as a signed origin list, and the PC tries them in order. An agent with none of these (a quick tunnel only) is refused at the phone before minting, in plain words, and the agent offers its existing address setup. `docs/specs/hosted-relay.md`, when it ships, adds a further address option without a change here.

### The PC checks the agent, not only the reverse

- **What the PC pins: the agent's machine key set.** Each of the agent's machines already has its own signing key (`identity.loadSigningKey()`), and the agent-wide identity key may be passphrase-protected and so unusable by an unattended server (`src/identity/IdentityManager.ts:42-56`). The PC therefore pins the set of the agent's machine public keys at pairing. A change to the set (a machine added, removed or rotated, including Machine Identity Recovery) reaches the PC only as a frame signed by a key already in the set, and is also written to `computerExtenders`. If every pinned key is gone, the PC cannot verify the agent and must be paired again; it says so in the tray.
- At each socket handshake the accepting machine answers a fresh PC challenge signed with its own machine key, which must be in the pinned set.
- Every command frame is signed by the sending machine's key and carries the PC's generation number (below) and a strictly increasing sequence number; the PC rejects a frame with a bad signature, a key outside the set, a stale generation, or a repeated or out-of-order sequence.
- Origin list changes reach the PC the same way, as a signed frame over a live socket; the PC tries every listed origin before entering the breaker.
- The device-signed upgrade request uses the existing device-signature scheme with its 60-second window and replay guard (`src/core/MobileDeviceKeys.ts:16-17`).

### What the agent can do (v1)

The PC holds the switches and enforces them; the server keeps a mirror to show the owner and to refuse early, and the console shows the state the PC last confirmed. Raising a switch happens only at the PC's tray window and also needs the owner's presence approval on the phone. The owner can lower any switch from the app or the web console; the change is pushed to the PC as its own frame at once. The agent can change none.

Protecting the switches from the agent's own access:
- The switch state is stored with a MAC made with the PC's CNG key; a state file that fails the check means "everything off".
- The Files switch refuses the program's own state and install folders, the HKCU Run key, the Startup folders and the Task Scheduler folder.
- The input path refuses to act while the program's own window or the phone-approval prompt is in front.
- The consent text says plainly that "Files" with write access and "Run commands" each amount to full control as you, and that once "Run commands" is on, Stop and Remove work only as long as the agent has not changed the PC to prevent them; changes the agent made stay after removal (the remover lists the startup entries and scheduled tasks the audit shows the agent created).

| Switch | Under "full use" | What it means |
|---|---|---|
| Run commands | on | Run a PowerShell command as the person, never elevated, inside a Windows Job Object, with a time limit the calling session states (default 2 minutes), returning output. |
| Files | on | List, read, write and delete files the person can reach; stream files between the PC and the agent. |
| See the screen | on | Screenshot of the desktop. |
| Type and click | on | Real keyboard and mouse input through the companion's input code, under the idle rule. |
| Type and click while I am using the PC | off | The same, without the idle rule. |
| Open a browser | on | Open the default browser on a page, under the idle rule. |

The window and the consent text say plainly: **"Run commands" is full control as you: a command can read files, take screenshots and type. The other switches limit the agent only when Run commands is off.** The idle rule is a courtesy floor for the dedicated input path, not containment.

- **Idle rule:** no input through the input path within the person's recent activity (default: nothing typed or clicked for 30 seconds) and none while a full-screen app is in front. The person turns it off with the switch above.
- **Tray indicator:** while any command runs, the tray icon changes, and the first command of a burst shows one toast "<agent> is using this PC" (this is a consent signal on the controlled PC, not a chat notification). The menu's **Stop** cancels everything running (closes the Job Object, which kills every child process) and refuses new commands until the person presses Resume.
- **No elevation in v1.** A command that needs an administrator gets `needs-administrator`; the agent tells the person it cannot do that on this PC yet and never asks them to run it themselves.

### Agent side

- Route family `/computers` (ships dark behind `computers.enabled`): `GET /computers`, `POST /computers/:id/exec`, `/files/*`, `/screenshot`, `/input`, `/open-url`, `GET /computers/:id/audit`.
- **Who may call (v1: the owner only).** The person a session serves comes from the server's own record, never a caller header: the server-issued per-session token of memory privacy, bound to the session's audience (`SessionManager.issueSessionToken`, `src/core/SessionManager.ts:8491`). A `/computers` call is allowed only with a session token whose audience is the PC's owner alone. On an agent where memory privacy is off and `GET /team/people` lists only the owner, every session serves the owner and the agent token is accepted. Any other case is refused, and the agent says memory privacy must be on to use a PC on an agent other people can reach. Every owner session qualifies, including scheduled jobs and sessions handling outside content such as email or web pages; the consent text says so in one sentence. The check runs where the call starts and again on the machine holding the socket. Team sharing of a PC is not v1.
- **Results and files:** every result, file and screenshot from the PC enters the agent's context as untrusted data, never instructions. An inline result has a default size of 1 MB and the caller may ask for more; anything beyond the inline size is not cut: the result returns its first part inline with `overflow: { stream, part: 'head', totalBytes, ticket }` naming the stream (stdout or stderr) and a stream ticket for the rest. Inline results above 64 KB, and all files, travel through a ticketed stream relay (the pattern of `DesktopMeshStreamRelay`, which is also how they cross between machines) in 256 KB chunks with resume by offset, straight to disk; mesh RPC carries only small control frames. The relay has its own per-file cap in config (`computers.maxFileBytes`, default 1 GB).
- **Load:** each call has an id and chunks of different calls interleave. One slot is always kept for quick calls (screenshot, input); the holder machine admits further calls while the socket's buffered amount and the PC's reported load stay within their limits, and answers `pc-busy` beyond that.
- **Audit:** each call writes a metadata row: when, which session and person asked, what kind, duration, exit code, byte counts, and the command text with credentials redacted. Never file contents or output. Rows are written in signed batches to the `computerExtenders` audit stream (unified); repeated screenshots and input are merged into counted rows. Old rows are archived by age to the agent's backup under the Disk Steward's space rules, never deleted, with pruning done per writing machine so peers do not re-send what another machine archived. The read is paged by a cursor of `(time, rowId)`, 100 rows a page.
- **Surfaces:** the web console gets a Devices page backed by `GET /computers` (online state, the switch state the PC confirmed, audit, Lower, Remove). The iPhone and Android apps get the "Connect a Windows PC" scan path, the extender approval call, and the PC's device page. That app work is built in this project by the app lane (`echo-instar-desktop-app`, which ships the iPhone and Mac builds; Android by the Android lane) from a contract written into `.instar/vm-test/app-coordination.md` and tracked as a commitment; the build numbers go on this project's completion list, and the live proof checks the build on Justin's phone.
- **Awareness:** one entry, `src/data/awareness/windows-pc-extender.md`, shown only when `computers.enabled` is on.
- **Config:** `computers.enabled: false` added to ConfigDefaults so existing agents get it through `migrateConfig`; the development agent (Echo) turns it on with its own config override. It is not on the dev-gated feature list, which is for non-destructive features.

### Connection, liveness and one holder per PC

- The PC opens an outbound WebSocket to the stable origin (the same address the app uses). There is no listening port on the PC, no firewall change, no SSH and no Tailscale. The upgrade goes through the server's existing WebSocket manager with per-message compression off and a frame cap matched to the 256 KB chunk.
- Heartbeat: a ping every 30 seconds; two missed pongs drop the connection on both ends.
- **Generation, owned by the PC.** The PC keeps a durable counter, increments it for every new connection, and signs it in the handshake. The accepting machine writes the holder row `{deviceId, machineId, generation}` to `computerExtenders` only when the generation changes; a row with a higher generation replaces a lower one everywhere, and two machines can never hold the same generation because only the PC issues them. The PC accepts frames only for its current generation, so a stale holder's frames are refused at the PC.
- Liveness stays on the holder machine (heartbeat). A session on another machine routes a command over mesh RPC (small control frames) to the holder row's machine, which answers `pc-offline` at once if its socket is gone.
- **Revocation before admission.** A machine accepts a handshake only after checking that its copy of `computerExtenders` is current for that PC with the lease holder; if it cannot check, it answers `retry-after`. A Lower or Remove therefore takes effect at the next frame from a current machine, and a lagging machine cannot keep a revoked PC working.
- Reconnect: full-jitter backoff from 1 second doubling to a 5-minute ceiling. The server's refusal names what kind of refusal it is and how long to wait:
  - `retry-after`: wait as told.
  - `feature-off`: park (below), never remove.
  - `update-required`: self-update (below), then reconnect.
  - `unknown-device`: keep retrying; never remove (a machine may not have caught up yet).
  - `device-revoked`: remove only when the answer carries the signed revocation row from `computerExtenders`; an unsigned or unverifiable revocation is treated as `unknown-device`.
- Breaker: after 7 days without a successful handshake, or on `feature-off`, the PC **parks**: it stops trying, and the tray says "Can't reach <agent>" with Reconnect and Remove. Only the person's Reconnect wakes it. Server side, the PC shows `pc-offline` with its last-seen time.

### Remover

- "Disconnect" in the tray, the Windows Settings > Apps uninstall entry (per-user, under HKCU), and an owner Remove from the app or console all end the same way on the PC: cancel running commands (close the Job Object), tell the agent it is leaving (best effort), delete the CNG key, delete `%LOCALAPPDATA%\Instar\Connect\`, delete the HKCU Run and uninstall entries, then exit and delete its own install folder `%LOCALAPPDATA%\Programs\Instar Connect\` through a one-shot cleanup started at exit (a running program cannot delete itself).
- Owner Remove writes the signed revocation row first, then closes the socket; a PC that is offline removes itself at its next handshake.
- The full-wipe test checks that the profile has none of these left.

### Updates

- The handshake carries the program's protocol version and build number. The server answers `update-required` when the build is below its minimum. The PC fetches the manifest from the fixed release address (never a URL the server supplies), downloads the new build, and checks: the Authenticode signature chains to Microsoft's Artifact Signing identity validation with the publisher subject "Justin Headley" (not one certificate; those rotate every few days), the manifest's detached CMS signature passes the same rule, the SHA-256 matches the manifest, and the build is newer than the installed one (no downgrade). Then it replaces itself through the exit-time step and reconnects. The PC never runs a build that fails any check.

### Building, signing, publishing

- One self-contained .NET 8 single-file executable per architecture (win-x64, win-arm64). The capture and input classes from `InstarDesktopCompanion.cs` are compiled in; its `Main` and `TcpListener` are not, and a Windows test asserts the running program opens no listening socket.
- Signed with Microsoft Artifact Signing under the individual identity **Justin Headley**, the same publisher name as the Mac app's Developer ID. This needs an Azure subscription in Justin's name paid by his card, and a one-time identity check with his ID documents. Both are asked of Justin together, as one four-part request, after this spec is approved and before the first public release; the release step on the build host holds the signing credential in the agent's vault. Microsoft decides whether an individual in Justin's country can enrol; if not, the request names the alternative (signing under SageMind) instead. Unsigned builds are never published.
- Built and signed by a release step on a Windows host the agent controls: the Mama PC, with any other Windows machine the agent can reach as the fallback. Assets go to GitHub Releases of the instar repo; instar.sh/pc (the `site/` project) redirects to the right asset.
- **Release gate:** each build is submitted to Microsoft's Defender file analysis, and a fresh Windows install downloads and runs it with Defender and SmartScreen on. A Defender detection fails the gate; SmartScreen's first-run "Windows protected your PC" for a publisher with little reputation passes it, and the download page says what the person will see and what to click. Before fleet rollout the publisher should have enough downloads that this warning is rare; the fleet step records whether it is.

## Maturation plan

- test-agent-live: a throwaway agent with a named-tunnel origin, the fake PC client (Node, same protocol) in the unit, integration and E2E tests, then a local unsigned build of the real program on the Mama PC against the throwaway.
- dev-agent-live: Echo, `computers.enabled` on by Echo's config override; the same program, signed, connected from Justin's iPhone.
- fleet: default stays off until the graduation criterion is met; then the default changes in a release.
- graduation criterion: the live proof matrix passes on the Mama PC against Echo; the full-wipe test passes on Justin's third machine; the release gate passes; no operator-found defect in the following two weeks; and the recurring model review of the feature ladder reads it ready, with Justin's yes recorded on the ladder.
- dark-window: from the first merge until the graduation criterion is met; the feature is entered in `feature-ladders.json` with an owner (easy setup, topic 143810) and a review date for each rung.

### Tests

- Unit: an extender-signed request is refused on every mounted route except the handshake (deny-by-default walk); extender approval refuses every path except the extender-only route with a phone presence signature; command routing refuses a switch the mirror shows off, a stale generation, a forged session header, and a session token whose audience is not the owner; refusal codes map to the right PC behaviour (parking, never removing on `unknown-device` or `feature-off`); overflow returns a stream ticket; a frame signed by a key outside the pinned set is refused; a lagging machine answers `retry-after`.
- Integration: a fake PC pairs through the real phone-approval routes and the drop point, opens the socket, verifies the agent's challenge signature, runs each command kind, hits `pc-busy`, streams a file with a resume, and is revoked mid-command (the command is cancelled; the PC removes itself only on the signed row).
- E2E: the production boot path mounts `/computers`, answers 200 for a paired fake PC, and refuses with `feature-off` when the switch is off.
- Windows: pairing state machine, removal leaves nothing behind, reconnect ladder and parking, idle rule, no listening socket, Job Object cancel, the switch-state MAC, Files refusing the protected folders, Connect refused while a remote-control program runs.
- Live, through the real surfaces on the Mama PC: open instar.sh/pc, run, connect from the iPhone app with Face ID (and once from an Android phone), the agent runs a command and takes a screenshot, the person presses Stop and Resume, the owner lowers a switch from the app, the owner removes the PC and it cleans itself up. Then the full-wipe test on Justin's third machine: fresh Windows, standard user, no prior Instar state, Defender and SmartScreen verdicts recorded.

## Decision points touched

- Whether a PC may become an extender — invariant; basis: irreversible-consequence; evidence: an extender runs commands as the person, so admission is only the owner's presence-signed approval on the extender-only route for a server-minted extender code; no code alone, Telegram, dashboard or agent path.
- Whether an extender key is accepted on a route — invariant; basis: enumerable-domain; evidence: one accepting route (`/computers/link`), authenticated only against `computerExtenders`; every other mounted route refuses, checked by a deny-by-default walk of the route table.
- Whether a command runs on a PC — invariant; basis: enumerable-domain; evidence: six on/off switches held by the PC under a MAC, each command kind mapped to one switch, checked at the PC.
- Who may call `/computers` — invariant; basis: irreversible-consequence; evidence: a command on someone's PC cannot be undone, so only a server-issued session token whose audience is the owner alone qualifies (or the agent token on a one-person agent without memory privacy).
- Whether a PC removes itself — invariant; basis: irreversible-consequence; evidence: removal deletes the key; only a signed revocation row from `computerExtenders`, signed by a pinned machine key, triggers it.
- Whether a frame is from the agent — invariant; basis: enumerable-domain; evidence: the PC accepts only signatures by a key in its pinned machine key set, for its own current generation, with an increasing sequence.
- Which machine holds a PC — invariant; basis: enumerable-domain; evidence: the PC issues the generation itself, so the holder row with the highest generation is unique.
- Whether input may be sent through the input path now (the idle rule) — judgment-candidate; floor: never within the person's recent activity and never over a full-screen app; default: 30 seconds since the last input; arbiter: the person's "while I am using the PC" switch.
- How long a command may run — judgment-candidate; floor: Stop and the Job Object always cancel it, and the tray shows it running; default: 2 minutes; arbiter: the calling session states the time it needs.
- How many calls run at once on a PC — judgment-candidate; floor: one slot always free for quick calls, and the socket's buffered amount never exceeds the PC's window; arbiter: the holder machine, from the PC's reported load.
- How much of a result comes back inline — judgment-candidate; floor: nothing is cut (overflow returns a stream ticket naming what was not inline); default: 1 MB; arbiter: the calling session.
- Reconnect timing and parking — judgment-candidate; floor: never faster than 1 second, full jitter, and after 7 days without a handshake (or on `feature-off`) the PC parks and stops trying, telling the person; arbiter: the server's refusal (`retry-after`, `update-required`) sets the wait inside the floor; only the person's Reconnect wakes a parked PC.
- How long audit rows stay online — judgment-candidate; floor: rows are archived, never deleted; arbiter: the Disk Steward's space rules decide when online rows move to the archive.

## Multi-machine posture

- Extender records, pinned key-set changes, revocations, the owner's switch-lowering and the holder rows: unified, through the new `computerExtenders` replicated kind (rows signed by the writing machine, accepted under its pinned identity key; holder rows written only when the PC's generation changes).
- The switch mirror: unified, carried on the extender record; the PC's confirmed state is what the console shows.
- The audit rows: unified, signed batches in the `computerExtenders` audit stream, archived per writing machine.
- Pairing codes: machine-local on the minting machine, as for every pairing code today.
- machine-local-justification: physical-credential-locality — the pairing code is a one-time secret held only as a hash on the machine that minted it, exactly as the converged Mac pairing (`docs/specs/mac-qr-pairing.md`) already declares.
- The live socket and its heartbeat are a connection, not state: it terminates on one machine, liveness is read from that machine, and commands from any machine reach it through the holder row.

## Rollback

- `computers.enabled: false` unmounts `/computers` except the handshake endpoint, which stays mounted to answer `feature-off`. On the switch: new work is refused, running commands are cancelled, every connected PC gets a `feature-off` frame and its socket is closed; PCs park and keep their pairing.
- A PC build already in the field can be retired by raising the minimum build (PCs self-update) or made inert by revocation; neither removes it without the signed row.

## Frontloaded Decisions

- A separate `extender` class kept out of `DeviceRegistry`, with no authority over the agent, chosen over reusing the owner-device Mac pairing (which would let the agent sign as an owner device).
- Generic file, sealed-drop pairing, the PC confirms with a scam warning and an 8-second wait, the phone approves with Face ID or fingerprint on an extender-only route; Instar app (iPhone or Android) required, as the primary route.
- Addresses: a named tunnel, the same-network address with a pinned certificate, or Tailscale when the PC already has it; no install of Tailscale or SSH, no listening port. A quick-tunnel-only agent is refused in plain words.
- The PC pins the agent's machine key set; changes arrive signed by a pinned key; losing every pinned key means pairing again.
- Per-user, no administrator, no elevation in v1; the agent never asks the person to run an admin command.
- The PC owns the switches; raising needs the PC tray plus the owner's phone; the owner may lower remotely; the agent changes none.
- Callers: owner-only in v1, identified by the server-issued session token; no team sharing of a PC yet.
- Signing: Microsoft Artifact Signing, about US$10 a month, publisher "Justin Headley" (individual, matching the Mac app), Azure subscription in Justin's name. The cost, the account and the one-time identity check are asked of Justin together, in the four-part form, after this spec is approved and before the first public release. The live proof does not wait for it: it runs on a local unsigned build on the Mama PC.
- Hosting: GitHub Releases assets behind instar.sh/pc (the `site/` project).
- Release host: the Mama PC, with any other reachable Windows machine as fallback.
- C#/.NET 8 single file, sharing code with the Windows app port.
- v1 scope: commands, files, screenshot, input, open a browser. Not v1: elevation, team sharing of a PC, Instar sessions on the PC, services, other operating systems.
- "Done" for this project's run is the live proof on the Mama PC with both phone apps; the third-machine full-wipe test is the graduation step, tracked as a commitment on the easy-setup project until Justin's machine is available.

## Open questions

*(none)*
