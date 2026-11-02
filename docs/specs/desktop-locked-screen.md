---
title: "Remote desktop through the ordinary Mac lock screen"
slug: "desktop-locked-screen"
author: "echo"
created: "2026-11-01"
eli16-overview: "docs/specs/desktop-locked-screen.eli16.md"
convergence-status: "failed-at-cap: round 8 of 8 raised one low-severity, marginally safety-related design finding; round 8 findings are in the report and NOT applied here; see docs/specs/reports/desktop-locked-screen-convergence.md"
parent-principle: "The Agent Is Always Reachable"
parent-principle-fit: "A Mac the operator cannot open is a Mac the agent cannot be rescued on. This gives the operator, never the agent, a way through the ordinary lock from a phone."
lessons-engaged: >
  Verify the State, Not Its Symbol (the lock flag); Know Your Principal (the PIN is readable by same-user
  sessions, so the Mac password is the barrier); Signal vs. Authority; Structure > Willpower (no code path
  stores or originates a password); No Silent Degradation; Bounded Blast Radius; No Unbounded Loops;
  Mobile-Complete Operator Actions (one Apple-imposed conflict, declared); Live-User-Channel Proof Before
  Done; TCC follows the responsible process (docs/specs/mac-desktop-own-permission-identity.md).
---

# Remote desktop through the ordinary Mac lock screen

## Problem statement

Operator, 2026-11-01: "We NEED to have the ability to remote into locked machines like AnyDesk does."

The macOS helper refuses every capture, input and indicator call while `CGSSessionScreenIsLocked` is true
(`activeSession()` in `InstarDesktopHost.swift`). A locked Mac reads as unavailable and the operator has to walk to it.

"Locked" is several states with different fixes. This spec covers only the ordinary lock, where the user is logged in
and the shield sits over their live session. A LoginWindow agent never runs there (TN2083), so no root code is needed.
RustDesk issue 11802 shows third-party tools see and type at this screen from the user's own session.

| State | Instar server | This spec |
|---|---|---|
| `unlocked` | Running | Today's path |
| `screensaver-or-sleep` (no password needed) | Running | Wake it; today's path |
| `locked-in-session` | Running | **The feature** |
| `login-window-switched` | Running | Refused, named reason |
| `other-user-on-console` | Running | Refused, named reason |
| `login-window-no-session`, `filevault-preboot`, `system-asleep` | Not running | `offline: can't tell` from outside |
| `unknown` | Running | Locked-class, no password |

The login window is out of scope. `docs/specs/desktop-login-window.md` is an unapproved design note and nothing here
depends on it. Windows and Linux report `locked-screen-unsupported` and refuse `lockedScreen.enabled`.

## Proposed design

Nothing to install, no root, nothing new listening. Off by default on every machine.

### Who this protects against

Stated first, because a false claim here is worse than a weak control.

| Attacker | Result |
|---|---|
| Stolen dashboard PIN, or an honest agent acting wrongly | Can watch the shield, including notification previews, and press what the input rules allow. **The PIN alone cannot unlock macOS**, though the stated timing coincidence can leave control after someone unlocks locally; password-path guesses capped, macOS's delays bind the rest |
| Network observer | Stopped: end-to-end encrypted |
| Tunnel provider or backup relay, native app | Stopped for a password **once this phone has pinned this Mac's key**. First contact trusts what the front supplied |
| Tunnel provider or backup relay, browser page | **Can read the password.** It serves or carries the page and can change it |
| Hostile code on the serving front | **Can read a password typed in a browser**, and can serve a password box whatever the setting says. It can alter that page to see frames and send input after unlock. Against the native app, after pinning, it holds only ciphertext; at first contact it can supply its own key |
| Hostile code running as this user on the target | **Not stopped.** The helper, flag and counters are same-user writable, and it can capture a password typed through them. It already holds the session, so it gains the password and the keychain that password opens |

So: **Instar gives no agent a password and has no route that originates one.** It does not claim to stop hostile code running as the user.

### Lock reading

New `src/core/DesktopLockState.ts`, fed by `probe`. The flag is an input, never the answer. Inputs fall into two classes, and only the first can tell locked from unlocked:

- **Lock-discriminating:** `CGSSessionScreenIsLocked`; a loginwindow-owned shield window, identified by the layer and bounds P9 measures, never by owner alone; lock and unlock notifications seen by a helper alive at the time.
- **Session-only:** console user (`SCDynamicStoreCopyConsoleUser`), owner of `/dev/console`, `kCGSessionOnConsoleKey`, `kCGSessionLoginDoneKey`. These name whose session is on the console and stay true at the shield.

Every input except notifications must be read in one sample no older than 2 s. A stale sample, a missing required input, or inputs that contradict each other give `unknown` before the table is consulted. Otherwise the first match wins, top to bottom.

| State | Predicate |
|---|---|
| `other-user-on-console` | Console user is a different person |
| `login-window-switched` | No console user, or loginwindow is on console while this user's session is off console |
| `locked-in-session` | Console is this user, flag true, shield window present. A notification corroborates when one was seen; a helper started at the shield has none |
| Locked-class by policy | Screensaver or display asleep, and either the flag is true or the policy is on, delayed or unreadable |
| `screensaver-or-sleep` | Screensaver or display asleep, flag false, policy reads off |
| `unlocked` | Console is this user, flag false, no shield window, no screensaver, display awake |
| `unknown` | Nothing above matched |

**Locked-class** is `locked-in-session`, the policy row and `unknown`. A wrong "locked" costs refused typing; a wrong "unlocked" is today's exposure. A real frame, not a reading, proves capture. The probe path already spawns helpers on a 2 s timeout, so `sysadminctl -screenLock status` is cached for 60 s and refreshed on a state change; the flag and window read run per probe.

**Proven versions.** A code-owned table lists the macOS major versions that passed the proof rows. Anything else reports `unsupported-macos` and the password path stays off, so a new macOS cannot fall through with undocumented keys. Versions without a test Mac stay unlisted; that blocks nothing else.

### Turning it on

The machine card on the Desktop page, behind the PIN, on the phone or anywhere: `POST /desktop/locked/settings`, stored as `remoteDesktop.lockedScreen` (`enabled`, `browserBox`, `chime`). `PATCH /config` does not accept it and preserves it on a `remoteDesktop` patch. The setting is read live at each grant and needs no restart. The front signs an operator assertion with new operations `locked-settings` and `locked-disable`, which the target verifies. These carry no browser key and sign a digest of the settings, under a new version string, so `begin`'s bytes stay unchanged for targets not yet updated; a front that is its own target verifies locally. Older targets refuse the new operations, so targets update first. A session that reads the PIN can enable it; that opens no Mac, since the barrier stays the password. Off is today's behaviour byte for byte.

**Helper permission.** The password path needs the helper's own Accessibility and Screen Recording grants, because relock runs after Node has gone. Only a person can grant them; see "Mobile-Complete conflict".

**Retained helper.** Ad-hoc signing ties a grant to one build, so an update could silently remove it while the owner is away, and that shows only at the lock. While the feature is on, **every helper verb runs one retained binary**:

- It lives per Mac, outside any agent's project tree, at `~/.instar/desktop-helper/retained/<sha256>/`, with a `current` pointer file holding the digest. The file viewer cannot reach it. Agents on one Mac share it, so one grant serves them.
- `MacDesktopHost.trustedBinary()` today accepts only `dist/native`. It gains this one path: a regular file, owned by this user, with no group or other write on it or the pointer, whose SHA-256 is checked against the pointer before every spawn, including the guard.
- `probe` runs it, so `screenGrant` and `inputGrant` describe the binary that will actually type and relock. Readiness reads only that.
- With the feature on and no pointer, or an installed build newer than the pointer by the `version` verb, that build lands as the one candidate per Mac in its own directory, under the per-Mac lock. Agents on a Mac update at different times, so nothing older than the pointer can flip it back, the installed build keeps serving the viewer until the first flip, and an agent on older code uses the newer helper through the additive wire contract. The card asks for the grant, naming the candidate in the macOS prompt, a real probe of the candidate must pass, then the pointer flips. Old directories are pruned once no process maps them, the way `ClaudeBinaryRetainer` keeps versions.
- A retained helper can miss helper fixes. The helper gains a `version` verb returning a code-owned helper constant, not the package version, so only a helper change asks for a grant, status shows the retained copy's age, and a code-owned minimum version turns the password path off with a named reason when a helper fix must not be skipped. The wire contract stays additive; a mismatch turns the password path off with a named reason.
- Missing, tampered or wrong-digest retained copy: the installed build serves unlocked use, the locked features are off with a named reason, and nothing falls back to an ungranted build. During a live duty, the grant ends and a security item fires.
- `instar nuke` leaves this directory and reports it, because another agent may use it. It is inert without a server. A stable signing identity would make this copy unnecessary, since a grant then survives releases; none exists yet, and this feature does not wait for one.

### The grant at the shield

A normal grant, PIN as today, may begin or continue at the shield. Only one locked-class grant per Mac holds input, under a Mac-wide lock, whichever agent opened it. The ten-minute ceiling and idle rules stand. Grant-bound state in this spec keys to the **request id**, not `grantId`, because an interrupted grant resumes with a new `grantId` up to 3 times. Changes:

1. The helper is told per spawn that the feature is on. `ready` in `DirectDesktopAccess` stays true at the shield, or the first 500 ms probe after a lock revokes the grant. `desktopReadiness`, `DesktopProbeReadiness` and `GET /desktop/targets` take the new reading, or a locked Mac keeps listing as unavailable. `ready` also needs `displayCount > 0`, which likely reads 0 with the display asleep, so under the flag a locked-class or `screensaver-or-sleep` reading counts online displays instead. The probe never wakes anything; only an admitted grant does (item 5).
2. Every `activeSession()` refusal changes together under that flag: `probe`, `capture`, both capture streams, `input-stream` and `performInput`, `cursor`, `release`, held-input paths and `indicator`. `indicator` holds the controller lock and its exit revokes the grant, so it must keep running at the shield.
3. Under the flag a failed probe reads `unknown`, within the respawn bound, rather than revoking at once, so one helper timeout does not relock a Mac the owner just unlocked. Locking ends `SCStream` and the helper exits. A lock-caused capture exit is a respawn, never a codec failure, so it does not downgrade H.264 to JPEG. Under the flag this replaces today's revoke on `input-stream` loss. Node respawns capture or input at most 3 times per state change and 8 per request, with 1, 2 and 4 s backoff, releasing held controls first. Exhausting either revokes. `DesktopStreamManager`'s capture-failure and `input-failed` closes, and its `releaseBarrier`, follow the same rule under the flag. A brief `unknown` is not a state change.
4. If ScreenCaptureKit yields no frames, the helper falls back to `CGDisplayStream` for this state. That API is unavailable when compiling for macOS 15 or later. The release build targets 13, but local builds pass no `-target`, so the build script pins `-target <arch>-apple-macosx13.0` everywhere. If a future SDK removes it the row reruns.
5. At grant start or resume, in a locked-class state or `screensaver-or-sleep`, the helper wakes the display, and the `indicator` process holds a user-activity assertion for the rest of the grant, so the shield does not vanish mid-grant.
6. The 2 s input ack becomes per-action; `secretType` gets 20 s. `input-stream` reads commands on a separate thread, so Stop and abort take effect between characters.

**Input by state.** At positive locked states, an allowlist: Enter, Tab, Escape, arrows, pointer and mouse clicks, less anything P13 refuses, enforced in the helper. Everything else is refused, so a password cannot take the plaintext path by habit. At `unknown`, view only, no input at all; a grant cannot start input there. In the helper, any of the flag, a shield, or secure input held by loginwindow or by an unreadable owner means the allowlist applies, so a password field in an ordinary app on an unlocked Mac changes nothing. A refused input is not a failure: `input-stream` answers `{"refused":"<reason>"}` without exiting, the parser accepts that reply, the stream does not close, and it spends no respawn budget. Releasing a control the helper actually holds is never refused, in any state. A refused reply leaves Node's and the stream manager's held sets unchanged, and an up with no matching down is a refused no-op, so pairing checks cannot kill the grant. Today any `performInput` error exits and revokes, so one stray letter would end the grant. The viewers also suppress the keyboard in locked-class states.

**A grant ends** when the Mac reaches `unlocked` with its last positive state locked, and no Enter posted for a reserved attempt of that request in the preceding 15 s, so nobody can wait at the shield for a person to unlock. A refused `secretType` does not count, so the window is bounded by the attempt limit. A grant that began at `unknown` counts as locked. If the last positive state was `unlocked`, a return to `unlocked` continues. While a locked-class request is interrupted, Node keeps sampling the reading once a second and stamps any change, and resume applies this same rule. Timing cannot prove cause, so a wrong remote password at the instant of a local unlock lets the grant continue; that equals today's PIN exposure on an unlocked Mac. A move to `login-window-switched` or `other-user-on-console` also ends it, with a named reason.

### Password path

- **The native app is the phone path.** Instar's iPhone app already has a native remote desktop viewer (`instar-ios`, `RemoteDesktop/`) with a direct encrypted channel to the target, opened with the dashboard PIN. It gains a native password sheet. Its code is not served by the front or tunnel, so neither can change it.
- **Pin.** Today the app accepts the target key the front lists in `GET /desktop/targets` each session. The app now stores each machine's target signing key in its Keychain, keyed by machine id alone, on first sight, because the address can change with a tunnel or relay. A known machine with the same key on a new address needs no tap. On a later change it refuses the sheet with a plain notice. Accepting a changed key is a separate tap naming the risk, and offers no password in that session; legitimate machine identity recovery lands here. A never-seen machine needs its own first-use tap. A new machine id or key carrying a label already pinned on this phone to a different one, at any address, gets a stronger first-use tap naming the conflict, and the phone has a Forget action, because agents sharing a Mac have separate ids and unnamed machines share a label. Forget leaves a tombstone of the machine id, and a re-pin of a tombstoned id counts as a changed key, so Forget cannot route around the refusal. A front can still choose another label. This is trust on first use: a front or tunnel hostile at first contact is not caught.
- **The browser box is off by default.** An owner may turn it on per machine on the card, behind the PIN, with the limit shown once and one line beside the box: the serving machine and the tunnel provider can read what is typed here. While on, the viewer shows it only when `GET /tunnel` reports `lifecycle.state: active` on the first-tier provider. `type=password`, `autocomplete=off`, cleared on send, never in clipboard or storage.
- **Enforcement of that setting.** The viewer declares `client: app` or `client: browser` at grant start, forwarded through `DesktopMeshBroker`, `onDesktopOperatorBegin` and the local begin path, undeclared meaning browser, and the target refuses `secretType` from a browser grant while the box is off. The declaration is not authenticated, so "off" binds honest pages only; a hostile front can show a box anyway.
- `secretType` carries sealed bytes only. The **`input-stream` helper** is the one process that holds the seal key, decrypts and types, so plaintext has no path through Node. It makes an ephemeral P-256 key at start and reports the public key to Node through a new reply type on the `input-stream` parser, which must accept an unsolicited reply and raise today's 128-byte limit. Today's channel has no target-to-viewer control path, so this adds a third AEAD direction, `control`, with its own IV domain and sequence, outside the video budget and never dropped, sent only to a viewer that declared `controlRecords` at grant start. It cannot share the frame sequence, because a control record overtaking a frame in flight would make that frame fatal to the viewer. It carries the seal key, the lock state, refusal reasons and "relocking has begun". No control record, no sheet or box. A respawn rotates it. The sender makes a fresh P-256 key per send, then ECDH, HKDF-SHA256 bound to request id and helper key, and AES-GCM with AAD of request id and sequence; repeats refused.
- **No automatic resend.** The viewer holds no password after send. Any refusal or interruption reopens the sheet and the owner retypes.
- Allowed only on positive `locked-in-session`, on a proven macOS version, with this request's marker in `owed`, its relock-now flag clear, and a guard heartbeat under 15 s old at reservation, no `field-dirty` marker, the shield present, and secure event input held by loginwindow (`kCGSSessionSecureInputPID` from the `IOConsoleUsers` entry). If P9 shows the field needs focus first, the helper runs that one fixed focusing step before checking. Checked per character; any drop aborts.
- **This narrows the risk; it does not remove it.** A check and a posted event are not atomic, so a person unlocking at that moment could send the rest of the password to the app that gets focus. Enter goes last, after a final check. P9 measures it and the sheet states it.
- Typing uses real key events from the layout the shield uses (`UCKeyTranslate` inverse), after a modifier reset, per RustDesk 11802. A character the layout cannot produce is refused before an attempt is reserved. Maximum 256 scalars.
- Decoded into a raw buffer overwritten after use. The claim is exactly: plaintext stays out of Node, logs, disk and durable state. Endpoint memory in the viewer and helper is not claimed clean.
- **Attempt limit.** An attempt is reserved durably before the first character, and refunded only if the state reads `unlocked` within 10 s. Everything else counts, including aborts and crashes. 3 per request, 6 per Mac per local day, in a per-Mac counter under `~/.instar/desktop-helper/`, updated under a lock so agents share it. This protects the account. It is same-user writable, so it binds honest code; macOS's own delays bind the rest.
- **Half-typed field.** A durable `field-dirty` marker under `~/.instar/desktop-helper/`, per Mac and login session, is written before the first character. It clears when Enter is posted after the final check, on a positive `unlocked` reading, or on a confirmed clear. It outlives the request. An abort, or the next helper after a kill, first sends modifier-up, then Escape while the shield is confirmed, so a held Shift or partial field does not survive. Until cleared, and only in locked-class states, Enter and mouse stay blocked for every agent on that Mac, so a half-typed field cannot be submitted around the count. P14 proves Escape clears it. On a macOS where it does not, a dirty field keeps those keys blocked until that login session ends or a person unlocks.
- No HTTP route, CLI, config key, vault lookup or job originates `secretType`. A lint test asserts it has no callers outside the stream decoder and the two viewers. An agent asked for a password refuses, and a password pasted in chat is treated as leaked.

### Relock

- **Owed.** Any request that sent `secretType` owes a relock when it ends. After a terminal marker the same request may type again only with a new marker generation, guard and acknowledgement; after `relock-failed` it is refused. No timing guess clears that: a needless relock costs one password and a missed one leaves a Mac open.
- **No proven relock, no password.** Readiness needs the retained helper's own input grant and proof row P4 before the sheet or box appears. An inherited-only Mac gets a named reason and a step to grant.
- **When.** At Stop or the ceiling, at once. The viewer counts down from 60 s before the ceiling. On transport loss, only after the resume window, so a phone blip cannot relock mid-task.
- **Leave unlocked** is a separate tap at Stop or in the countdown. It travels as a command inside the encrypted grant channel, so no HTTP route or Bearer token can issue it, and it is audited.
- **Survives Node.** Before the first password character, a durable marker per request is written under `~/.instar/desktop-helper/`, naming the owning agent, request, deadline, boot session UUID and login session. A detached `relock-guard` must then **acknowledge a lease bound to that request and deadline**. The guard is the retained helper in its own session (`setsid`), started with its own permission identity (`INSTAR_DESKTOP_OWN_IDENTITY`), so a tmux or launchd job kill does not reach it. Nothing new listens: the lease is a file only the owning agent's server renews every 10 s, the guard answers in a heartbeat file, and "relock now" is a flag on the marker the guard polls each second, ignored at any terminal state. Deadline passed, or lease lapsed past the resume window, each mean relock, so a hung Node cannot hold the Mac open. The guard sends modifier-up first.
- **A dead guard.** The server reads the heartbeat at each renewal. A missed answer, or boot finding a live marker, starts a replacement guard, at most 3 per request, then the last guard is killed and the marker goes `relock-failed`. An `executing` older than 30 s may be taken over. Before taking over, a replacement SIGKILLs the old guard, identified by pid and start time, and confirms it is gone, so a paused guard cannot wake later and lock during someone's next session.
- **Ending the duty.** The marker has one state: `owed`, `executing`, then `relocked` or `relock-failed`; or `owed` to `left-unlocked`; or `closed-not-applicable`. The guard must take `executing` before it calls lock. Leave unlocked must take `left-unlocked` from `owed`, and only then is the tap acknowledged. If the guard won, the viewer says relocking has begun. All changes to markers, counters and the pointer go through a short-lived helper verb that takes `flock`, so Node and Swift share one lock, Node never holds it, and the kernel frees it on death. The running helper and guard take the same `flock` in process. A guard exits at a terminal state, and each request has its own guard, so a later grant starts clean.
- **Stopping the typist first.** Before the guard reads the lock state or takes `executing`, it stops the password producer. The `input-stream` helper records its pid and start time in the marker at reservation, and writes a durable, timestamped `enter-pending` flag immediately before posting Enter, cleared when that attempt's outcome is known. The same time stamps the grant-end rule, so a late ack cannot end a good unlock. The guard sets relock-now, which refuses any new reservation, SIGKILLs the helper recorded in the marker, which also works on a suspended process, and confirms it is gone, so no further password event can be posted. If `enter-pending` is set, a submission may still be in flight, so the guard watches the reading for 10 s, the same window as the attempt refund, before it may conclude anything. Only then does the pre-lock check run. An `unlocked` reading in that window is relocked like any other. If the helper cannot be confirmed gone, the duty stays held and retries within the guard's bound, then `relock-failed`.
- **Before every lock call,** including fallback and retry, the guard confirms the marker is still its own `executing`, then re-checks boot, login session and that this user is on console. A positive difference closes the marker as `closed-not-applicable`, audited, with no lock call, so it never locks whoever else is there. An unreadable input is not a difference: it retries, then `relock-failed`. A Mac already locked closes as `relocked` with no lock call, so no shortcut lands in the password field.
- **Admission.** While any agent's live marker on this Mac is `owed` or `executing`, a new request is refused with `relock-pending`, except the same request's resume, so a late guard cannot lock a following session. A marker from another boot or login session never blocks, and any agent's boot may close it `closed-not-applicable` through the flock verb. In the same boot, a marker past its deadline with a stale heartbeat stops blocking only after its guard is SIGKILLed by pid and start time and confirmed gone, and the marker moves to `relock-failed` under the lock. A stale heartbeat does not prove death. If termination cannot be confirmed, admission stays blocked with a named reason. This check runs with the feature off too, only when such a marker exists, so a clean Mac stays byte for byte. After `relock-failed` an ordinary grant may start, the state being today's unlocked exposure, and the password path stays refused until a positive locked reading.
- **Boot and sweep.** Requests are memory-only, so a restart has already revoked the grant. The owning agent's server boot therefore never renews: a live marker whose request is gone means relock now, so an update restart cannot leave a Mac open. A marker from another boot or login session closes as above. Each renewal and each boot sweep all of this agent's markers. A `relock-failed` still reading unlocked in the same boot and session gets one fresh attempt from boot, as a new marker generation, and the server raises the security item once, recorded in the marker, since a guard cannot raise one. A timer, not a later request, ends an interrupted request at its resume window.
- `relock`, the guard and the marker `flock` are new helper verbs, which extends today's two-argument contract. `input-stream` starts when the grant does, so the seal key exists before the sheet opens.
- `relock` is a helper verb: `SACLockScreenImmediate` (private), else Control-Command-Q with Q resolved through the layout inverse. Verified by a fresh reading, one retry, then `relock-failed` and one security attention item raised by the target itself, since a partitioned target is the only machine that knows; the pool then de-duplicates.

### On-machine notice

Apple blocks third-party UI over the shield, and an authorization plug-in can break login, so we refuse one. One chime at grant start if P8 passes, which the owner can turn off on the card. The `● Instar remote control` item is live and appears at unlock. After every locked-class grant the next unlocked session shows one notification with time and duration.

### Off switches

1. `remoteDesktop.lockedScreen.enabled`: absent is off everywhere, including development agents. Set by the PIN route.
2. Disable: `POST /desktop/locked/disable` with Bearer plus intent header, or from the phone through the front's `locked-disable` operation. Any session may stop it, with one security notice. It writes a per-Mac `disabled` marker under `~/.instar/desktop-helper/`, read by every agent on that Mac at each grant, in the 500 ms probe and before each `secretType`, so another agent's live grant stops too. Only a PIN route clears it. Disable ends every request that began in a locked-class state or holds an `owed` marker, including one that has since unlocked, through the normal relock path, and never clears a marker or guard. Ordinary unlocked grants are untouched. The marker write does not depend on the retained binary. `POST /desktop/locked/settings` clears it.
3. A revert of the code restores today's behaviour. A running guard still finishes its duty. What remains is the inert retained directory and macOS's permission rows.

### Audit and status

- `DesktopAccessAudit` gains `lockedState`, `secretTypeCount`, `relock`. Still screen-free and keystroke-free.
- Security attention, at once (Self-Heal exempt, security class): relock failure after retry, disable.
- `GET /desktop/locked/status` with `?scope=pool`: state, inputs, last relock, refused counts, retained helper version and age, and whether the password path is ready with its named reason.
- `GET /desktop/diagnostics` adds `screenConfirmationDueAt` only if P5 finds a readable source. A lapsed macOS monthly confirmation at the lock is a named reason, never a black stream.

### Phases

1. **Proof rig.** Nothing shipping. A scratch helper on a throwaway macOS user, expected results written first, on the macOS versions the pool actually has; others stay unlisted. Secure-field rows need a real Mac. Its macOS grants are a human step, and the run stops there; phase 3 stops the same way for its helper. The rig's fresh user has no granted helper to view through, so P7 is tested later, on a Mac whose installed helper is already granted.
2. **Lock reading**, dark and read-only, plus the Agent Awareness bullet (`generateClaudeMd`, rewritten by `PostUpdateMigrator` when it differs). `remoteDesktopBullet` and `DesktopProbeReadiness` drop "cannot open a locked Mac" only at flip. No config migration: absent is off.
3. **The feature**, dark. Includes the app's sheet and pin in `instar-ios`, released to TestFlight. Graduation: user-role live harness through the real app on a throwaway macOS user: lock mid-grant, wrong password, unlock, relock, Node killed mid-grant, restart mid-grant, fake window, Stop. Unit, integration and e2e tiers as the Testing Integrity standard requires.

P12 and P15 need the real server, guard, viewer and marker path, so they run in phase 3 on a test build. That build alone compiles in a test proven-versions table; no environment variable, config key or route can reach it in `dist`. A passing P15 is then recorded in the shipped table, so the enable route refuses a version without it.

Maturation: test agent, then development agent, then available to the fleet, off per machine at every stage. Each Mac is flipped only after proof, and only under the Mobile-Complete rule below.

### Proof rows

Settled only by a real frame, a real key in a real field and a real unlock. A version passes only when every row passes or takes its stated fallback, and then enters the proven-versions table. P15 has no fallback: the feature ships switched off, and no machine, development agents included, is enabled until it has passed there.

| # | Question | If it fails |
|---|---|---|
| P1 | Frames at the shield with ScreenCaptureKit? | P2 |
| P2 | With `CGDisplayStream`? An alert on the Mac counts as fail | Feature stops; Apple Screen Sharing bridge gets its own spec |
| P3 | Posted keys reach the password field after a modifier reset, on a non-US layout, and which layout does the shield use? | Same |
| P4 | `relock` works under the guard's own identity with Node gone, on non-US layouts? | No password on that macOS; view and Enter only |
| P5 | Monthly confirmation in each helper mode, and readable? | No reminder; reason only |
| P6 | Lock reading settles every state, including display asleep while locked? | Row stays `unknown`; if that is `locked-in-session`, stop as P3 |
| P7 | Privacy switches accept remote input through the viewer while unlocked? | Mobile-Complete rule below |
| P8 | Chime audible at the shield? | Receipt only |
| P9 | Shield window's layer and bounds; does an unlocked session ever match; secure-input owner readable per character, and held before the field has focus; fake window rejected; per-character cost against the 20 s ack; how many characters leak with unlock or focus changing in flight? | Owner unreadable: as P3. Leak measured: stated on the sheet |
| P10 | Does a Mac locked with its display asleep pass readiness? Display wake at the shield, and held through a grant, headless Mac too? | Named reason |
| P11 | Retained helper keeps its grant across an Instar update, and does a candidate granted in its own directory work at the pointer flip? | Password off after updates until regranted; stated |
| P12 | Node suspended with descriptors open, killed at each startup step, tmux and launchd kills, guard killed in each marker state, guard suspended across a takeover and resumed during the next grant, relock failing with Node down, a user switch or logout with the guard alive, Leave unlocked racing the guard both ways, Leave unlocked followed by a crash, and an immediate next grant refused until the duty ends, across agents, a stray letter at the shield leaving the grant alive: does the guard do exactly its duty, and does typing refuse without its acknowledgement? | Password path stays off |
| P13 | Can any allowed action at the shield, clicks, Tab, arrows or Enter, reach an on-screen keyboard or other typing surface? | Refuse whichever actions reach it on that macOS; Escape and pointer remain |
| P15 | **Required gate, no fallback.** With a real password on a real Mac: Stop, the deadline, transport expiry and a Node kill, each landed immediately before and after Enter, and with `input-stream` suspended. Does every case end with the Mac locked, or Leave unlocked explicitly taken, and no Enter after the duty closes? How long can a submission take to unlock, against the 10 s window? | **No Mac is enabled on that macOS version** |
| P14 | Does Escape clear a partial password without blanking the display, and do modifiers release after a killed helper, and does a failed clear stay blocked into a new request? | Keys stay blocked after an interrupted send, as above |

### Rejected alternatives

- **Bridge to Apple's Screen Sharing.** Apple's code reaches the lock, but it needs a VNC decoder and a second prompt. It is the named fallback if P1 to P3 fail, by its own spec.
- **Phone step-up on this path.** The verifier and keys would be same-user writable, so it would protect nothing the password does not.
- **Browser page as the default phone path.** Rejected for the limit above; the app's viewer already exists.
- **Authorization plug-in.** A bug can lock everyone out.

## Mobile-Complete conflict

The standard says every operator action must be completable from a phone, and it fails closed: do not roll out an operator-required action otherwise. macOS's Accessibility and Screen Recording switches can only be set by a person on an unmanaged Mac; software cannot set them. The retained helper is a new path, so every Mac needs this grant once, including Macs where the installed helper is already granted. With ad-hoc signing a new helper build needs it again, though the old build keeps working until then.

If P7 passes, the owner does this from the phone through the viewer while the Mac is unlocked, and the standard is met. If P7 fails, it means a sitting at each Mac, which **conflicts with the standard, and this spec does not resolve that**. Only the operator can accept it or amend the standard, since it is a constitution question. This gates the per-Mac flip, not the build: the code ships dark either way, and no Mac is flipped on an on-site grant until he has answered.

## Decision points touched

| Decision point | Classification | Floor or justification |
|---|---|---|
| Enable on this machine | `invariant` | PIN route; Bearer cannot. |
| Enable the browser box | `invariant` | PIN route, limit shown, off by default. Target-side refusal binds honest clients only. |
| Which lock state | `invariant` | Fixed predicates; contradiction is `unknown`. A real-frame test settles it. |
| Which helper build runs | `invariant` | Digest-checked retained binary while on; never an ungranted fallback. |
| macOS version admitted | `invariant` | Code-owned proven table, requiring a recorded P15 pass; anything else unsupported and not enableable. |
| Respawn vs revoke at state change | `invariant` | 3 per change, 8 per request. |
| Refuse ordinary `type` in locked-class | `invariant` | A password must not take the plaintext path. |
| Allow `secretType` | `invariant` | Positive state, proven version, shield, secure-input owner, relock acknowledged, clean field. |
| Password sheet on a changed key | `invariant` | Refused in that session; identity has no competing signals. |
| Attempt limit and refund | `invariant` | Reserved before the first character; refunded only on a verified unlock; 3 per request, 6 per Mac per day. |
| Relock on end | `invariant` | Only Leave unlocked exempts; one state under one lock decides. |
| Leave unlocked | `invariant` | Inside the encrypted channel; audited; no route. |
| End grant on outside unlock | `invariant` | Ends with no reserved attempt's Enter in the prior 15 s; the timing exception is stated. |
| Disable | `invariant` | Always allowed, safe direction; never clears relock duty. |

## Multi-machine posture

- machine-local-justification: hardware-bound-resource impossible-because="lock reading, helper, grant, retained binary, relock marker and guard drive one physical console" permanence=permanent
- machine-local-justification: hardware-bound-resource impossible-because="password counters and the disabled and field-dirty markers are statements about one physical Mac, shared by its agents; visible through proxied-on-read status" permanence=permanent
- machine-local-justification: hardware-bound-resource impossible-because="lockedScreen settings are one agent's choice for one physical console, and each agent on a Mac has its own; visible through proxied-on-read status" permanence=permanent

Status is `proxied-on-read`, dark peers shown with age. `remoteDesktop.lockedScreen` must not travel with any config sync; if `config.json` syncs on an agent, the setting is keyed by machine id. Relock failure is raised by the target, then de-duplicated in the pool. The app's key pin is local to one phone by design. A conversation move does not move a grant. A partition ends the grant at its heartbeat deadline, then relock.

## Frontloaded Decisions

1. **Ordinary lock only.** The login window is a separate, unapproved note.
2. **No step-up; the macOS password is the barrier.**
3. **Instar gives no agent a password and has no route that originates one.**
4. **Passwords typed live, never stored.**
5. **Native app is the phone path; browser box off by default, owner opt-in per machine.** No dependence on push, on Telegram, or on pairing: the viewer uses the dashboard PIN, and the app needs only the designated front's address.
6. **Trust on first use for the target key.** A stronger anchor needs the login-window design's install step, which is not built.
7. **`input-stream` helper holds the seal key and types.**
8. **Relock on end, default on; no proven relock means no password.**
9. **Chime on, owner can turn off.**
10. **One retained, digest-checked helper per Mac until a new build is granted.** Stable signing would replace it when a certificate exists; this feature does not wait.
11. **macOS only, proven versions only; other hosts refuse the enable.** The rig runs on the macOS versions the pool has.
12. **Attempts 3 per request, 6 per Mac per day, shared by agents.**
13. **All grant-bound state keys to the request id.**
14. **`unknown` is view only.**
15. **One locked-class grant per Mac; a per-Mac disable overrides every agent; each agent's own PIN can enable its own access.**
16. **Rig: the Mac Mini first, any free pool Mac otherwise.** It has no daily console user, and a throwaway user takes the console by fast user switching. Budget a grant sitting for phase 1 and another for phase 3's helper, since an ad-hoc grant binds to one build, and one more after any helper fix.
17. **Off until the Stop case passes.** Operator condition, 2026-11-01, topic 134088: ships switched off, and not turned on until the Stop case passes a real test (P15).
18. **The guard kills the typist before judging the lock state.**
19. **Mobile-Complete: P7 passing meets the standard; otherwise the operator's answer gates the per-Mac flip, never the build.**

## Verify the State

| Detector | Symbol | Claimed state | Independent corroboration | Unmeasurable |
|---|---|---|---|---|
| Lock state | Session flags | A password is needed | Second input; policy read | `unknown`, locked-class |
| Secure field | Shield window plus secure-input owner | Keys reach loginwindow at the check; delivery is not atomic | Both per character, Enter last | Abort |
| TCC grant | Switch on | Capture works | A real frame | Named reason |
| Unlock succeeded | Reads `unlocked` | Session usable | Notification and fresh frame | Keep locked-class limits |
| Relock | Lock call made | Mac locked | Fresh reading | Retry, then security item |
| Unlock cause | State became `unlocked` | Our `secretType` did it | Reserved attempt's Enter within 15 s; **timing only, not proof** | No such Enter: end grant. Any `secretType` sent: relock owed regardless |
| Password producer stopped | Stop sent | No further key event | SIGKILL of the recorded pid and start time, confirmed gone; `enter-pending` watch; P15 | Duty stays held |
| Pending duty | Marker `owed` or `executing` | A guard can still act | Same boot and session, within deadline, fresh heartbeat | Stops blocking, reports `relock-failed` |
| Relock duty | Guard acknowledged | Guard will act | Its heartbeat, answered at each 10 s renewal; P12 | Replacement guard; no password until acknowledged |
| Duty closed unneeded | Console or session differs | Someone else is there | Positive reading, never an unreadable one | Retry, then `relock-failed` |
| Partial field cleared | Escape sent | Field empty | P14 proof; no live read exists | Keys stay blocked |
| Helper identity | Digest matches pointer | The granted binary runs | Real probe of that binary | Locked features off |
| Target identity | Key matches the pin | This Mac | Target signature over the channel keys | Sheet refused |
| Password not stored | No storage code | Absent from disk and logs | Fixture password scanned across logs, audit, dumps | Fail the test |
| Disable | Verb acknowledged | Grants refused | Refused test grant in status | Report unconfirmed |
| Chime | Played call | Audible | Only P8 | Say receipt only |

## Honest limits

- A password typed in a browser can be read by the serving machine and by the tunnel provider. That is why the box is off by default, and "off" binds honest pages only: a hostile front can serve a box anyway, and it also reports the tunnel state that page checks.
- The native app's protection against them starts after this phone first pins this Mac's key. First contact trusts the front.
- This does not stop hostile code running as the user, and the login password also opens the login keychain. The sheet says so once.
- A stolen PIN can watch the lock screen, including notification previews, and press its buttons, including any Restart or Shut Down on it. That can take the Mac offline. The PIN alone cannot unlock it.
- A stolen PIN can spend the 6-per-day password attempts, which locks out the path for that day.
- A retained helper can lag fixes until it is regranted. Status shows its age.
- On a Mac with several agents, each agent's PIN can enable access for that agent, so the weakest PIN sets the reach to the shield. The password is still the barrier.
- If the server and the guard both die with no supervisor restart, an owed relock waits until the server next boots. If the user switches away first, the duty closes with no lock call, and macOS's own setting decides what the return asks for.
- A submission that unlocks more than 10 s after Enter could outlast the guard's watch. P15 measures it.
- An unlock's cause is inferred from timing.
- Password typing is not atomic with its checks.
- No indicator over the shield. A person at the Mac sees the pointer move; the chime is a signal, not prevention.
- `CGSSessionScreenIsLocked`, `kCGSSessionSecureInputPID` and `SACLockScreenImmediate` are undocumented and may change.
- A Mac at the login window after a restart stays unreachable, with or without this.

## Open questions

*(none)*
