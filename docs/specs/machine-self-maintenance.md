---
title: "Machine self-maintenance: scheduled and wedge-triggered restarts, browser and window care, honest lock reading"
slug: "machine-self-maintenance"
author: "echo"
convergence-status: "failed-at-cap: round 6 of 6 raised safety and data-loss design findings; fixes applied after round 6 are unreviewed; see docs/specs/reports/machine-self-maintenance-convergence.md"
eli16-overview: "docs/specs/machine-self-maintenance.eli16.md"
parent-principle: "The Agent Is Always Reachable"
parent-principle-fit: "An agent that cannot be reached because its machine has quietly wedged is unreachable however healthy its server looks. This gives the agent the means to bring its own machine back to a clean state, inside the capacity and principal floors."
lessons-engaged: >
  Structure > Willpower (restart cadence, browser close-out and the boot-loop brake are code, not
  reminders); Capacity Safety (one registered, enforcing self-action class, a durable ledger written
  before actuation, a proven bound under sustained wedge pressure); Know Your Principal (the machine
  owner's tap, bound to a verified principal, is the only thing that enrols a machine); Self-Unblock
  rung floor (capability is not authority: NOPASSWD sudo on the Studio does not excuse enrolment);
  Self-Heal Before Notify; Verify the State, Not Its Symbol (the lock flag incident); Judgment Within
  Floors (wedge decision); Migration Parity; Agent Awareness; Live-User-Channel Proof; Single-provider
  functional floor (no second model required); test-agent-leak-guard (throwaways and test processes
  must never reach a real restart).
---

# Machine self-maintenance

## Problem statement

Justin, 2026-11-01: "we need to do a better job of managing the various apps/browsers that are used on
any particular machine" and "we need a regular, automated cadence of restarting machines ... clears
out stuck processes and issues and provides a clean starting point ... THIS IS CRITICAL and needs to
be a built in part of an Instar agents ability to maintain its own machines".

**Incident (2026-11-01).** The Mac Studio could not be reached with AnyDesk. Instar's desktop
diagnostics reported `screenLocked:true`, read from the `CGSSessionScreenIsLocked` session flag
(`src/native/remote-desktop/macos/InstarDesktopHost.swift`, the `probe` case and `activeSession()`).
At the machine, a keypress dismissed a screensaver with no password. The screen was littered with
browser windows and macOS popups, including "The application can't be opened. -600" whose OK button
did nothing. AnyDesk still failed after he got in. Only a restart fixed it, after much clicking,
force-quitting and retries; no power button was needed.

**What is measured and what is not.** The cause of the wedge and the cause of the wrong locked
reading are NOT measured. Agent automation having left many windows open is a hypothesis: there are
14 Chrome profiles under `.instar/state/playwright-profiles`, `chrome-launch.sh` has no close step,
and nothing tracks what it opened. Nothing in this spec depends on that hypothesis being true.

Facts measured for this spec with read-only probes, 2026-11-01:

| Machine | Measured |
|---|---|
| Mac Studio | macOS 26.5.2. FileVault off. `autoLoginUser` set. `fdesetup supportsauthrestart` true. `sudo -n -l` lists `(ALL) NOPASSWD: ALL` (verified, via `/etc/sudoers.d/echo-agent`). `#includedir /private/etc/sudoers.d` active. One human console user. Host carries agents echo, groky, sagemind, dash-door under one login. `sysadminctl -screenLock status` says `screenLock is off` (read after the restart; it says nothing about the setting during the incident). |
| Mac Mini | `screenLocked:true`, `sessionActive:false`, no screen or input permission. FileVault and auto-login not read: reachable only over its HTTP API, and a remote session is more than a read. |
| Laptop | `screenLocked:false`, screen permission false, input inherited. Load verdict `saturated` at probe time. FileVault and auto-login not read. Carries ai-guy, echo, indra-instar, codey, inspec, plus `dawn-*` and `sagemind-*` tmux sessions (2026-10-04 note). |
| Mama PC | Windows host, agent in WSL. Desktop diagnostics `ready`. BitLocker and AutoAdminLogon not read. |
| Mac M5 Pro | Shared SageMind compute, lower priority. Not probed beyond the pool row, deliberately. Treated as someone else's machine. |

Existing gaps: no code anywhere reboots a machine (no `shutdown`, `reboot` or `sudoers` in `src/`);
`/etc/sudoers.d/instar-*` files on the Studio were installed by hand; nothing records opened browsers.

## Goals and non-goals

Goals: a machine an agent maintains gets a clean start on a cadence and when it wedges, comes back
provably, and is not littered by the agent. The recovery guarantee is exact, not "no work lost":
conversations resume on their next message, queued Local Verify work resumes, and state-file autonomous runs get a durable, bounded revival attempt, with the owner told if it does not land; a tool call in flight,
an unsaved process's memory and anything not Instar's are ended by a restart, so a restart that would
end identifiable work with no resume path never happens automatically. "Identifiable" is a real limit: an ordinary app with unsaved changes cannot be detected, and the enrolment card says so. Instar works on Mac and Linux at minimum;
Windows-with-WSL is covered because Mama PC is real.

Non-goals: diagnosing the 2026-11-01 root cause; managing the operator's own apps; any hardware
watchdog or smart plug (recorded under Honest limits); changing FileVault or auto-login on anyone's
behalf; applying OS updates.

## Proposed design

Five parts, independently shippable, in the build order of the Maturation plan:

- **Part A** Honest lock reading.
- **Part B** Browser and window care.
- **Part C** Machine enrolment and the reboot privilege.
- **Part D** Scheduled restart.
- **Part E** Wedge-triggered restart.

One host-level state file, one actuator, one ledger. New modules: `LockStateReader`,
`BrowserInstanceLedger`, `HostMaintenanceStore`, `RestartActuator`, `MachineMaintenanceController`,
`PostRestartProof`, `WedgeMonitor`, `StuckDialogProbe`.

### Part A: honest lock reading

`CGSSessionScreenIsLocked` stays as one input and stops being the answer. The helper's `probe` adds
fields; callers read a single derived `lockState`:

| `lockState` | Meaning |
|---|---|
| `unlocked` | Session on console, flag false, no lock shield seen. |
| `locked` | Flag true, a password is required immediately, and the lock shield is seen. |
| `screensaver-or-display-sleep` | Screensaver process running or displays asleep, and no password requirement is in force. Input dismisses it. |
| `unknown` | Evidence conflicts or a source is unreadable. |

Inputs, each reported separately beside the verdict:

1. `flagLocked`: the session flag.
2. `passwordRequired`: `sysadminctl -screenLock status` (`off`, `immediate`, or a delay in seconds), read from stderr where it prints, bounded to 3 s. Unreadable means `null`.
3. `screensaverRunning`: `ScreenSaverEngine` or `legacyScreenSaver` in the process table.
4. `displayAsleep`: `CGDisplayIsAsleep` on the main display.
5. `lockShieldSeen`: `CGWindowListCopyWindowInfo` returns a window owned by `loginwindow` at or above the shielding window level. Needs no Screen Recording grant for owner and level.
6. `lockEvent`: the last `com.apple.screenIsLocked` / `screenIsUnlocked` distributed notification with its age, observed only while a long-lived helper runs (the `indicator`); absent otherwise.

Decision, first matching row wins:

| # | Evidence | `lockState` |
|---|---|---|
| 1 | No console session, or `loginDone` false, or a source above is needed and unreadable | `unknown` |
| 2 | `lockShieldSeen` and `flagLocked=true` and `passwordRequired` is `immediate` | `locked` |
| 3 | `flagLocked=true`, `passwordRequired=off`, and screensaver or display sleep seen | `screensaver-or-display-sleep` |
| 4 | `flagLocked=false`, no shield, console session present, login done | `unlocked` |
| 5 | Anything else, including `flagLocked=true` under any delayed password policy (no input reads how much of the delay has passed) | `unknown` |

A fresh `lockEvent` is reported beside the verdict and does not change it in v1; L1 decides whether it earns a row.

Consequences:

- `sessionActive` and `activeSession()` no longer refuse on the flag alone. `locked` refuses. `unknown` and `screensaver-or-display-sleep` attempt the real capture, because the attempt is the deciding evidence for capture; a capture failure returns its own reason. A frame proves capture works, not that input reaches an authenticated desktop: input stays gated as today on its own permission and on the existing grant flow.
- `/desktop/diagnostics` keeps `screenLocked` for one release for old dashboards, adds `lockState` and the inputs, and the readiness reason says "screensaver or sleeping display" or "lock state unknown", never "locked" unless `locked`.
- Linux has no such session here: `lockState: "not-applicable"`. Windows companion reports `unknown` until it reads its own session.

**Test on a real Mac** (Live proof L1, run on the Studio, which has screen and input grants. The Mac Mini, whose flag reads true now, joins only if it is granted those permissions; without them a capture cannot settle a row): capture the inputs and a real frame in each of eight states: awake unlocked; screensaver with password off; screensaver with password immediate; screensaver within a 60 s grace delay; display sleep with password off; display sleep with password immediate; locked by the lock command; login window after fast user switch. The expected row is written before the run. A row is settled only by a real capture and a real input attempt through the Instar desktop path, because that is the deciding test. Password settings are NOT changed on a shared machine for this: the two password-on rows that need a setting change run on a throwaway macOS user or a VM, or stay recorded as unproven in the report, and the verdict for an unproven row stays `unknown`.

### Part B: browser and window care

**Ledger.** `BrowserInstanceLedger` is one small file per instance at `.instar/state/browser-instances/<hash of user-data-dir>.json`: `{ userDataDir, pid, processStartTime, agent, sessionName, topicId, purpose, openedAt, lastUsedAt, ttlMinutes }`. Identity is the pair (pid, process start time), so pid reuse cannot aim a close at the wrong process.

**Helpers change.**

- `chrome-launch.sh` writes the ledger entry, stamped from `INSTAR_SESSION_ID` and new optional `--purpose` and `--ttl-minutes` (a long scheduled browser action declares its own lifetime). It enforces the cap below before opening.
- New `chrome-close.sh <profile>`: exact `--user-data-dir=` match, the same jail as launch, SIGTERM to the main pid, SIGKILL after 10 s, removes the entry.
- `chrome-js.sh` and `chrome-mainworld.sh` touch `lastUsedAt`.
- `ndrive.sh` on Windows gains `closebrowser`, implemented in the wrapper only, against the pid in the per-agent binding file. `native-drive.ps1` is hash-pinned and is not edited. The ledger, sweep and cap are `not-covered` on Windows in v1: WSL cannot see Windows Chrome in its process table, so the ownership rule cannot hold there.
- The `/normal-chrome-browser` skill gains one rule: close what you opened with `chrome-close.sh` when the task ends.

**Who may be closed.** Only an instance that is both (a) in this agent's ledger, or adopted, and (b) whose live process carries a `--user-data-dir` inside this agent's own `.instar/state/playwright-profiles/`, or a `relogin-chrome-profile-*` directory recorded by `PlainChromeReloginBrowser`. Adoption: at sweep start, a running Chrome matching (b) with no entry gets one with `openedAt` and `lastUsedAt` = now and `purpose: adopted`. The operator's own Chrome has no such flag and can never match. `$HOME/Library/Application Support/Google/Chrome` is refused as the launch helper already refuses it.

**Excluded from any close:** a profile held by the Telegram browser broker; a profile under a `PlaywrightSeatLease`; a profile in a live sign-in repair episode; any instance whose window is frontmost while the operator was active in the last 5 minutes.

**Sweep.** Every 15 minutes, server-side, no model, no session. Closes an instance when its owning session is gone and `lastUsedAt` is older than 30 minutes, or `lastUsedAt` is older than its `ttlMinutes` (default 120). Audit: `logs/browser-care.jsonl`, paths only. Ships dry-run: 7 days of would-close rows on the development agent before it acts.

**Cap.** Default 4 per agent, 8 per host (host count read from `~/.instar/host-browser-instances/`, one marker file per instance). At the cap, `chrome-launch.sh` closes this agent's oldest eligible idle instance through the same enforcement gate as the sweep; if none is eligible, or while `browserCare.dryRun` is on, it records the proposed close and refuses with a named error listing what is open. An existing Playwright Chromium counts toward the host total as read-only evidence and is never closed by this sweep (`McpIdleOffloadSweep` owns it).

**Stuck system dialogs (macOS).** `StuckDialogProbe` runs in the packaged helper every 10 minutes and only reports: owner, age, and button count where Accessibility allows (otherwise `null`). A window present for 30 minutes proves it is unattended, not stuck, so presence is never a reason to act.

Action happens only as rung 2 of a confirmed wedge ladder (Part E), operator idle 5 minutes or more, with Accessibility granted:

- In range: a positive pattern list, matched locally. v1 holds one entry: a one-button alert owned by `CoreServicesUIAgent` whose text matches "can't be opened" with a numeric error code, the 2026-11-01 class.
- Everything else is report-only. `SecurityAgent`, TCC, Gatekeeper and quarantine prompts, install prompts, any password or Allow prompt, and any window with more than one button are never touched. An instar agent never answers a permission prompt on anyone's behalf.
- The action is an AX press of that one button, without taking focus, then a re-list. A window surviving a press is what "stuck" means, and only then is it F3 evidence.
- Terminating `CoreServicesUIAgent` (launchd restarts it) requires that every window it owns is in the pattern list, since it would discard them all.
- Without Accessibility it reports `dismissal: unavailable-no-permission`.
- Dialog text stays on the machine and goes to no model and no notice. Audit records owner, age and outcome only.

Linux has no equivalent; Windows is not covered in v1 and reports `not-covered`.

### Part C: enrolment and the reboot privilege

**On by default, one tap per machine.** The capability ships on, and nothing can restart until the machine's owner has tapped once for that machine. That tap ends this feature's first build run: everything needing it is a later run (see Maturation plan). A reboot interrupts every user of a machine, so the Self-Unblock rung floor applies: minimum rung is one approval, even where sudo already works (the Studio).

Enrolment state lives at `~/.instar/host-maintenance/enrolment.json` (host-level, shared by all agents of this login): `{ machineId, maintainerAgent, mode, enrolledAt, principal, proofOfTap, ruleInstalled, readiness, acknowledgedAgents }`.

**The tap and what it proves.** A "Machine care" card on the dashboard, one row per pool machine. The tap needs a fresh dashboard unlock AND must come from the enrolling agent's verified operator: the server sends a one-time Approve button to that operator's bound topic and enrols on that authenticated press, and enrolment is refused until the lifeline ingress guard is armed, so forging that press takes deliberately reading a protected file, not just the PIN. All of this runs as one OS user, so it is cooperative (Honest limits). A remote row is relayed as a signed, action-bound mandate like `repair-cell`; a mandate proves the relaying machine, and the Approve press is what proves the person. This shows the agent's operator chose this. It cannot prove legal ownership of a machine, so the card asks and the record says "stated by".

Telegram offers enrolment ONE time per machine, as one attention item with the direct link. It offers again only on new facts: a new machine, or a readiness change. The card stays available regardless. The card says plainly: "I will restart this machine about once a week in the small hours when nothing is running, and if it wedges. This interrupts everyone using it. I can't see unsaved changes in ordinary apps, so anything left open and unsaved here may be lost." It names the non-Instar apps open now, and the tap acknowledges that text.

**Co-resident agents and their people.** Every instar agent on the host writes `consents/<agent>.json` with a hash of its verified operator's uid. An agent whose hash differs from the enrolling operator's blocks unattended mode until its own operator taps on its own dashboard; agents with the same hash are covered; an older agent with no record is named on the card and listed in `acknowledgedAgents` when the owner taps past it. First enrolment takes the maintainer role by `reserve()` below.

**Refusals before the tap is offered:**

| Condition | Result |
|---|---|
| Host marker `~/.instar/host-maintenance/do-not-maintain.json` present (readable by every agent on the host; set per machine from the card, never at build) | Not offered to any agent. `refused: not-owned`. |
| Agent is on a machine named in its own `machineMaintenance.ownershipByMachine` as `shared` | Same. |
| Another human is on the machine (`who` shows a different user on console, tty or SSH, or processes under another uid ≥ 501 with a tty) | Not offered until gone, `refused: other-user-active`. Also an Absolute blocker at every restart, re-read at actuation. |
| Throwaway agent (`throwawayAgent` record or temp-folder), or a test process | `refused: throwaway`, always. Honoured by `RestartActuator` too. |
| Agent in a container or a remote VM it does not administer | `refused: not-owned`. |

An unknown machine is never assumed owned. The tap is the owner's statement, recorded with the verified principal. The card repeats any co-resident agents and tmux sessions it sees so the owner decides with facts.

**Readiness probe** decides `mode`:

| OS | Unattended requires | Otherwise |
|---|---|---|
| macOS | `fdesetup status` off, AND `autoLoginUser` equals the agent's user, AND each agent's LaunchAgent is installed and `RunAtLoad` | `attended` |
| Linux | Root not on an encrypted volume (`lsblk` shows no `crypt` ancestor of `/`), AND `loginctl show-user` Linger=yes, AND the systemd user unit is enabled | `attended` |
| Windows + WSL | Not available in v1: `installAutoStart` covers darwin and systemd only, so nothing starts the agent after a Windows boot | `attended` |

Any autostart found missing is repaired with `installAutoStart` unless `autostart.autoInstall:false`, in which case it is named on the card.

**FileVault-on and no-auto-login machines are refused unattended restart.** Those machines would sit at a login screen with the agent dark, because `ai.instar.*` are LaunchAgents and start only after login. `fdesetup authrestart` is deliberately not used: it needs the password or recovery key each time, and storing either is out. Refusal is never silent. The card shows one plain step, and only the setting that is missing:

- Auto-login off, FileVault off: "On this Mac: System Settings, Users & Groups, Automatically log in as, choose your name." One line; the operator can do it over the desktop link from a phone.
- FileVault on: "This Mac asks for your password before it starts, so it can't come back by itself. That is a good setting for a laptop and I recommend keeping it. I'll remind you to restart it instead."

`attended` mode: the machine is never restarted by itself. At 14 days of uptime, one attention item: "Laptop has been up 14 days. Restart when you're near it" with a Restart-now tap (operator session, runs Part D's quiesce). The re-check happens on boot and at each due evaluation; a setting changed later upgrades the mode after a proving restart.

**The privilege, per OS.** AppleScript `restart`, `osascript` and any path through `loginwindow` are not used because a hung app can veto or hang them.

| OS | Rung 1 (orderly) | Rung 2 (forced) | Privilege |
|---|---|---|---|
| macOS | `sudo -n /sbin/shutdown -r now` | `sudo -n /sbin/reboot -q` | `/etc/sudoers.d/instar-reboot` |
| Linux | `sudo -n /usr/bin/systemctl reboot` | `sudo -n /usr/bin/systemctl reboot --force`, then `--force --force` | `/etc/sudoers.d/instar-reboot` |
| Windows + WSL | `/mnt/c/Windows/System32/shutdown.exe /r /t 30` | `shutdown.exe /r /f /t 0` | None installed. Checked by reading `SeShutdownPrivilege` from `whoami.exe /priv`. |

The rule is exactly: `<user> ALL=(root) NOPASSWD: /sbin/shutdown -r now, /sbin/reboot -q` (Linux: the three exact systemctl command lines, paths resolved at install). sudoers matches arguments exactly, so the rule grants reboot and nothing else. (The Studio's separate `NOPASSWD: ALL` is broader and predates this; the rule is installed there too, so the feature does not rely on it.) No wrapper script exists, so there is nothing to swap. A WSL `reboot` restarts only the VM, so WSL is detected with `isWslHost` and always routes to the Windows path.

**Installing it once.**

One root step does the whole install, so no same-user process can swap a validated file: `sudo sh -c '...' _ "<rule text>"` writes the rule (not secret, so argv is fine) into a fresh root-owned staging directory on the same filesystem, runs `visudo -cf` on that copy, sets root ownership and mode 0440, and renames it into `/etc/sudoers.d/instar-reboot`. It ends with `sudo -k`. The installed bytes are then hashed and compared.

1. If `sudo -n true` succeeds (Studio), the tap is the whole step.
2. macOS otherwise: Instar never sees the password. The same root step runs through macOS's own administrator dialog (`osascript` `do shell script ... with administrator privileges`, the one use of AppleScript here, at install only). It first checks that a console session exists. The card says "A Mac password box is waiting on the Mini's screen" with the direct desktop link, so the operator answers it at the machine or, where a desktop path works, from a phone. With no usable console session, or no desktop path, the card says this one step needs a person at the machine. Timeout or cancel leaves the machine unenrolled, and the card can try again.
3. Linux without passwordless sudo: `refused: needs-admin`. A headless Linux box has no system dialog, and Instar neither handles passwords nor hands the operator a command, so this machine stays unenrolled, the card says why in one line, and it gets uptime reminders only. Setting up an Instar Linux machine with passwordless sudo is the supported path. No Linux machine is in Echo's pool today.

The byte comparison plus `sudo -n -l` proving the exact line is the only pass. `instar nuke` and the card's Remove action remove the file (on a machine without broader sudo, Remove takes the same one-time drop); turning the feature off does not need the file removed, because the actuator refuses first.

**Proving restart.** A restart can only be proven by a test, so `unattended` is earned. After enrolment the mode is `proving`. The first restart runs like a scheduled one and its `PostRestartProof` must pass, including auto-login and agents returning unaided. It runs through `forcedDueAt`, since a machine under 7 days of uptime is not otherwise due. Pass → `unattended`. Fail → `attended` plus an attention item. On a pool machine it runs in the next window and a peer watches for its return. On a machine with no peer it runs only when the operator taps "Restart now", so someone is around if it does not come back.

**Hand-run reboots.** A session can run the sudo rule directly. The awareness card says not to. It is detected, not blocked (a word-matching guard here would hold blocking authority on a brittle signal): at every boot the maintainer compares OS boot time with the ledger, attributes an unexplained reboot as `unattributed`, counts it toward the brakes, and raises one item when two occur in 7 days.

### Part D: scheduled restart

**Cadence.** Due when `now - lastBootAt ≥ 7 days` (configurable 5–30), or when `forcedDueAt` is set (Part E). `forcedDueAt` clears on any boot or on the operator's dismissal. `lastBootAt` comes from the OS (`kern.boottime`, `/proc/uptime`, Windows `LastBootUpTime`), so any restart, for whatever reason, resets the clock and there is no extra weekly restart after a power cut.

**Window.** 03:00–06:00 machine-local, per machine (`machineMaintenance.window`). Per-machine override is on the card. If a laptop sleeps through it, the next window applies.

**Host maintainer.** On a shared login, only the maintainer agent evaluates, samples wedge evidence, calls the judge and actuates; four co-resident agents do not each spend judge calls. It writes a heartbeat to the host store every 60 s. A heartbeat older than 10 minutes lets any co-resident enrolled agent take over through `reserve()`, so a dead maintainer server does not strand a wedged host. No co-resident agent: the lifeline path below.

**Host store and exclusive authority.** `HostMaintenanceStore` is the only writer of host files, under one host lock, with fsync and rename. `reserve(kind)` is the single transaction every path uses (scheduled, wedge, operator, lifeline): under the lock it checks the brakes, opens one episode with budget consumed, and commits before returning. A second automatic request joins the open episode and gets no authority to actuate. An operator request (card or lifeline) bumps `generation` and takes the episode over, so a server that died mid-quiesce cannot keep the owner waiting for `expiresAt`. Maintainer takeover bumps a `generation`. Immediately before each privileged command the caller runs `claimRung(generation, rung)`, atomic under the lock: it fails on a stale generation, an expired plan, or a rung already claimed. Every plan write and cleanup carries the generation and is refused when stale, so a stale controller's abort path cannot undo an operator's takeover. A plan's expiry invalidates its authority. `claimRung` keeps the host lock through spawning the command, and takeover and reopen take the same lock, so they serialize with dispatch. A process frozen between claim and spawn past the lock's staleness bound is the remaining gap (Honest limits); its only effect is one extra counted restart. Host-relative writes get a new arm in `WriteDomainRegistry`, whose direct-write entries are agent-root-relative today.

**State machine,** persisted in `~/.instar/host-maintenance/plan.json` before every transition: `idle → due → deferring → notified → quiescing → armed → actuating → (boot) → verifying → done | proof-failed`. Every plan carries `expiresAt` (90 minutes after `notified`, extended once at `armed` to cover the rung 2 wait). Every server checks it on its 60 s tick; an expired or malformed plan is ignored and that server reopens independently of the maintainer.

**Idle gate.** In `due`/`deferring`, evaluated every 5 minutes inside the window. Blockers:

| Blocker | Class |
|---|---|
| Operator present: HID idle under 15 min (`HIDIdleTime` via `ioreg`, discounting Instar's own driver activity from its audit log; Windows via companion; Linux headless by tty activity), a live desktop grant, a live AnyDesk connection, or an operator message on any topic here in 30 min | Absolute |
| Another human on console, tty or SSH | Absolute; only the owner's Restart now passes it, and the card names who is on |
| Operator hold, off switch, `proof-failed` latch, restart brake, mode not unattended/proving | Absolute |
| On battery under 50% | Absolute |
| Work with no resume path: live subagent, background shell, a session with no topic or job identity, foreign tmux session with CPU, other OS user's processes, Live test harness, a co-resident `busy` ack with `busyClass: unrecoverable`, a live autonomous run while this agent's resume queue is off or disabled (past the ceiling) | Absolute; at the ceiling, one item asks "Restart anyway" or "Leave it" |
| Update or migration in progress | Absolute (self-limiting) |
| Actively producing session with a topic (`UpdateGate.getBlockingSessions`, read-only): its conversation resumes, its in-flight turn is re-injected | Recoverable |
| Live autonomous run, `/build` session, Local Verify run, co-resident `busy` with `busyClass: recoverable` | Recoverable |
| Serving lease cannot hand off; another pool machine holds the claim | Recoverable (claim conflict stays blocking through the ceiling) |

**Hard ceiling.** Recoverable blockers defer at most `maxDeferralDays` (default 3) past due. In **ceiling mode**, recoverable blockers stop blocking in the next window. Ceiling restarts stay inside the window, because that is what the card promises. Absolute blockers still hold, and none is automatic forever: operator presence and updates end by themselves; unrecoverable work reaches a human through the one item; a hold is bounded to 72 h per tap, and at 14 days overdue one item asks whether to turn it off for this machine. So automatic deferral is bounded, and the only unbounded delay is a person's recorded choice. An automatic restart never ends work with no resume path.

**One machine at a time, best effort.** No coordinator and no consensus: this is staggering, not mutual exclusion. A rare delayed message can restart two machines together; that costs a few minutes of reduced cover and is cheaper than a grant protocol, which is not built. Before `notified`, the machine sends a signed `maintenance-claim` mesh command to every online pool peer, carrying `(claimedAt, machineId)`. A peer answers `ok`, or `conflict` when it holds an earlier claim (ties go to the lower machineId) or finished a restart less than 30 minutes ago, or has not yet passed proof. Any `conflict` defers. An unreachable peer does not block, and its absence is recorded. An older peer's unknown-command answer is recorded and does not block. Lease holder goes last: a new `maintenanceDue` field in the presence advert lets the holder see a due non-holder and wait one hour. The command needs the `MeshCommand` union, the `MeshRpc.ts` classification and a dispatcher handler. If several are due, the window fits them in sequence and the rest roll to the next night.

Pools overlap on one host (ai-guy's pool is not Echo's). Pools are per-agent, and the actual restart is per-host, so the claim is per-pool and the plan file is per-host. Co-resident agents in other pools see the plan through the host file and each makes its own lease handoff.

**Co-resident agents.** Every instar server on the host reads `plan.json` on a 60 s tick (a local file, no token). At `notified`, `MaintenanceGate` closes first, then the maintainer writes a census of running agents into the plan from `~/.instar/registry.json`, filtering `-lifeline` entries, because a graceful shutdown unregisters an agent and the registry cannot answer "who was running" after boot. Each writes `acks/<agent>.json`: `{ episodeId, generation, bootTime, state: ready|busy|enqueued, busyClass, reason, until, leaseHandedOff, version, at }`. An ack, snapshot or receipt whose episode, generation or boot differs from the plan's is ignored, so a replacement plan cannot be satisfied by an old file. Each agent then runs its own quiesce. A server starting during the episode joins it by reading the plan, and the census is reconciled against running agents at `armed`. A running agent with no ack by the deadline (older version, hung) means its work is unknown, and a returning server does not prove work recovered. It is a recoverable blocker until the ceiling, then an Absolute one reaching the owner through the one item. In its own pool, each co-resident agent sends a `maintenance-claim` too; a `conflict` makes it ack `busy`, `busyClass: recoverable`, so overlapping pools stay one-at-a-time with no new mechanism.

**Quiesce.** `notified` is 30 minutes before; ceiling mode is 60 minutes. Notice is timed so actuation falls inside the window; a plan that would miss it rolls to the next night. Each agent, at `quiescing`:

1. Keeps new automatic work refused, from `notified` on, through a new host-level `MaintenanceGate`, consulted at the same chokepoints as `WorkAdmission` (scheduler, spawn admission) but independent of it, because `WorkAdmission` forces open when disabled and may be dark. The recovery slot stays open to an operator session, and an operator-started session cancels a non-ceiling plan.
2. Pool agents: if holding the serving lease, runs a planned handoff. `HandoffSentinel.initiate()` gains a `target` argument with a real selector (online, direct contact under 2 minutes, `loadVerdict` ok), because `HandoffWireTransport.peer` today returns the first registry machine with a URL. It never yields without a verified ack. Three failed tries are a recoverable blocker. With no handoff transport wired, or in ceiling mode after one more failed day, the restart proceeds and the lease moves by TTL expiry as it does on any crash.
3. Publishes `plannedRestart: { until }` in the presence advert and a graceful-shutdown announcement, so peers read `stale` with positive evidence, not `unreachable`. Inbound custody during the restart is what the machine already has. The holder answers a message for this machine's topics, ONE fixed line per topic per restart, sent directly with `telegram.sendToTopic` (not through the owner-dark ladder, which is journal-only until enforced), worded from real custody: durable queue live → "That machine is restarting and will be back in a few minutes. I have your message."; queue dark → "That machine is restarting and will be back in a few minutes. I can't hold this one, so please resend it then."
4. Writes `state/planned-restart-snapshot.json`, listing every live session with its topic, and records each in the reap-log (`reason: planned-machine-restart`, `origin: machine-maintenance`) at `armed`.
5. Writes its ack `ready`.

**Actuate.** All acks in, or their deadline passed: re-reads off switch, hold, operator presence, ledger brake, and governor admission. Calls `reserve()`, which commits the ledger row (`~/.instar/host-maintenance/restarts.jsonl`) **before** the call. At `armed`, each agent in the census enqueues its resume entries and writes `state: enqueued`, within 90 s (the plan's tick drops to 10 s while `armed`). Each ack carries per-session receipts. A missing receipt for an agent with a live autonomous run aborts an automatic restart: plan cleared, entries cancelled, retried in the next window, and one item at the second abort. A missing receipt for an ordinary conversation is listed in the proof, since it resumes on its next message. Then the fresh check below, `claimRung`, then Rung 1.

**Fresh check before every privileged dispatch.** Immediately before Rung 1 and again before Rung 2, an automatic path re-reads off switch, hold, operator presence, another human, and unrecoverable work, inside the `claimRung` lock. Any failure aborts that dispatch: before Rung 1 the plan is cleared; before Rung 2 the machine is left to the orderly shutdown already in progress and the operator is told. An operator-initiated dispatch skips this and names what it passes. Still alive after 8 minutes: Rung 2, once. Still alive 5 minutes after Rung 2: `failed-to-restart`, attention item, plan cleared, quiesce undone, this restart's resume entries cancelled, ledger row closed. A `shutdown -r` on macOS and `systemctl reboot` are not vetoed by a hung GUI app the way a `loginwindow` restart is; this is a claim to prove in L3, not assume. The test-process guard: `RestartActuator` refuses unless a reserved episode names this boot and `VITEST`/`CI`/throwaway are absent. It is the only code that holds those command lines, enforced by a lint; it has two callers, the controller and the lifeline path.

**Resume.** After boot, supervisors start servers and lifelines as they do now. Resume uses `ResumeQueue` with a new entry field `kind: planned-restart` (`ResumePriorityClass` is a different axis):

- Entries are enqueued at the last step before actuation, with the resume UUID read then, because the drainer's `validateReality` otherwise marks them `invalidated:live-session-exists` within a minute, and a UUID read earlier goes stale.
- Entries carry `episodeId` and `generation`. `claimRung` writes a durable dispatch record. `nextCandidates()` releases an entry only when that record exists AND OS boot time is newer than `entry.bootTime`, so a held entry neither reaches `validateReality` nor consumes a tick. On plan expiry and at every server start, entries of an episode with no dispatch record are cancelled, so a later unrelated reboot cannot release them.
- `kind: planned-restart` is exempt from `classifyEligibility`'s evidence and origin refusals, from the resurrection tombstone cap (a weekly restart is not a crash loop), and from the queue-level dry-run branch through a per-kind path.
- Committed entries are exempt from overflow eviction. If autonomous-run entries alone would exceed capacity, that agent reports no receipt.
- It is NOT exempt from calm, quota and session-count gates, or one-at-a-time revival: a machine should not stampede at boot. Revival may therefore be slow.
- A paused queue holds these entries; TTL is 24 h. An autonomous-run entry that expires unrevived, or stays pending past 2 hours, raises one item per restart naming the topics; its state file stays on disk. The queue's 50-entry capacity stands. Jobs participate only with `resumeOnReap`, as today. The proof's Sessions row compares `planned-restart-snapshot.json` with the queue, so every session is accounted for by topic: revived, pending, invalidated, expired, overflowed, paused, or never enqueued (queue off or disabled, which returns before any per-kind path).

Conversations also resume on the next inbound message through `--resume`, as today. An autonomous run's state file is on disk, and its entry revives it even where `AutonomousLivenessReconciler` is dark. Spawn verification cannot prove the transcript attached, the existing limit. Interrupted turns get the existing last-unanswered re-injection. Local Verify resumes per `local-verify-survives-restart`.

**Post-restart proof.** `PostRestartProof` runs on the maintainer once its server is up, within 10 minutes of boot:

| Check | Proven by |
|---|---|
| The machine really restarted | OS boot time newer than the ledger row, not the server's own uptime |
| Server | Local authed `/health` 200 |
| Lifeline | Lifeline process proof, `lifeline-proof` fresh this boot |
| Relay | `GET /threadline/health` relay state connected, or `not-applicable` for standby or disabled |
| Tunnel | The tunnel URL fetched **through the tunnel** returns 200, or the tunnel is not configured |
| Desktop | `/desktop/diagnostics` ready, compared with the value before the restart: a machine that was `not-ready` before does not fail on it. Screen permission is compared explicitly because of the 2026-10-31 reboot race on the Laptop |
| Logins | Subscription pool `loginCheck` no worse than before |
| Co-resident agents | Each agent in the plan's census answers `/health` |
| Sessions | Count of `planned-restart` entries revived vs queued (reported; slow revival does not fail proof) |

Each check has a bounded retry (5 attempts over 10 minutes). A check not passing gets its existing self-heal (server or lifeline supervisor restart, `POST /agent-identity/reload`, tunnel restart), one attempt each. A check still failing sets `proof-failed`. From **outside**, a pool peer that saw `plannedRestart` expects the machine's advert back by `until` (default 20 minutes). If it stays dark, that peer raises the item "Mac Studio did not come back after its restart." One-voice: the current lease holder raises it. This is the only check that works if the machine never returns.

**Notices.** Plain, silent, through the existing `🩺 Agent Health` topic, sent by the maintainer only:

- Before: "Restarting Mac Studio at 4:00 for its weekly clean start. Nothing is running. Hold it: <link>"
- After: "Mac Studio restarted and everything came back: server, messaging, tunnel, desktop, 3 sessions resumed."
- Failure is an attention item, not a silent line, naming the failing check in plain words.
- Ceiling mode's before-notice is audible, names the work to be interrupted, and carries Hold.

### Part E: wedge-triggered restart

**Evidence families.** Sampled every 10 minutes, and every 2 minutes once any family is positive. Every probe runs in a child with a hard timeout, single-flight, no `osascript` against apps. A probe that timed out is a completed result of that family, as its row says. The monitor itself not sampling is missing, not a result.

| Family | macOS | Linux | Windows + WSL |
|---|---|---|---|
| F1 GUI path | A shipped, signed and notarized no-UI canary app launched through LaunchServices (`open -g -j`), quits at once; a nonzero `open` (e.g. -600) or timeout. Also helper `capture` of one frame failing or blank; 2+ desktop grant failures in 30 min | `systemd-run --user` no-op | `cmd.exe /c exit` timing through interop |
| F2 Process table | Bounded `ps` itself times out; fork failure; uninterruptible-state count rising over 3 samples; `data.kalloc.1024` over 4 GiB from `echo-kmem-watch`-style reading | `ps`; D-state count | `ps` in WSL plus `tasklist` timing |
| F3 Stuck dialog | A pattern-listed dialog survived a press (Part B) | Not applicable | Not covered |
| F4 Agent symptoms | `loadVerdict` `impaired` while CPU idle ≥ 30%; session spawn failures for system reasons in 30 min; event-loop lag with low CPU | Same | Same |

**Eligibility.** F1 counts only on a machine where that same probe has passed since boot, and not while there is no console session or `lockState` is `locked`. The capture half also needs Screen Recording, a non-`unknown` `lockState` and an awake display; the canary half needs neither, so a machine with its display asleep overnight still has F1. So the Mini as measured today contributes no F1 evidence, and the Laptop contributes only the canary. Launch and capture failures are correlated, so they are one family.

**Wedge candidate.** One continuous 20-minute evidence window with at least 3 observations in which the same two families are positive at every observation. A negative observation of either family resets the window. A missing sample neither counts as positive nor resets. Peer reachability is not a family: `pool` rows are this machine's view of its peers, which says nothing about whether peers can reach it. F3 needs a ladder to exist, so it never forms a candidate; it informs the judge and a later episode. **Single-family fallback:** one family positive for 2 hours forms no candidate and calls no judge; it records `forcedDueAt` in the plan for the next window. This is deliberately a scheduled restart brought forward, under the scheduled brake (1 per 5 days) and the full idle gate, so it runs even while `wedgeRestart.dryRun` is true. On an `attended` machine it is the uptime reminder, sent now. Uptime under 6 hours marks the candidate `recently-restarted`, which caps the outcome at notify (a restart that did not help is not repeated).

**Decision.** Detection is signal. A candidate goes to one judge call, `machineWedgeJudge`, on the agent's ordinary intelligence path with the Jev-first cascade where available and the single-provider default otherwise. It runs on the maintainer only. It sees structured evidence only: families, ages, uptime, blockers, sessions count. Never window titles or dialog text. Enrolled in the Decision Quality meter. Bounded action space: `leave | gentle | restart-at-next-idle | restart-now`.

**`restart-now` is earned.** While `wedgeRestart.dryRun` is on, the judge may propose any of the four, recorded only, and those rows are the evidence. Graduation: 14 days of wedge dry-run with no candidate on a machine later confirmed healthy, AND a benchmark of at least 30 labelled fixtures, including healthy-but-unpermissioned and saturated machines, at the meter's rate floors. Grades do not use "canaries cleared after a restart", which a restart nearly always achieves: a restart grades right only when the gentle rungs had already failed and evidence was still present immediately before it, and wrong when evidence cleared during the notice period.

One floor set, for every automatic restart: machine enrolled unattended or proving; `reserve()` admits it (brakes, not `proof-failed`); every Part D Absolute blocker clear; for wedge `restart-now`, operator presence narrows from 15 to 5 minutes. Presence unreadable during a candidate blocks for at most 2 hours, then the operator is told plainly and the agent does not guess. Model unavailable or unparseable: **no forced restart.** The deterministic fallback runs the gentle rungs, then records `forcedDueAt` as above. So the ladder always ends at a defined step.

**Ladder,** each rung verified by re-sampling the positive families for 2 minutes before moving on. A rung whose feature is in dry-run is skipped and recorded:

1. Close instar's own idle browsers and sweep (Part B).
2. Pattern-listed dialogs and the `CoreServicesUIAgent` step (Part B).
3. Restart Instar's own desktop helper, skipped and recorded during a live desktop grant or operator input in the last 5 minutes.
4. Short planned restart: Part D's sequence, with notice 5 minutes, co-resident ack deadline 5 minutes, lease handoff attempted for 3 minutes then TTL.
5. Rung 1 privileged restart.
6. Rung 2 forced restart, once, if the process is still alive after 8 minutes.
7. Operator: attention item saying plainly that the machine needs a hand, and what evidence remains. While wedge restart is in dry-run, a confirmed candidate reaches this at once with no rungs run: the notice is real, carries Restart now, and also records `forcedDueAt`, so a two-family candidate is never treated more weakly than one family.

The judge chooses the entry point: `gentle` runs 1–3. `restart-at-next-idle` runs 1–3, waits up to 2 h for Part D's ordinary idle gate with no ceiling mode, then runs rung 4; if the wait ends unmet it records `forcedDueAt`. `restart-now` runs 1–3 then 4, with recoverable blockers not blocking, outside the window and with the 5-minute notice. Rung 5+ always follow 4. Wedge actions inherit every Part D Absolute blocker and the receipt rule. Quiesce is bounded to 10 minutes in total; at the bound it actuates only if every Absolute blocker is clear and receipts exist, otherwise it aborts and notifies with Restart now, which, being an operator action, actuates. A hung co-resident agent on a wedged machine therefore lands on the owner's tap, not on an automatic restart over unknown work. Rung 6 is the same episode and does not re-run quiesce.

**Operator trigger.** "Restart now" on the card (any machine, relayed by signed mandate, and on `attended` machines too) runs from rung 4 at once. It passes every blocker and brake except `reserve()`'s 6-hour rule, which it may override with a second confirmation, and another human on the machine, which the card names first. It is a human action on the always-allow lane of the governor.

**Lifeline path.** If the server is down but the lifeline is up, `/lifeline restart-machine` actuates rung 5. `handleLifelineCommand` gates nothing on identity today, so this command compares `fromUserId` with the verified operator uid recorded in `enrolment.json`, and refuses if absent. The reply names any other human on the machine, and the command takes effect only on a typed `/lifeline restart-machine confirm` within 2 minutes (button presses are refused while the server is down). It calls `reserve()` and `claimRung` directly, with the same operator semantics as Restart now: the ledger records it, and its reply names any brake it is passing. Quiesce is skipped, so no resume entries are written and autonomous runs get no revival attempt; the reply says so. If the machine is still up 8 minutes later, the lifeline says so and a typed `/lifeline restart-machine force` runs rung 6. Requires an enrolled machine. It reaches only the machine whose lifeline polls Telegram; a standby's lifeline is suppressed, so a wedged standby needs the card.

**Brakes (durable ledger, host-level, enforcing from day one, not observe-only):**

| Brake | Limit |
|---|---|
| Any automatic restart | Not within 6 h of the last boot (except rung 6 of the same episode) |
| Wedge-triggered | 2 per 24 h, 3 per 7 days |
| Scheduled | 1 per 5 days |
| After `proof-failed` | No automatic restart until the proof passes or the operator clears it |
| After a wedge restart whose evidence returns within 6 h | No further automatic restart; attention item says restart did not fix it |
| Governor | New class `machine-restart` in `GOVERNOR_DEFAULT_POLICIES` (`direction: relief`, `resource: hardware-bound`, `failDirection: closed-queue`, mode override `enforce`) and a modelled entry in `SELF_ACTION_CONTROLLERS`. A `queue` outcome is treated as refused at actuation and nothing is retained, because a queued restart must never fire later. `emergencyDisable` passes the class through; the ledger brakes still hold |

A boot loop cannot arise from Instar because each attempt is on disk before it happens and the ledger is checked before actuating. A boot loop from another cause is met by the agent doing nothing but the proof; it is not this feature's to fix. Corrupt or unreadable ledger: automatic restart refused (fail closed) and one attention item. An operator request sets the bad file aside and starts a new ledger, so `reserve()` still commits first.

### Part F: operator controls

Config, read live:

```json
"machineMaintenance": {
  "ownershipByMachine": {},
  "cadenceDays": 7,
  "window": { "start": "03:00", "end": "06:00" },
  "maxDeferralDays": 3,
  "scheduledRestart": { "dryRun": false },
  "wedgeRestart": { "dryRun": true },
  "browserCare": { "enabled": true, "dryRun": true, "maxPerAgent": 4, "maxPerHost": 8, "idleMinutes": 30, "ttlMinutes": 120 },
  "dialogCare": { "enabled": true, "dryRun": true }
}
```

`enabled` is omitted so it resolves through the development-agent gate until Phase 5; `migrateConfig` adds the block without it. Enrolment is the machine's on switch. `enabled:false` is the off switch for the whole feature, re-read immediately before actuation.

Routes: `GET /machine-maintenance` (mode, readiness, last boot, next due, blockers, plan, brakes, last proof, browser counts; `?scope=pool` merges with dark-peer-tolerant `failed` rows), `GET /machine-maintenance/lock-state`, `POST /machine-maintenance/enrol`, `/hold`, `/resume`, `/restart-now`, `/remove`, `/do-not-maintain` (all operator session, remote targets by signed mandate), `POST /machine-maintenance/tick` (Bearer, lease-free, single-flight). All are registered in `WriteDomainRegistry` as machine-local.

Surfaces: the dashboard "Machine care" page, reachable from the console's home, shows one sentence per machine ("Restarts weekly. Last clean start 3 days ago.") with Hold, Restart now, Off. It works on a phone. The iPhone app's fixed read list is unchanged in v1, because adding to it is a wire-contract change; it is recorded as a follow-up. `GET /guards` carries rows for the monitor and sweep.

Migration Parity: `migrateConfig` adds the block with existence checks; `migrateClaudeMd` adds the card with a content-sniff guard; browser scripts ride the existing always-overwrite installer; the existing `/normal-chrome-browser` skill's new close rule uses the hash-gated content migration; where the feature resolves on, the one attention offer fires per machine. On update a fleet agent is dark until Phase 5. Nothing restarts without the tap.

Agent Awareness card (added to `generateClaudeMd`):

> **Machine self-maintenance** — I keep my machines healthy: a clean restart about weekly in the small hours when nothing is running, and if a machine wedges, plus closing browsers I opened. Each machine needs its owner's one tap on the dashboard's Machine care page; a machine I do not own is never restarted, and a machine that would stop at a login screen is never restarted by itself. Read before answering: `curl -H "Authorization: Bearer $AUTH" "http://localhost:4042/machine-maintenance?scope=pool"`. Is the screen really locked? `GET /machine-maintenance/lock-state`, and `unknown` means unknown. Never run a restart or `sudo shutdown` by hand: send the operator the Machine care page. Close what you opened with `chrome-close.sh`. **When to use** (PROACTIVE): the operator says a machine is unreachable, stuck or full of windows → read the status, then offer Restart now; "why did this machine restart?" → read `logs/machine-maintenance.jsonl`; a machine shows `attended` → name the one missing setting.

## Decision points touched

| Decision point | Class | Floor / justification |
|---|---|---|
| May this machine ever be restarted (enrolment) | `invariant` | Owner's verified tap, per machine. Irreversible-to-others action, rung floor 1. |
| Unattended vs attended (readiness) | `invariant` | A machine with FileVault on or no auto-login physically cannot return unaided. Unknown means attended. |
| Refuse: throwaway, not owned, other user | `invariant` | Safety property with no competing signal. |
| Restart count brakes, proof-failed latch | `invariant` | Capacity Safety convergence bound. |
| Absolute blockers | `invariant` | Operator or another human present, hold, off, battery, work with no resume path. A human always wins, and unrecoverable work is not the system's to weigh. |
| Is this the right time (recoverable blockers, ceiling) | `judgment-candidate`, exempted | Competing signals: real work vs overdue. Argued exemption: the ceiling only overrides work with a named resume path, inside the promised window, after 3 days of deferral. A wrong call costs one interrupted, resumable turn; a judge here would add a model dependency to the routine path with nothing left to protect. Floor: blocker table; default: defer; end rung: operator item. |
| Is this machine wedged and what to do | `judgment-candidate` | Floor: two-family, 3-sample, 20-minute gate; bounded action space of 4; conservative default `leave`/`gentle`; arbiter `machineWedgeJudge`; ladder ends at deterministic fallback (gentle rungs + next-window restart) then operator. |
| `lockState` verdict | `invariant` | Deterministic table; conflict returns `unknown`. |
| Should this browser close | `invariant` | Ownership proof plus idle rule. Only instar-opened instances are in range; a wrong close costs a relaunch. |
| Dismiss this dialog | `invariant` | Positive pattern list, inside a confirmed wedge only, one-button alerts only; never a permission prompt. Everything else is report-only. |
| `MaintenanceGate` refuses automatic work | `invariant` | Bounded by plan `expiresAt`, checked by every server. |
| Pool `maintenance-claim` admit | `invariant` | Earliest claim wins, ties to lower machineId; a mechanical mutual exclusion with no competing signals. |

## Verify the State, Not Its Symbol

| Detector / gate | Symbol | Claimed state | Independent corroboration | Unmeasurable |
|---|---|---|---|---|
| `lockState: locked` | Session flag | A password is really needed to use the screen | Password policy reading plus loginwindow shield; a real capture attempt settles it | `unknown`; capture is attempted, no refusal on the flag |
| Restarted | Server started | The OS actually rebooted | OS boot time newer than the ledger row | `proof-failed` |
| Came back | Local `/health` 200 | Reachable by the operator | Tunnel URL fetched through the tunnel; peer sees the advert | Check marked `unknown`, proof not passed |
| Peer watch | Advert absent | Machine failed to return | Past `plannedRestart.until`, all ropes down | `unknown` raises the item, the safe side |
| Wedge candidate | Canary or capture failure | Machine's GUI or process path is unusable | A second, causally different family in the same 20-minute window; the probe passed here earlier this boot | A hung or missing sample is unknown, neither positive nor a reset |
| Stuck dialog (F3) | Window survives a press | The dialog cannot be cleared | The press happened and the re-list saw the same window | `unavailable-no-permission`, never evidence |
| Dialog in range | Local pattern and button count | A harmless launch-failure alert | Owner process, one button only | Report-only |
| Idle gate: operator absent | HID idle time | Nobody at the machine | Live desktop grant, AnyDesk connection, recent message, Instar's own driver audit | Unreadable means present; during a candidate, for at most 2 h |
| Unattributed reboot | Boot time with no ledger row | A restart not made by this feature | Ledger under lock | Treated as unattributed |
| Operator absent on Linux headless | No last-input reading | Same | Logged-in tty sessions | No tty means absent; a tty with activity under 15 min means present |
| Owned browser | `--user-data-dir` in jail | Instar opened it | Ledger entry with (pid, start time), or adoption rule | Not closed |
| Auto-login set | `autoLoginUser` value | Machine returns unaided | Proving restart | `attended` |
| FileVault off | `fdesetup status` | No pre-boot password | Proving restart | `attended` |
| Reboot grant installed | `sudo -n -l` exact line | The command will run and nothing broader was installed | Hash of installed bytes; proving restart | Not enrolled |
| Operator chose this | Approve press from bound operator | The person answerable for the agent agreed | Fresh dashboard unlock; authenticated sender | Not enrolled |
| Peer `ok` on claim | Signed reply | No concurrent restart known to that peer | Plan state in the same reply | Unreachable peer recorded; overlap is possible and accepted |

## Self-Heal Before Notify fields

**WedgeMonitor.** Class: `recoverable`, except while no healing rung can act (dry-run), when a confirmed candidate notifies directly, because there is nothing to wait for and pretending otherwise would be a no-op heal. Self-heal and `remediation-actions`: rung 1 close owned browsers (idempotent, by identity), rung 2 pattern-listed AX press and `CoreServicesUIAgent` restart (re-listed; launchd restores), rung 3 helper restart, rungs 4–6 privileged restart (idempotent through the `reserve()` episode). Compensation: rungs 1–3 restore by relaunch; a restart cannot be compensated, so it is bounded by the brakes. Brakes: `max-attempts: 1 ladder per episode`; `max-wall-clock: 30m to rung 4` for `gentle` and fallback, `10m` for `restart-now`; `backoff: 2m verification between rungs`; `dedupe-key: machineId + episode`; `breaker: 3 candidates in 24h reclassify critical and notify`, flapping included; `max-notification-latency: 300s` measured from gentle rungs exhausted, and rung 4's own notice covers `restart-now`; `audit-location: logs/machine-maintenance.jsonl` (metadata only).

**PostRestartProof.** Class: critical for the machine not returning (the peer notifies past `until`, no heal-gate) and for a failed check after its bound. Self-heal and `remediation-actions`: one restart per failing component through its existing supervisor (server, lifeline, tunnel), `POST /agent-identity/reload` for relay identity. Idempotent because supervisors are. Compensation: none needed. Brakes: `max-attempts: 5`; `max-wall-clock: 10m`; `backoff: 2m`; `dedupe-key: restartId + check`; `breaker: latch proof-failed`; `max-notification-latency: 300s` past the bound; `audit-location: logs/machine-maintenance.jsonl`.

**Browser sweep / dialog probe.** Class: `recoverable`. They raise no operator notice; the cap refusal is a reply to the caller and repeated sweep failure is a degradation report. `remediation-actions`: close by identity. Brakes: 5 closes per pass; `max-attempts: 1 per instance per pass`; `backoff: next pass`; `max-wall-clock: 60s`; `dedupe-key: instance identity`; `breaker: 3 failed passes pause sweep 24h`; `max-notification-latency: not applicable` (no notice); `audit-location: logs/browser-care.jsonl`.

**Enrolment offer.** Not a watcher: one item per machine, again only on new facts.

## Multi-machine posture

Default `unified`: `GET /machine-maintenance?scope=pool` is a proxied-on-read merged view, the dashboard page is served from any machine and relays actions by signed mandate, notices are one-voice (the maintainer of the machine, the lease holder for non-return), and the claim is a mesh command. A planned restart cooperates with the serving lease and with transfer: conversations stay owned by their machine and do not move for a five-minute restart; they are not stranded because `--resume` and the snapshot are on that machine's disk.

Machine-local surfaces:

- Host enrolment, plan, acks, restart ledger: a physical machine's restart history and consent.

machine-local-justification: hardware-bound-resource

- Wedge samples and lock state: reading of this machine's own hardware and session.

machine-local-justification: hardware-bound-resource

- The sudoers rule: an OS grant on one physical machine.

machine-local-justification: hardware-bound-resource

- Browser ledger and profile close-out: describes live processes on one machine.

machine-local-justification: hardware-bound-resource


Single machine: claims and handoff are no-ops, non-return is unobservable, so the proving restart needs the operator's tap.

## Frontloaded Decisions

1. **On by default, one tap per machine, no silent start.** Reversible, per machine. Why not fully automatic: a reboot is rung-floor 1, and the tap also answers "is this machine really yours".
2. **Cadence 7 days since last boot, 03:00–06:00 local, soft ceiling 3 days past due.** Config.
3. **Lease holder restarts last; no central coordinator; claims over signed mesh.** Matches the decentralized-by-default direction. Unenrolled and unreachable peers do not block.
4. **Conversations do not transfer for a planned restart.** A transfer costs more than a five-minute dark window at 04:00 and would need moving back.
5. **Co-resident agents take part through a host file, with no shared token.** A silent older agent defers up to the ceiling, then its unknown work goes to the owner as one item.
6. **M5 Pro:** `ownershipByMachine: shared` on Echo, never offered by Echo. The do-not-maintain marker stays a card setting; nothing writes to that machine at build.
7. **`fdesetup authrestart` not used; no password stored; no FileVault or auto-login change made for anyone.** Laptop-class machines get reminders.
8. **Instar never handles a machine password.** macOS uses its own administrator dialog; Linux without passwordless sudo is refused. Rejected: a Secret Drop, even a new server-consumed class: it is more mechanism, and a tunnel terminates TLS at a third party.
9. **No wrapper script and no root daemon.** Exact sudoers lines. Fewer root-owned things.
10. **Scheduled restart acts on enrolment; wedge restart starts dry-run on every machine and leaves it only on the graduation evidence in Part E, never on a calendar alone.** Dry-run still sends the operator the real notice with Restart now.
11. **Browser care starts dry-run for 7 days,** live after a soak with no would-close of something in use. **Dialog action** needs a wedge, so it stays dry-run until wedge restart graduates.
12. **Linux desktop dialogs and Windows dialogs are out of v1,** reported as `not-covered`. **Windows + WSL is attended-only in v1:** Mama PC can be restarted by tap and reminded, and a WSL boot-autostart installer is a recorded follow-up.
13. **iPhone app list unchanged in v1.** Dashboard on the phone is the surface.
14. **Graduated rollout:** dev-gated live on Echo first through the phases below; fleet default on once L1–L6 pass. Throwaways excluded forever.

No choice here is tagged cheap-to-change-after: restarts and notices are durable effects, so each is decided above.

## Maturation plan

Phase 1, no privilege: Part A; browser ledger, helpers, cap; dry-run sweep and dialog probe; readiness probe and status route; WedgeMonitor dry-run. Phase 2: enrolment, rule install, `RestartActuator`, brakes, Part D, proof. Phase 3: Echo's machines: Studio (proving), then Mini after its readiness is read; Laptop and Mama PC per their readiness, likely attended. Phase 4: wedge restart live on the graduation evidence. Phase 5: fleet default.

**Run boundaries.** The first build run is Phase 1 and Phase 2 code plus L1, L2 and the integration tiers, and it needs no operator input; wedge and enrolment code reach the machines inert. The next run starts when the operator taps enrolment on the Studio. That single tap is the boundary. L3–L6 and Phases 3–5 are later runs, and each named soak is a timer, not a stop-and-ask. A possible administrator dialog for a Mac without passwordless sudo, and a no-peer proving tap, arise only in those later runs.

## Tests

Three tiers, all with an injected actuator. `RestartActuator`'s real path has one lint-pinned callsite and refuses under test.

- Unit: `lockState` table including every conflict row; `reserve()` and `claimRung` concurrency across all four paths, stale generation and expired plan; ledger brakes, unreadable-ledger fail-closed; state machine persisted across a simulated crash at each state; idle gate both sides of every blocker and ceiling mode; claim ties; browser ownership (operator Chrome path, pid reuse, excluded profiles); dialog allowlist never matching `SecurityAgent`; wedge gate with one family sustained (no candidate), two (candidate), a reset, a missing sample, and accelerated sampling; F1 ineligible on a healthy unpermissioned machine; judge fallback; `machine-restart` in `tests/unit/self-action-convergence.test.ts` under sustained wedge fixture.
- Integration: routes over HTTP (503 dark, operator-session refusal, signed relay refusal on a bad mandate, throwaway refusal); acks from a stub co-resident; resume drain of `planned-restart` with queue dryRun on, and held until boot time advances; `MaintenanceGate` with `WorkAdmission` disabled; plan expiry reopening with a dead maintainer; lifeline command refused for a non-owner and without `confirm`; `failed-to-restart` cancels resume entries.
- E2E: production init path: feature alive, `GET /machine-maintenance` 200, wiring integrity for every injected dep, migration on an existing home.
- Live (`Live-User-Channel Proof`), on real machines, ordered: **L1** lock matrix. **L2** browser close-out with the operator's own Chrome running. **L3** Studio proving restart with a deliberately hung test app open, proving `shutdown -r` is not vetoed, and all proof rows green; time to return recorded. **L4** live session plus autonomous run on a co-resident throwaway resumes. **L5** lease handoff and peer non-return alert with the proof deliberately delayed. **L6** enrolment from a phone, end to end, through the dashboard, with a machine refused for each reason. The operator's only part before these pass is the enrolment tap in L3 and any Mac administrator dialog; L6 uses Echo's own driven phone-width browser against a throwaway agent.

## Honest limits

- A machine hung below user space, or whose restart stalls after the agent's process died, cannot restart itself. A pool peer tells the operator. A single machine cannot. Hardware help (smart plug, `pmset autorestart` with power cycling) is a physical purchase and out of scope.
- Rung 2 on macOS (`reboot -q`) risks unflushed application data. It only runs after rung 1 failed for 8 minutes.
- A controller frozen between `claimRung` and spawning the command can still fire after takeover. Tested for the lock's behaviour; the residual is one extra, counted restart.
- A 2026-11-01-style state showing one family gets a next-window restart, not an immediate one; the operator can always tap Restart now.
- A restart is a remedy, not a diagnosis. The ledger, wedge samples and "restart did not fix it" brake keep the unknown cause visible.
- Everything here runs as one OS user, so operator proof is cooperative: a session deliberately reading the protected ingress secret could forge a press, and a session can run the sudo rule. Reboots are detected at the next boot, not prevented.
- Linux without passwordless sudo cannot be restarted by Instar in v1.
- A foreign process that never stops can keep a machine from automatic restart; the owner gets one item. This is deliberate.
- Whether macOS reopens windows after `shutdown -r` is measured in L3, not assumed.

## Side effects and rollback

`enabled:false` stops everything, read live, and leaves the sudoers file inert. Reverting the release leaves: an inert sudoers file, inert host files, and browser-ledger files. The `screenLocked` field stays so a rollback changes nothing for old dashboards. After a revert no code reads the plan, so a stale plan does nothing. A restart that has happened cannot be rolled back; the brakes bound how many can.

## Open questions

*(none)*
