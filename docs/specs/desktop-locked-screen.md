---
title: "Remote desktop into locked machines"
slug: "desktop-locked-screen"
author: "echo"
created: "2026-11-01"
eli16-overview: "docs/specs/desktop-locked-screen.eli16.md"
convergence-status: "failed-at-cap: round 6 of 6 raised safety design findings; their fixes are written below but unreviewed; see docs/specs/reports/desktop-locked-screen-convergence.md"
parent-principle: "The Agent Is Always Reachable"
parent-principle-fit: "A machine the operator cannot open is a machine the agent cannot be rescued on. This gives the operator, never the agent, a way through the lock from a phone, inside principal and capacity floors."
lessons-engaged: >
  Verify the State, Not Its Symbol (the lock flag); Know Your Principal (the PIN and any Telegram tap
  are reachable by same-user sessions here, so neither authorizes a login-window grant); Signal vs. Authority;
  Structure > Willpower (no code path can store a password); No Silent Degradation; Bounded Blast
  Radius; No Unbounded Loops (dial brake); No Single Device Lockout; Mobile-Complete Operator Actions
  (with one Apple-imposed exception, declared); Live-User-Channel Proof Before Done; TCC follows the
  responsible process; test-agent-leak-guard (throwaways cannot install).
---

# Remote desktop into locked machines

## Problem statement

Operator, 2026-11-01: "We NEED to have the ability to remote into locked machines like AnyDesk does."

Today the macOS helper refuses every capture, input and indicator call while
`CGSSessionScreenIsLocked` is true (`activeSession()` in `InstarDesktopHost.swift`). The Windows
companion refuses unless it is in the interactive console session. A locked machine is reported
unavailable, and the operator must walk to it.

### What "locked" actually is

The earlier note assumed one situation: the session goes off console, so a login-window helper fixes
it. Apple's own engineers say otherwise. There are several states, and they have different fixes.

| State | What is on the screen | Instar server | Who can draw and capture | Fix |
|---|---|---|---|---|
| `unlocked` | The user's desktop | Running | The existing helper | None |
| `screensaver-or-sleep` | Screensaver or dark display, and the password policy read says none is needed | Running | The existing helper | Wake it; today's path |
| `system-asleep` | Whole machine asleep | Not reachable | Nothing runs; nothing dials | **Refused**, named reason |
| `locked-in-session` | The lock shield over the logged-in user's session | Running | User-session helper, if the OS allows it | **Tier 1** |
| `login-window-switched` | Login window after fast user switching; the user's session is alive off console | Running | Only a LoginWindow-session agent | **Tier 2** |
| `login-window-no-session` | Login window after a restart or logout | **Not running** (`ai.instar.*` are per-user LaunchAgents) | Only a LoginWindow-session agent | **Tier 2** |
| `filevault-preboot` | The FileVault unlock screen, drawn before macOS is up | Not running | Nothing third-party | **Refused**, by physics |

Plus `other-user-on-console` (another human's session is on the console, refused) and `unknown`.

A locked session is still an Aqua session, and launchd starts a LoginWindow session only at the login
window (TN2083), so a LoginWindow agent does **not** help the ordinary locked Mac, which is the case
the operator hits. Apple DTS agrees on the edges: third-party UI cannot appear over the shield, and with
FileVault "your pre-login agent isn't running at all". RustDesk 11802 shows third-party tools do see and
type at the lock screen. That case lives in the user's own session and needs no root code.

### How the others do it (evidence)

- **AnyDesk.** Runs as a service since 4.0 (2018), which also "Added support for connections to the
  login screen". The changelog shows this breaking on most macOS releases: 7.2.1 infinite waiting for
  image, 8.1.2 "connecting to the Login Screen or Remote Restart might not work", 8.1.3 fixed for
  Sequoia, 9.6.4 fixed for Tahoe. 8.1.3 and 8.1.4 changed the signing identity and told users to reset
  permissions. Consumer reports place `com.philandro.anydesk.Frontend.plist` in `/Library/LaunchAgents`
  (not vendor-confirmed). 8.1.1 "Remote restart support for Macs with FileVault enabled" is not
  described further. Expect ongoing OS-release maintenance.
- **TeamViewer.** `com.teamviewer.teamviewer_service` and `com.teamviewer.Helper` in
  `/Library/LaunchDaemons`, `com.teamviewer.teamviewer_desktop` in `/Library/LaunchAgents`
  (community and admin sources; the vendor article is login-walled). Its docs say Screen Recording must
  be granted by a user, and MDM can only delegate that to a standard user.
- **RustDesk (open source, read directly).** A root daemon plus an agent with
  `LimitLoadToSessionType = [LoginWindow, Aqua]`. Issue 11802: keystrokes at the macOS lock screen
  were lost until `fix: osx, reset modifiers' state after locking screen`; after that, typing a
  password at the lock screen worked. AnyDesk, RealVNC and RemotePC worked for those reporters.
- **Apple DTS, January 2026 (accepted answer, thread 814152):** daemon for network, agent for GUI,
  agent connects to daemon, `LimitLoadToSessionType` of Aqua and LoginWindow; "I've recently prototyped
  this approach using ScreenCaptureKit and it works as expected on macOS 14.4 and later". Daemons must
  never touch the window server. Pre-login agents run as root. Nothing Apple published says how TCC
  behaves for such an agent; that is proof row L5.

## Proposed design

**Tier 1** (ordinary lock, no install) is what this spec commits to build. **Tier 2** (login window) is fully
designed here, but building it is a separate go/no-go, with a measured trigger, because it adds root-started
code, a Swift protocol stack and yearly OS maintenance. A cheap alternative covers much of the same need:
on a FileVault-off Mac, macOS auto-login brings the server back after a restart (the Studio already uses
`autoLoginUser`), but it leaves that Mac unlocked until the owner's own setting locks it. The readiness card explains this as an
owner choice with its trade-off. Instar never changes that setting and adds no lock-at-login of its own.

**Tier 1 stays small on purpose.** The macOS password is the barrier there. The phone-key machinery below
protects nothing the password does not already protect in Tier 1, so it belongs only to Tier 2, where a
root-started boundary makes it real. Tier 1 therefore does not depend on the mobile app, on push, or on Telegram.

### Who this protects against, by tier

Stated first, because a false claim here is worse than a weak control.

| Attacker | Tier 1 | Tier 2 |
|---|---|---|
| Stolen dashboard PIN, or an honest agent acting wrongly | Can watch the shield (including any notification previews it shows) and press its buttons. **Cannot get in** without the password; guesses capped. If a person unlocks locally the grant ends, leaving today's PIN exposure on an unlocked Mac, nothing more | **Stopped** at the login window by step-up |
| Network observer | Stopped: end-to-end encrypted | Stopped; no listening port |
| Whoever serves the viewer page: the tunnel provider, or a backup relay | **In path for a browser password.** The box shows only while `GET /tunnel` reports `lifecycle.state: active` on the first-tier provider. Cloudflare stays in path, and a hostile relay could fake the page, so this stops a passive relay only; the viewer line says so | Native sheet is not affected |
| Hostile code on the front machine | **Can read a password**, in the browser because the front serves that page, in the sheet because no anchor exists. It can read the frames too. Stated limit | The app's sheet, chained to the pinned gate key, stops password theft. A browser viewer still gives a hostile front the frames and input after unlock |
| Hostile code running as this user on the target | **Not stopped.** Helper, flag and viewer are same-user writable. It can capture a password typed through them. It gains nothing else: it already holds the session | Cannot reach the login window, change the policy or swap root-owned code, **unless** the user has `NOPASSWD` sudo, where same-user is root |

So decision 3 reads: **Instar gives no agent a password, and has no route that originates one.** Tier 2's status
reports `boundary: root-owned`, `boundary: none-nopasswd` (the Studio today) or `boundary: unknown`; only a
verified reading may say `root-owned`.

### Lock reading

New `src/core/DesktopLockState.ts` plus `probe` additions. The flag stays an input, never the answer. Inputs:
`CGSSessionScreenIsLocked`, `kCGSessionOnConsoleKey`, `kCGSessionLoginDoneKey`, `SCDynamicStoreCopyConsoleUser`,
owner of `/dev/console`, a loginwindow-owned shield window, the password policy (`sysadminctl -screenLock
status`, as `machine-self-maintenance` reads it on branch `echo/machine-self-maintenance`), and lock
notifications seen by a long-lived helper. The dictionary is NULL outside a GUI session, so the gate reads
only console user, `/dev/console` and its agent's report.

| Rule | Result |
|---|---|
| Two independent inputs agree and none contradicts | That row |
| Any contradiction | `unknown` |
| Screensaver or display sleep, password policy reads off | `screensaver-or-sleep` |
| Screensaver or display sleep, policy on, delayed or unreadable | Locked-class |

**Locked-class** means `locked-in-session`, `login-window-*` and `unknown`. Locked-class refuses ordinary `type`, and
Tier 2 needs step-up. `secretType` needs a **positive** locked state, never `unknown`. A wrong "locked" costs refused
typing; a wrong "unlocked" is today's exposure. Proof of capture is a real frame, never a reading. A host whose
probe lacks these fields (Windows, an older helper) refuses `lockedScreen.enabled` rather than reading `unknown`
forever. `machine-self-maintenance` has a similar classifier on an unmerged branch whose convergence failed at
its cap; this module does not depend on it, and whichever lands second adopts the other.

### Tier 1: the ordinary locked Mac

No install, no root, nothing listening. Enabled per machine from the Desktop page's machine card behind the PIN
(`POST /desktop/locked/enable`, stored as `remoteDesktop.lockedScreen.enabled`; absent means off everywhere, and `PATCH /config` does not
accept it). The PIN session is local to the front, so the front signs an operator assertion with new operations `locked-enable` and
`locked-settings`, which the target verifies. A session that reads the PIN can enable it; the barrier stays the password. Off is today's
behaviour byte for byte.

**Honest cost.** "No install" is true, but step 7 needs one macOS Accessibility and Screen Recording grant to the helper itself. Apple allows
only a person to do that: on the Mac, or from the phone through the desktop viewer while unlocked if L12 passes. Declared under Mobile-Complete as
Apple-imposed. Ad-hoc signing ties that grant to one build, so an auto-update must not drop it while the owner is away: Tier 1 runs a
**retained copy** of the last granted helper at a stable path until the new build is granted on the card, the way sessions keep a retained
Claude binary. An incompatible wire version turns the password box off with a named reason.

A normal grant, PIN as today, may begin or continue at the shield. The ceiling and idle rules stand. **A grant ends when the Mac
goes from a positive locked reading to `unlocked` with no `secretType` from that grant in the preceding 15 s,** so nobody can sit at the
shield waiting for a person to unlock. A brief `unknown` does not count. This is best effort: timing cannot prove cause, so a wrong remote password
at the instant of a local unlock lets the grant continue. That is no worse than today, where the same PIN opens an unlocked Mac, so no stronger
check is built. The change is more than `activeSession()`:

0. The helper is told per spawn that `lockedScreen` is on, so off stays byte for byte. `ready` in `DirectDesktopAccess` must stay true at
   the shield, or the first 500 ms probe after a lock revokes the grant. The target reads the flag live.

1. `probe` computes `sessionActive` separately (Swift line 243), and `release` and held-input paths also refuse when
   locked. All of them change together, or a lock with a held key poisons `releaseBarrier`.
2. Locking ends `SCStream` and the helper exits. Node respawns it at most 3 times per state change, releasing held
   controls first. Input-stream or indicator loss during a state change is not a revocation; only exhausting the
   3 respawns revokes.
3. If ScreenCaptureKit yields no frames at the shield, the helper falls back to `CGDisplayStream` for this state. That API
   is obsoleted at the macOS 15 SDK target, so the helper keeps its deployment target below 15; if a future SDK removes
   it, this fallback ends and L2 reruns.
4. At grant start in a locked state the helper wakes the display with a user-activity assertion.
5. `indicator` stops exiting when locked. See "On-machine notice".
6. The 2 s input ack timeout becomes per-action: `secretType` gets 20 s.
7. Readiness requires `inputGrant: own` and proven relock (L4) before the password box appears, because relock must run
   after Node has gone, under the helper's own identity. An inherited-only Mac gets a named reason and a step to grant.

### Password path

- `secretType` carries sealed bytes only. The **`input-stream` helper** is the one process that holds the seal key,
  decrypts and types, so plaintext has no path through Node. It makes an ephemeral P-256 key at start and reports the
  public key inside the encrypted grant channel. A respawn rotates the key; a send sealed to an old key is refused and
  the viewer re-seals. AES-GCM, AAD of request id and sequence; repeats refused.
- Tier 1's box is in the viewer: `type=password`, `autocomplete=off`, cleared on send, never in clipboard or storage.
  The limit is shown in one line at first use, and the box shows only while the tunnel is `active` on its first-tier provider. When
  the app's native sheet ships (Tier 2 prerequisite), it becomes the default, and an owner can turn the browser box off. On Tier 1 it has no pinned anchor, so the sheet keeps
  the password from a tunnel provider or relay but **not** from a hostile serving front, and it says so.
- Allowed only on a positive locked state, and only while the shield is loginwindow's and secure event input is held by
  loginwindow (`kCGSSessionSecureInputPID` read in-process from the `IOConsoleUsers` registry entry). The owner counts only
  together with the shield, since a stuck holder has been reported outside the lock. Checked per character; any drop aborts.
- **This narrows the risk; it does not eliminate it.** A check and a posted event are not atomic, so if a person unlocks at that
  moment, the rest of the password could reach the app that gets focus. Enter is sent last and only after a final check.
  The only way to remove the window is not to type, so this is accepted and stated. L14 measures it with focus changes in flight.
- Typing uses real key events from the active layout (`UCKeyTranslate` inverse), after a modifier reset, per RustDesk 11802.
  Unicode events are a fallback only if L3 shows them working. Maximum 256 scalars.
- Decoded into a raw buffer overwritten after use. The claim is exactly: plaintext stays out of Node, logs, disk and durable
  state. Endpoint memory in the viewer and helper is not claimed clean.
- While locked-class, keyboard input is an allowlist: Enter, Tab, Escape, arrows, mouse. Everything else, including `type`, is refused, so a
  password cannot take the plaintext path by habit.
- **Attempt limit.** An attempt is reserved durably before the first character is typed, and refunded only if the state reads `unlocked` within 10 s. Anything else counts,
  including aborts, crashes and uncertain outcomes. An interrupted send clears the field with Escape, and ordinary Enter and mouse input stay blocked until the clear is confirmed, so a half-typed
  field cannot be submitted around the count. 3 per logical request, 6 per machine per calendar day, reset at local midnight; stored in the
  agent state dir on Tier 1 and the role directory on Tier 2. This protects the account. On Tier 1 the count is
  same-user writable, so it binds honest code, and macOS's own delays bind the rest.
- No HTTP route, CLI, config key, vault lookup or job originates `secretType`. A lint test asserts it has no callers outside the
  stream decoder and the viewer. An agent asked for a password refuses, and a password pasted in chat is treated as leaked.

**Limit, stated plainly.** The login password also opens the login keychain. Code that can tamper with the viewer or helper (rows 3
and 4 of the table above) can read it. The viewer says this once, in one line.

### On-machine notice

Apple blocks third-party UI over the shield; the exception is an authorization plug-in, which runs in the login
flow and can break login, so we refuse it.

- `locked-in-session`: one chime at grant start, if L13 passes. The owner can turn it off on the machine card, behind the PIN.
  The `● Instar remote control` item is live and appears at unlock.
- After every locked-class grant the next unlocked session shows one notification with time and duration.
- `login-window-*`: a small "Remote control active" window if L9 passes; else chime if L13 passes; else the claim is
  receipt only.
- Every locked-class grant lands in the audit and the status. Only failures raise anything.

### After unlock and relock

- **Relock on end (default on).** Any session that sent `secretType` owes a relock when it ends. No timing guess clears that: a needless relock costs one
  password, and a missed one leaves a Mac open. "Leave unlocked" is a separate tap at Stop, recorded in the audit; on Tier 2 it needs a fresh device signature.
- **No proven relock, no password box** (Tier 1 step 7), so the rule has no silent exception.
- **Timing.** At Stop or ceiling at once. The viewer counts down from 60 s before the ten-minute ceiling and offers "Leave unlocked" there too. On transport loss, only after the resume window expires, so a phone blip cannot relock mid-task.
- **Survives Node.** A durable `relock-owed` marker is written, and the guard must **acknowledge a lease bound to this grant and its deadline**, before any password character. A detached `relock-guard` (helper in its own
  session via `setsid`, so a tmux or launchd job kill does not reach it, own Accessibility grant) is given the absolute grant deadline and a lease
  the server renews every 10 s. Deadline passed, lease lapsed past the resume window, or stdin EOF past that window all mean relock, so a hung Node with an open pipe
  cannot hold the Mac open. Server boot honours a marker. An auto-update restart cannot leave a Mac open.
- `relock` is a helper verb: `SACLockScreenImmediate` (private; the Keychain menu item's call, per reverse-engineering), else
  Control-Command-Q with Q resolved through the layout inverse. Verified by a fresh reading, one retry, then one security item.

### Tier 2: the login window

**Trigger.** On Tier 1 the target is reachable and counts `login-window-switched` refusals itself. At `login-window-no-session`,
`system-asleep` and `filevault-preboot` no Instar code runs, so these cannot be told apart from outside. The front reports `offline:
can't tell` with last-known hints (FileVault, auto-login), and counts failed desktop opens to dark targets. Reaching 3 in 30 days raises
one attention item offering Tier 2. Tier 2 begins on the operator's yes or on his earlier ask, and needs the Developer ID certificate and
the prerequisites below. If Tier 1 proof fails, Tier 2 cannot replace it, since it never runs at the shield; that goes to the fallback spec.

**Prerequisites.** Mobile pairing and push merged (`MobilePushService` is not on main today); the app's native step-up and password
sheet released; pairing confirmation that works without Telegram for agents that have none. Each is a named build item at Tier 2's start.

```
phone/browser -> front -> (outbound WSS dialled by gate) -> gate daemon (role user)
                                                              | launchd socket, code-sign pinned
                                                              v
                                                           LoginWindow agent (root, launchd-forced)
```

#### Step-up (Tier 2 only)

The PIN is readable by every same-user session, and agents hold the operator's Telegram login in this deployment, so neither authorizes
this. **There is no PIN path and no Telegram path.**

- **Keys.** A dedicated Secure Enclave key (`.biometryCurrentSet`, used only for this) and a **one-time recovery code**, the seed of an
  Ed25519 key shown once on the phone for the owner to keep beyond any agent's reach. A second device is offered. Using the code enrols a new one.
- **First key's trust.** Mobile pairing alone is not enough: it is minted by Bearer and confirmed through Telegram. The first key is pinned
  only at install: a macOS dialog shows its fingerprint and the phone shows the same one. Done through the desktop viewer from a phone it works,
  but a hostile front at that moment could fake the view; the card says that doing it at the Mac is stronger.
- **Roster.** `policy.json` holds the root keys. A role-owned, append-only `roster.log` carries later changes. Each entry names its predecessor's
  hash and a generation, and is signed by a key valid at that point. Two different successors to one entry are a **fork**. A fork is order-independent: every revocation
  on either side applies, and the gate refuses all Tier 2 grants until a recovery-signed entry resolves it. A recovery-signed entry beats any device-signed entry. Device keys cannot revoke
  the recovery key. Each gate stores its accepted head, and older heads are refused, so rollback cannot restore a key. An offline machine, or one whose front withholds entries, still
  accepts a revoked key until it catches up.
- **Prompt.** Target-issued memory-only nonce, and `hostSealKey`, both signed by the gate key the phone pinned at install. The phone verifies this before it shows the
  sheet, so a hostile front cannot swap the key. The phone shows machine, state, how the lock began ("locked 4 minutes ago, during an agent
  session", or "unknown"). The viewer shows a 4-character code and **the operator types it into the phone**, so a prompt started by anyone else
  cannot be approved blind. A request carrying a fresh signature from a roster key, verified by the gate, skips the rate limit and replaces any unapproved pending request, invalidating its nonce,
  so an agent can neither burn the owner's rescue budget nor sit on the one grant slot. Anything else is rate-limited, and a pending request lasts at most 150 s.
- **Signature.** Domain tag `instar-desktop-stepup-v1` over `{targetMachineId, browserKeyDigest, hostSealKey, nonce, lockState, exp}`, `exp` at
  most 120 s, single use. The agent generates `hostSealKey` before approval and holds the one grant slot while pending.
- **Path back.** Phone to its paired host's new device-allowlisted route, relayed over the machine-authenticated pool to the front, then down the
  gate's connection. Paired host down means `step-up-unreachable`, shown on the phone.
- **Rate.** 1 prompt a minute, 10 a day.

- **`Instar Desktop Access.app`**, signed bundle, root owned, at `/Library/Application Support/Instar/`. A root process
  must never run from the npm tree. Every component has its own requirement: `identifier "<x>"`, Team ID and the
  Developer ID markers (`anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "AG9AE2H87X"`). The root step reads the verified bundle's version and refuses anything below the policy's minimum, so an old build cannot be downgraded in.
- **Gate daemon.** `/Library/LaunchDaemons/ai.instar.desktop-gate.plist`, `UserName = _instardesktop`,
  `AssociatedBundleIdentifiers`. Never touches the window server (Apple: daemons have no business there). **Outbound
  only.** Implements in Swift (CryptoKit, no dependencies) the target side: assertion, ECDH, AEAD, grant, lock, Stop,
  heartbeat, deadlines. Wire conformance tested against the TypeScript vectors. One locked-class grant at a time.
  Ed25519 gate key, 0600, role user.
- **LoginWindow agent.** `/Library/LaunchAgents/ai.instar.desktop-login.plist`,
  `LimitLoadToSessionType = [LoginWindow, Aqua]`, as Apple advises. The Aqua instance runs as the user and does one thing: hold relock duty
  (see handoff). At the login window launchd runs it as root and ignores `UserName`, and the window server needs root,
  so we plan on root (L6 tests a sandbox only). Handles SIGTERM, and tolerates a duplicate instance after direct user
  switching. ScreenCaptureKit, macOS 14.4 floor. Connects to the daemon. It is the decrypting typist in Tier 2. No network, no exec, no file writes, one bounded
  input parser, hardened runtime, library validation.
- **Sockets.** Created by launchd (`Sockets`, `SockPathMode`, `SockPathOwner`, `SockPathGroup`), with `RunAtLoad` and `KeepAlive` so the gate dials without waiting for activation, because `/var/run` is not role-writable and clears at boot. Agent socket
  in a role-owned directory; the peer's audit token is checked against the requirement. A separate same-user socket
  takes exactly three verbs: `status`, `disable`, `carry` (read).
- **Front route.** New: `/desktop/gate`, a WSS the gate dials, multiplexing control calls and stream, because
  `DesktopMeshBroker` and `DesktopMeshStreamRelay` only dial peers. A gate is enrolled at install: its key is signed by the
  machine identity key, and the browser pins that vouched key. Availability comes from the gate's heartbeat, since the
  Node probe is down. The gate dials the **one designated front**, which keeps the mesh spec's pool admission ceiling and quarantine. Changing the front is a
  roster entry, and the front's restart quarantine applies. The single front remains a single point of failure; a multi-front design needs shared admission and is out of scope.
- **Dial addresses.** `dial.json`, role owned, seeded at install and refreshed over the connection, signed by a front key.
  A public tunnel must be a named tunnel: a quick URL rotates, and install refuses it. Stale addresses mean a named
  `gate-unreachable` on the front; re-install is the repair. Front key rotation arrives signed by the old key.
- **Dial brake.** Backoff to 5 minutes with jitter; after 7 days of failure, hourly; after 30 days the breaker opens and the gate
  sleeps until reboot or a network change, each of which earns a bounded 24-hour retry window. Logged, shown in status.
- **Policy.** `policy.json`, root owned: owner agent, machine id, pinned fronts, root keys, gate key. The app shows and signs its hash with
  the bundle version. The root step verifies that signature. Everything that changes later rides `roster.log`, so a new phone does not need a
  root step. The gate key reaches the phone through the same install step, as the pin that `hostSealKey` chains to.
- **Update.** No root updater. A wire mismatch turns Tier 2 dark with a card, and the owner repeats the action.
- **One owner per Mac.** The first installer owns it. A second agent reads status and is refused install. Throwaway agents are
  refused. `instar nuke` reports the leftover and never escalates.
- **Reachability, honest.** `login-window-no-session` needs a network before login and a live front elsewhere. A single-machine agent
  has no path there. Tailscale's Mac apps need a logged-in user; only open-source `tailscaled` runs earlier. So the
  gate prefers a named public tunnel.

#### Login-window handoff

launchd ends the LoginWindow instance at login. The Aqua instance is long-lived: install bootstraps it into any live `gui/<uid>` session, so a fast-user-switch return, where
launchd starts nothing new and Node never reboots, still has a holder. The gate writes a signed, single-use `carry` record (operator, policy's owner macOS account, absolute expiry, relock duty,
Leave-unlocked choice) **only if the grant's own `secretType` and Enter preceded the login, and only if the console user is that owner account.** A local login ends the grant. If our `secretType` logged in another account, the gate writes a relock-only record: no follow-on grant, and any Aqua instance passing the code
requirement claims it and relocks at once. The viewer says "Signing in…". The agent's **Aqua instance**, which launchd starts at login with no help from Node, claims it over the socket, checked by uid, session and code requirement (one claim wins; a duplicate instance gets nothing), and holds relock duty
from that moment. Node watches for `carry` while running and at boot, and opens the follow-on grant with no second step-up, inside the original ceiling. Duty passes to Node's guard only on an
acknowledged transfer. Past 180 s with no controller, the Aqua instance relocks. So Node never starting cannot leave the Mac open.

### Install (Tier 2): one owner action

Offered on the Desktop page, for the owner, never automatic, never from a migration. One root step, as
`machine-self-maintenance` reasons, so nothing can swap a validated file:

1. Server stages bundle and policy. App shows keys and version; owner signs. The macOS dialog shows the same fingerprint.
2. If `sudo -n true` works, no box is needed, and the card names `boundary: none-nopasswd`. Otherwise
   `osascript ... with administrator privileges` shows macOS's own box; Instar never sees the password. It is typed by a
   person at the Mac unless L10 passes.
3. Inside the root step: verify the phone signature, make the role account with `sysadminctl -roleAccount` using the UID range that macOS
   version states (it has changed between releases), read it back with `dscl` and fail on drift, copy to a fresh root-owned directory, verify each requirement there, rename, write plists, bootstrap the daemon.
4. macOS's Privacy switches for the bundle: Screen Recording and Accessibility. Apple gives no way to automate these on an
   unmanaged Mac. If L12 shows they also refuse remote input, this is a **declared Mobile-Complete exception**:
   one on-site sitting per Mac, imposed by Apple.
5. Install is "proven" only after a real capture. The card offers a logout test on a throwaway account or at the owner's next restart.

So **one signature, one fingerprint match, one password box and two switches, once per Mac**. Remove reverses it. A failed install rolls back.

### Code signing and release

| Item | Requirement |
|---|---|
| Tier 1 | Works ad-hoc, as today. Every helper change needs a fresh macOS grant (the M5 Pro's 5 entries), and a lost grant shows only at the lock. So readiness probes while unlocked and reminds the operator **before** it matters. |
| Tier 2 | **Developer ID Application, hardened runtime, notarized.** Notarization is Gatekeeper policy, not a launchd rule; the hard reason is that the root step's requirement needs a team. Proof rig is a separate artifact pinned by `cdhash`, not a config flag. |
| Certificate | Only the Account Holder can create it. Team AG9AE2H87X, Individual. One sign-in, one upload of a certificate request. The p12 holds the private key, and it will sit in the vault, in Bitwarden and in repo secrets, so anyone reaching those can sign what root accepts. We accept that for CI; the alternative is signing only on the Studio. |
| Pipeline | Needed: `.app` build, `notarytool` and stapling, in both `publish.yml` and `release-local.mjs`. |
| Moving Tier 1 to Developer ID | Changes the helper's requirement, and likely drops existing grants once. Done with a notice, separately. |
| Team change | The LLC conversion (CMT-1172) may change the Team ID. Checked then. |
| Entitlement | `com.apple.developer.persistent-content-capture`: Apple-reviewed, for VNC-class apps, reported to remove the monthly prompt, needs a provisioning profile and an app bundle. Apply; nothing depends on it. |

### Windows (direction only; needs its own spec)

The companion stops at the lock because that is another desktop. Direction: a LocalSystem service in session 0, installed through UAC;
a worker in the console session with a SYSTEM token attached to `WinSta0\Winlogon` following desktop switches; `SendSAS`
called from the service; `LockWorkStation` run with the user's token and verified by session notification; outbound-only dial
because WSL is down before logon; same step-up. Windows allows a real logon-desktop banner. Authenticode is not strictly required
but antivirus and SmartScreen make it practical. Mama PC live proof is mandatory. Not built under this spec.

### Linux (not built)

No Linux desktop exists in the pool. Diagnostics report `locked-screen-unsupported-linux`. GNOME Remote Login (`grdctl --system`)
is a different feature: a GDM login over an inbound RDP port, not a way into a locked console session.

### Rejected alternatives

- **Bridge to Apple's Screen Sharing.** Reaches the lock with Apple's code, and Apple carries the OS maintenance. Rejected as primary:
  needs a VNC decoder and a second password prompt, and enabling it is Apple's setting. It is the **named fallback** if L1 to L3
  fail, by its own spec.
- **Authorization plug-in.** A bug can lock everyone out.
- **`fdesetup authrestart`.** Needs the password or recovery key each time; storing either is refused.
- **Tahoe SSH FileVault unlock.** Real on macOS 26, needs Remote Login. A good later follow-up for FileVault laptops.

### Off switches

1. `remoteDesktop.lockedScreen.enabled`: absent means off everywhere, including development agents. Set by the PIN-gated enable route.
2. `POST /desktop/locked/disable`, Bearer plus intent header: any session may stop it, with one security notice. PIN re-enables. On Tier 2
   grants are refused, the gate keeps dialling, and an unsigned disable expires after 24 h, so a prompt-injected session cannot strand the owner
   before a restart; a device signature re-enables at once.
3. On the Mac: Remove, or System Settings' login items list.

### Audit

- `DesktopAccessAudit` gains `lockedState`, `stepUpMethod`, `secretTypeCount`, `relock`. Still screen-free and keystroke-free.
- Gate: append-only hash-chained `/Library/Logs/Instar/desktop-gate.log`, role owned, 90 days.
- Security attention, at once with no heal-first delay (Self-Heal exempt: security class): 3 step-up failures in 10 minutes, a socket peer
  failing code check, policy drift, relock failure after retry, disable.
- `GET /desktop/locked/status` is `proxied-on-read` with `?scope=pool`: state, inputs, boundary, install, last relock, refused counts.

### Permission honesty

`GET /desktop/diagnostics` adds `screenConfirmationDueAt` only if L7 finds a readable source. A lapsed confirmation at the lock is a
named reason, never a black stream.

### Phases

1. **Proof rig.** Nothing shipping. Scratch helper on a throwaway macOS user or VM, expected results first. Secure-field rows need a real Mac.
2. **Lock reading**, dark, read-only, plus the Agent Awareness bullet (`PostUpdateMigrator` rewrites it when it differs; `remoteDesktopBullet`
   and `DesktopProbeReadiness` drop "cannot open a locked Mac" only at flip), and the front's dark-target counter.
3. **Tier 1**, dark. Graduation: user-role live harness through the real dashboard on a throwaway user: lock mid-grant, wrong password, unlock,
   relock, Node killed mid-grant, restart mid-grant, fake window, Stop.
4. **Native sheet** in the app, when mobile push lands. Not a Tier 1 prerequisite.
5. **Tier 2**, on its trigger; the first run ends at the certificate. Then the gate.

Per-machine flip after proof. Fleet default stays off. No migration ever installs anything privileged.

### Proof rows

Settled only by a real frame, a real key in a real field and a real unlock. Run per macOS 14, 15, 26, and any newer installed. A row that passes on some versions
ships for those; others report `unsupported-macos`.

| # | Question | If it fails |
|---|---|---|
| L1 | Frames at the shield with ScreenCaptureKit? | L2 |
| L2 | With `CGDisplayStream`? An alert on the Mac counts as fail | Tier 1 stops; Screen Sharing fallback spec |
| L3 | Posted keys reach the password field? Unicode? Modifier reset? | Same |
| L4 | Does `relock` work under the guard's own identity with Node gone, either mechanism, on non-US layouts? | No password box on that macOS; view and Enter only |
| L5 | How does a LoginWindow agent get TCC? | Tier 2 stops |
| L6 | Sandbox compatible with capture and input? | No sandbox; stated |
| L7 | Monthly confirmation in each helper mode, and readable? | No reminder; reason only |
| L8 | Outbound dial at `login-window-no-session`, Wi-Fi and Ethernet? | Claim narrows to what passed; neither means Tier 2 covers `login-window-switched` only |
| L9 | LoginWindow agent can show a window? | Chime |
| L10 | Admin box accepts remote input? | Person at the Mac |
| L11 | Lock reading settles every state? | Row stays `unknown`; if that is `locked-in-session`, Tier 1 stops as L3 |
| L12 | Privacy switches accept remote input? | Declared exception |
| L13 | Chime audible at shield and login window? | Receipt only |
| L14 | Secure input owner readable per character; fake window rejected; how many characters can leak with unlock or focus changing in flight? | Owner unreadable: as L3. Leak measured: stated in the viewer line |
| L15 | Display wake at the shield, headless Mac too? | Named reason |
| L16 | Frames and a key at first-boot, after-logout and fast-switch login windows, as root agent? | Tier 2 claim narrows per row |
| L17 | Does the retained helper keep its macOS grant across an Instar update? | Box off after updates until regranted; stated |
| L18 | Login succeeds but Node never starts, a fast-user-switch return, a session older than install, and another account logged in: does the Aqua instance relock, with its own Accessibility grant? | Tier 2 stops |
| L19 | Node suspended with descriptors open, and Node killed at each startup step: does the guard relock, and does typing refuse without its acknowledgement? | Password box stays off |

## Decision points touched

| Decision point | Classification | Floor or justification |
|---|---|---|
| Enable on this machine | `invariant` | PIN route; Bearer cannot. |
| Admit a Tier 2 grant | `invariant` | Valid step-up signature or refused. Identity proof has no competing signals. |
| Which lock state | `invariant` | Deterministic table; contradiction is `unknown`. No model: a real-frame test settles it. |
| Respawn vs revoke at state change | `invariant` | Bound of 3. |
| Refuse ordinary `type` in locked-class | `invariant` | A password must not take the plaintext path. |
| Allow `secretType` | `invariant` | Positive state, shield and secure-input owner, relock proven. |
| Attempt limit | `invariant` | Reserved before Enter, refunded on verified unlock; 3 per request, 6 per day. |
| Prompt rate | `invariant` | 1 a minute, 10 a day; only a fresh roster signature is exempt. |
| Relock on end | `invariant` | Only an explicit, audited tap exempts. |
| End grant on outside unlock | `invariant` | A grant may not inherit a person's unlock. |
| Roster fork | `invariant` | Apply all revocations, refuse grants, recovery resolves. |
| Install | `invariant` | Owner signature on the exact hash, never agent-initiated. |
| Disable | `invariant` | Always allowed, safe direction. |
| Offer Tier 2 | `invariant` | Fixed count raises one item; the operator decides. |

## Multi-machine posture

Machine-local surfaces, each bound to one physical console or chip:

- machine-local-justification: hardware-bound-resource impossible-because="lock reading, helper, grant, relock marker, gate and LoginWindow agent drive one physical console" permanence=permanent
- machine-local-justification: hardware-bound-resource impossible-because="lockedScreen.enabled, install state and password counters are statements about one physical Mac; visible through proxied-on-read status" permanence=permanent
- machine-local-justification: hardware-bound-resource impossible-because="gate key, seal key and Secure Enclave keys each identify one console or chip" permanence=permanent

Unified: `roster.log` replicates through each gate's connection, carrying generations; status is `proxied-on-read`, with dark peers shown with age;
security notices have one voice, the serving-lease holder, through the existing hub. The front relays ciphertext on the wire, and the viewer page it serves is
the limit stated above. A conversation move does not move a grant. A partition ends the grant at its heartbeat deadline, then relock.

## Frontloaded Decisions

1. **Tier 1 first and committed; Tier 2 on a measured offer.**
2. **FileVault pre-boot and system sleep refused;** from outside they read `offline: can't tell`.
3. **Instar gives no agent a password and has no route that originates one.** Tier 1 does not claim to stop hostile same-user code.
4. **Passwords typed live, never stored.**
5. **Tier 1: no step-up; the macOS password is the barrier.** Tier 1 does not depend on the app, push or Telegram.
6. **Tier 2 roots: Secure Enclave keys and a one-time recovery code, first key confirmed at the Mac. No PIN, no Telegram.**
7. **Browser password box on in Tier 1, with its limit stated;** native sheet becomes the default when it ships.
8. **`input-stream` helper holds the seal key and types.**
9. **No network code as root; outbound only.**
10. **Swift for the gate;** no Node at root, no root updater.
11. **Developer ID required for Tier 2.** One Account Holder sign-in; ends Tier 2's first run.
12. **Apply for the entitlement;** nothing waits on it.
13. **macOS 14.4 floor for Tier 2;** Tier 1 per proof row.
14. **Relock on end, default on; no proven relock means no password box.**
15. **Chime on, owner can turn off.**
16. **Classic plists, not `SMAppService`.** `SMAppService` adds an approval step without improving this threat model; vendors ship classic plists. Durable after first install.
17. **Windows and Linux need their own specs.** No money is committed here.
18. **One owner agent per Mac; throwaways refused.**
19. **Auto-login is explained, never set;** Instar adds no lock-at-login.

## Verify the State

| Detector | Symbol | Claimed state | Independent corroboration | Unmeasurable |
|---|---|---|---|---|
| Lock state | Session flags | A password is needed | Second input; policy read | `unknown`, locked-class |
| Dark target | No answer from Node | Machine state | None possible from outside | `offline: can't tell` |
| Secure field | Shield window plus secure-input owner | Keys reach loginwindow at the check; delivery is not atomic | Both per character, Enter last | Abort |
| Install complete | Files exist | Agent can capture | Real capture at a real login window | "Installed, not proven" |
| TCC grant | Switch on | Capture works | A frame with a non-wallpaper login UI element; a sleeping display is not a failure | Named reason |
| Unlock succeeded | Reads `unlocked` | Session usable | Notification and fresh frame | Keep locked-class limits |
| Relock | Lock call made | Mac locked | Fresh reading | Retry, then security item |
| Unlock cause | State became `unlocked` | Our `secretType` did it | Send within 15 s; **timing only, not proof**, and the failure case equals today's PIN exposure | No send: end grant. Any send: relock owed regardless |
| Step-up (Tier 2) | Signature valid | Owner approved | Root-owned root key and generation-checked roster; typed code | Refuse |
| Boundary | Root-owned files | Same-user cannot alter | NOPASSWD check | `boundary: unknown`, no claim |
| Disable | Verb acknowledged | Grants refused | Refused test grant in status | Report unconfirmed |
| Remove | Files gone | Nothing remains | Re-scan paths, role account, launchd | List what remains |
| Chime | Played call | Audible | Only L13 | Say receipt only |
| Password not stored | No storage code | Absent from disk and logs | Fixture password scanned across logs, audit, dumps | Fail the test |
| Gate offline | No heartbeat | Unreachable | Peer liveness | "Can't tell" |
| Wire version | Number matches | Compatible | Handshake | Tier 2 dark |

## Honest limits

- macOS releases break the login window; AnyDesk's changelog shows it most years.
- No indicator over the shield.
- Tier 1 does not stop same-user code, and the login password opens the keychain.
- A person at the Mac sees the pointer move; the chime is a signal, not prevention.
- `login-window-no-session` needs network before login and a live front elsewhere.
- FileVault-on Macs are unreachable after restart.
- Tier 1: a stolen PIN can watch the lock screen, including any notification previews it shows.
- A password typed in the browser is exposed to hostile code on the front or target, and to a hostile tunnel provider or relay.
- An unlock's cause is inferred from timing.
- Password typing is not atomic with its checks.
- A roster revocation reaches a machine only when it reconnects, and a hostile front can delay it.
- A roster fork, which needs two valid keys at odds, halts Tier 2 until the recovery code is used.
- Tier 1 has no pinned anchor, so a hostile serving front can read a password even from the sheet.
- Tier 2 depends on mobile pairing and push; without a paired phone there is no Tier 2.

## Open questions

*(none)*
