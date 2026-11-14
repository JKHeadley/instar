---
title: "Remote desktop at the Mac login window (design note)"
slug: "desktop-login-window"
author: "echo"
created: "2026-11-01"
status: "design-note: unconverged, unapproved, not scheduled"
---

# Remote desktop at the Mac login window (design note)

**Status. This is not an approved spec.** It holds the login-window part ("Tier 2") split out of
`docs/specs/desktop-locked-screen.md` on 2026-11-01. That combined spec failed convergence at round 6 of 6,
with most late findings here. The round 6 fixes below were never reviewed. Nothing depends on this note, nothing
may be built from it, and it carries no convergence or approval tag. Starting this work means a fresh
`/spec-converge` from this text. The last combined version is commit `fd693f01d`.

Proof-row numbers (L5 and so on) are the combined spec's numbering, kept so the review history stays readable.
"Tier 1" means the ordinary-lock feature in `docs/specs/desktop-locked-screen.md`, which is reviewed separately.

## What this would add

The ordinary-lock feature cannot reach a Mac at the login window after a restart, logout or user switch, because
Instar is not running there or macOS has moved the session off the console. Reaching it needs a root-started
LoginWindow agent, a role-account daemon that dials out, a phone step-up, a Developer ID certificate and yearly
OS maintenance. Auto-login on a FileVault-off Mac is a cheaper partial answer: it brings the server back after a
restart, leaving that Mac unlocked until the owner's own setting locks it. Instar explains that trade-off and never sets it.

## Evidence

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

## Who this would protect against

The Tier 2 column of the combined table:

| Attacker | Login window |
|---|---|
| Stolen dashboard PIN, or an honest agent acting wrongly | Stopped by step-up |
| Network observer | Stopped; no listening port |
| Whoever serves the viewer page | Native sheet not affected |
| Hostile code on the front | The app's sheet, chained to the pinned gate key, stops password theft. A browser viewer still gives a hostile front the frames and input after unlock |
| Hostile code as this user on the target | Cannot reach the login window, change the policy or swap root-owned code, unless the user has `NOPASSWD` sudo, where same-user is root |

Status would report `boundary: root-owned`, `boundary: none-nopasswd` (the Studio today) or `boundary: unknown`; only a verified reading may say `root-owned`.

## Design

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

## Code signing and release

| Item | Requirement |
|---|---|
| Tier 1 | Works ad-hoc, as today. Every helper change needs a fresh macOS grant (the M5 Pro's 5 entries), and a lost grant shows only at the lock. So readiness probes while unlocked and reminds the operator **before** it matters. |
| Tier 2 | **Developer ID Application, hardened runtime, notarized.** Notarization is Gatekeeper policy, not a launchd rule; the hard reason is that the root step's requirement needs a team. Proof rig is a separate artifact pinned by `cdhash`, not a config flag. |
| Certificate | Only the Account Holder can create it. Team AG9AE2H87X, Individual. One sign-in, one upload of a certificate request. The p12 holds the private key, and it will sit in the vault, in Bitwarden and in repo secrets, so anyone reaching those can sign what root accepts. We accept that for CI; the alternative is signing only on the Studio. |
| Pipeline | Needed: `.app` build, `notarytool` and stapling, in both `publish.yml` and `release-local.mjs`. |
| Moving Tier 1 to Developer ID | Changes the helper's requirement, and likely drops existing grants once. Done with a notice, separately. |
| Team change | The LLC conversion (CMT-1172) may change the Team ID. Checked then. |
| Entitlement | `com.apple.developer.persistent-content-capture`: Apple-reviewed, for VNC-class apps, reported to remove the monthly prompt, needs a provisioning profile and an app bundle. Apply; nothing depends on it. |

## Windows (direction only)

The companion stops at the lock because that is another desktop. Direction: a LocalSystem service in session 0, installed through UAC;
a worker in the console session with a SYSTEM token attached to `WinSta0\Winlogon` following desktop switches; `SendSAS`
called from the service; `LockWorkStation` run with the user's token and verified by session notification; outbound-only dial
because WSL is down before logon; same step-up. Windows allows a real logon-desktop banner. Authenticode is not strictly required
but antivirus and SmartScreen make it practical. Mama PC live proof is mandatory. Not built under this spec.

## Linux (not built)

No Linux desktop exists in the pool. Diagnostics report `locked-screen-unsupported-linux`. GNOME Remote Login (`grdctl --system`)
is a different feature: a GDM login over an inbound RDP port, not a way into a locked console session.

## Decision points, if this is built

| Decision point | Classification | Floor or justification |
|---|---|---|
| Admit a Tier 2 grant | `invariant` | Valid step-up signature or refused. Identity proof has no competing signals. |
| Prompt rate | `invariant` | 1 a minute, 10 a day; only a fresh roster signature is exempt. |
| Roster fork | `invariant` | Apply all revocations, refuse grants, recovery resolves. |
| Install | `invariant` | Owner signature on the exact hash, never agent-initiated. |
| Offer Tier 2 | `invariant` | Fixed count raises one item; the operator decides. |

## Proof rows

| # | Question | If it fails |
|---|---|---|
| L5 | How does a LoginWindow agent get TCC? | Tier 2 stops |
| L6 | Sandbox compatible with capture and input? | No sandbox; stated |
| L8 | Outbound dial at `login-window-no-session`, Wi-Fi and Ethernet? | Claim narrows to what passed; neither means Tier 2 covers `login-window-switched` only |
| L9 | LoginWindow agent can show a window? | Chime |
| L10 | Admin box accepts remote input? | Person at the Mac |
| L16 | Frames and a key at first-boot, after-logout and fast-switch login windows, as root agent? | Tier 2 claim narrows per row |
| L18 | Login succeeds but Node never starts, a fast-user-switch return, a session older than install, and another account logged in: does the Aqua instance relock, with its own Accessibility grant? | Tier 2 stops |

## Unreviewed round 6 fixes

1. A password logging in a different account left no relock holder. Now a relock-only record.
2. The app-started rate-limit exemption had no proof. Now needs a fresh roster signature.
3. A pending request could sit on the one grant slot. Now a signed request replaces it, with a 150 s bound.

## Known limits

- macOS releases break the login window; AnyDesk's changelog shows it most years.
- `login-window-no-session` needs network before login and a live front elsewhere.
- FileVault-on Macs stay unreachable after restart, and pre-boot unlock stays impossible for third parties.
- A roster revocation reaches a machine only when it reconnects, and a hostile front can delay it.
- A roster fork, which needs two valid keys at odds, halts this feature until the recovery code is used.
- This needs mobile pairing, push and a Developer ID certificate. Without a paired phone there is none of it.
