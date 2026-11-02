---
title: "Machine self-maintenance: scheduled and wedge-triggered restarts, browser and window care, honest lock reading"
slug: "machine-self-maintenance"
author: "echo"
convergence-status: "accepted-at-cap: review did NOT converge. Round 6 of 6 raised safety and data-loss design findings; external rounds 7, 8 and 9 ran beyond the cap (9 rounds in all). The operator accepted at the cap in Telegram topic 134088, message 135179, with round 9's three fixes unread by any reviewer. The review-convergence tag below records that acceptance, not a clean round; see docs/specs/reports/machine-self-maintenance-convergence.md"
approved: true
approved-by: "Justin, Telegram topic 134088, message 135179, 2026-11-01 14:55 PST: 'go', answering message 135176, which named the two rules (restart on silence at the 10-day limit; a person at the machine never auto-restarts), said the last outside review's three fixes were unreviewed, and proposed building the core first in watch-only mode. Earlier design acceptance: same topic, 14:30 PST, 'It looks good, however' with the drain amendment. He read the overview and the offer; the convergence report does not record that he read this spec text."
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
review-convergence: "2026-11-01T22:57:14.963Z"
review-iterations: 9
review-completed-at: "2026-11-01T22:57:14.963Z"
review-report: "docs/specs/reports/machine-self-maintenance-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
cross-model-review-reason: "Astra ran in every round, including 7, 8 and 9 past the cap, and returned SERIOUS ISSUES each time. Gemini and Grok did not run. Accepted at the cap by the operator; not a clean round."
single-run-completable: true
frontloaded-decisions: 16
cheap-to-change-tags: 0
contested-then-cleared: 4
---

# Machine self-maintenance

## Problem statement

Justin, 2026-11-01: "we need to do a better job of managing the various apps/browsers that are used on
any particular machine" and "we need a regular, automated cadence of restarting machines ... clears
out stuck processes and issues and provides a clean starting point ... THIS IS CRITICAL and needs to
be a built in part of an Instar agents ability to maintain its own machines".

Justin, 2026-11-01 14:30 PST, on the first version of this design: "'If a build, a test run or a long job is going, it waits.' Historically this is a trap that never ends because work is ALWAYS going on. The plan should include global Instar work coordination to pause work to enable the machine to restart." So a scheduled restart is a commitment with a time, and work yields to it.

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
conversations resume on their next message, cancelled Local Verify runs and queued work go back to the same place, and builds, jobs and state-file autonomous runs get a durable, bounded revival attempt, with the owner told if it does not land; a tool call in flight,
an unsaved process's memory and anything not Instar's are ended by a restart. Work with no resume path delays a restart only up to a fixed limit, and it is ended only after the owner has been asked one plain question and has not chosen otherwise. An ordinary app with unsaved changes cannot be detected, and the enrolment card says so. Instar works on Mac and Linux at minimum;
Windows-with-WSL is covered because Mama PC is real.

Non-goals: diagnosing the 2026-11-01 root cause; managing the operator's own apps; any hardware
watchdog or smart plug (recorded under Honest limits); changing FileVault or auto-login on anyone's
behalf; applying OS updates.

## Proposed design

Five parts plus operator controls, independently shippable, in the build order of the Maturation plan:

- **Part A** Honest lock reading.
- **Part B** Browser and window care.
- **Part C** Machine enrolment and the reboot privilege.
- **Part D** Scheduled restart.
- **Part E** Wedge-triggered restart.

One host-level drain record, one actuator, one ledger. New modules: `LockStateReader`,
`BrowserInstanceLedger`, `HostMaintenanceStore`, `RestartActuator`, `MachineMaintenanceController`,
`DrainController`, `WorkYieldRegistry`, `PostRestartProof`, `WedgeMonitor`, `StuckDialogProbe`.

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

**Ledger.** `BrowserInstanceLedger` is one small file per instance at `.instar/state/browser-instances/<hash of user-data-dir>.json`: `{ userDataDir, pid, processStartTime, agent, sessionName, topicId, purpose, openedAt, lastUsedAt, ttlMinutes, ttlDeclared, leaseUntil, completedAt }`. Identity is the pair (pid, process start time), so pid reuse cannot aim a close at the wrong process.

**Helpers change.**

- `chrome-launch.sh` writes the ledger entry, stamped from `INSTAR_SESSION_ID` and new optional `--purpose` and `--ttl-minutes` (a long scheduled browser action declares its own lifetime). It enforces the cap below before opening.
- New `chrome-close.sh <profile>`: exact `--user-data-dir=` match, the same jail as launch, SIGTERM to the main pid, SIGKILL after 10 s, removes the entry.
- `chrome-js.sh` and `chrome-mainworld.sh` touch `lastUsedAt` and renew `leaseUntil` to now + `ttlMinutes`. New `chrome-renew.sh <profile>` renews the lease for work those helpers never see, such as a long download or a page working by itself.
- New `chrome-close.sh <profile> --when-free` records the task-completion signal (`completedAt`) when the session cannot close it itself. Plain `chrome-close.sh` runs the unsaved-input check below first and refuses if it finds input; the session submits or clears the form, then closes.
- `ndrive.sh` on Windows gains `closebrowser`, implemented in the wrapper only, against the pid in the per-agent binding file. `native-drive.ps1` is hash-pinned and is not edited. The ledger, sweep and cap are `not-covered` on Windows in v1: WSL cannot see Windows Chrome in its process table, so the ownership rule cannot hold there.
- The `/normal-chrome-browser` skill gains one rule: close what you opened with `chrome-close.sh` when the task ends.

**Who may be closed.** Only an instance that is both (a) in this agent's ledger, or adopted, and (b) whose live process carries a `--user-data-dir` inside this agent's own `.instar/state/playwright-profiles/`, or a `relogin-chrome-profile-*` directory recorded by `PlainChromeReloginBrowser`. Adoption: at sweep start, a running Chrome matching (b) with no entry gets one with `openedAt` and `lastUsedAt` = now and `purpose: adopted`. The operator's own Chrome has no such flag and can never match. `$HOME/Library/Application Support/Google/Chrome` is refused as the launch helper already refuses it.

**Excluded from any close:** a profile held by the Telegram browser broker; a profile under a `PlaywrightSeatLease`; a profile in a live sign-in repair episode; any instance whose window is frontmost while the operator was active in the last 5 minutes.

**Sweep.** Every 15 minutes, server-side, no model, no session. A timer alone closes nothing: the lease (`ttlMinutes`, default 120) and the 30-minute idle reading first make an instance worth checking. Ownership says who may be closed; it is not evidence that the work is finished. A close needs one of these three:

1. A completion signal: `completedAt` is set.
2. A declared disposable lifetime: the instance was launched with an explicit lifetime that says its contents are disposable, and `leaseUntil` has passed with no renewal. Expiry of the default lease closes nothing while the owner is alive; it only produces a report.
3. A confirmed absent owner: `lastUsedAt` is older than 30 minutes and a fresh read shows the owning session in neither the session list nor tmux. An unreadable read confirms nothing. An instance launched with an explicit `--ttl-minutes` (`ttlDeclared`) is not closed this way before its lease expires, so a scheduled browser action outlives the session that set it up. An adopted instance has no named owner, so only its lease applies.

**Unsaved input and downloads.** Every automatic close, whichever path reached it, then checks each tab of that instance. The check is read-only, takes no focus, uses the same page-JavaScript path as `chrome-js.sh`, and returns only a yes, no or unreadable per tab, never a value. Yes means an `input` or `textarea` whose value differs from its default, a checked state differing from its default, or edited `contenteditable` content. A tab that cannot be read, a page that does not answer in 5 s, a focused cross-origin frame, or a machine with no page reader all read as unreadable. Yes or unreadable on any tab, or a `.crdownload` that grew in the last 5 minutes in the profile's download folder, keeps the instance. A kept instance gets an audit row and appears in `GET /machine-maintenance` as `keptUnsaved` or `keptUnreadable`, and the cap's refusal names it. Nothing is closed to find out. Audit: `logs/browser-care.jsonl`, paths only. Ships dry-run: 7 days of would-close rows on the development agent before it acts.

**Cap.** Default 4 per agent, 8 per host (host count read from `~/.instar/host-browser-instances/`, one marker file per instance). At the cap, `chrome-launch.sh` closes this agent's oldest eligible instance through the same gate and the same unsaved-input check as the sweep; if none is eligible, or while `browserCare.dryRun` is on, it records the proposed close and refuses with a named error listing what is open. An existing Playwright Chromium counts toward the host total as read-only evidence and is never closed by this sweep (`McpIdleOffloadSweep` owns it).

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

Telegram offers enrolment ONE time per machine, as one attention item with the direct link. It offers again only on new facts: a new machine, or a readiness change. The card stays available regardless. The card says plainly: "I will restart this machine about once a week in the small hours, and if it wedges. Running work pauses first and picks up afterward. If something can't pause, I'll ask you before it is ended, and if you don't answer, the restart goes ahead. This interrupts everyone using it. I can't see unsaved changes in ordinary apps, so anything left open and unsaved here may be lost." It names the non-Instar apps open now, and the tap acknowledges that text.

**Co-resident agents and their people.** Every instar agent on the host writes `consents/<agent>.json` with a hash of its verified operator's uid. An agent whose hash differs from the enrolling operator's blocks unattended mode until its own operator taps on its own dashboard; agents with the same hash are covered; an older agent with no record is named on the card and listed in `acknowledgedAgents` when the owner taps past it. First enrolment takes the maintainer role under the host lock.

**Refusals before the tap is offered:**

| Condition | Result |
|---|---|
| Host marker `~/.instar/host-maintenance/do-not-maintain.json` present (readable by every agent on the host; set per machine from the card, never at build) | Not offered to any agent. `refused: not-owned`. |
| Agent is on a machine named in its own `machineMaintenance.ownershipByMachine` as `shared` | Same. |
| Another human is on the machine (`who` shows a different user on console, tty or SSH, or processes under another uid ≥ 501 with a tty) | Not offered until gone, `refused: other-user-active`. At every restart an active person is safety hold S3, re-read at actuation. |
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

`attended` mode: the machine is never restarted by itself. At 14 days of uptime, one attention item: "Laptop has been up 14 days. Restart when you're near it" with a Restart-now tap (operator session, runs Part D's short drain). The re-check happens on boot and at each due evaluation; a setting changed later upgrades the mode after a proving restart.

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

**Proving restart.** A restart can only be proven by a test, so `unattended` is earned. After enrolment the mode is `proving`. The first restart runs like a scheduled one and its `PostRestartProof` must pass, including auto-login and agents returning unaided. It runs through `forcedDueAt`, since a machine under 7 days of uptime is not otherwise due, and it starts only once watch-only evidence has cleared (Maturation plan). Pass → `unattended`. Fail → `attended` plus an attention item. On a pool machine it runs in the next window and a peer watches for its return. On a machine with no peer it runs only when the operator taps "Restart now", so someone is around if it does not come back.

**Hand-run reboots.** A session can run the sudo rule directly. The awareness card says not to. It is detected, not blocked (a word-matching guard here would hold blocking authority on a brittle signal): at every boot the maintainer compares OS boot time with the ledger, attributes an unexplained reboot as `unattributed`, counts it toward the brakes, and raises one item when two occur in 7 days.

### Reminder: macOS privacy permissions are read live

An unusable macOS privacy state needs a guided repair. On 2026-11-01 the Mac Mini showed the system prompt but never listed `instar-desktop-host`, and the M5 Pro listed 5 entries (cause unmeasured). So enrolment and readiness must verify permissions by a live probe at that moment, and must not rely on a stored flag or on the prompt having been shown. This section names the need only. It designs no repair.

### Part D: scheduled restart

**Cadence.** Due when `now - lastBootAt ≥ 7 days` (configurable 5–30), or when `forcedDueAt` is set (Part E). `forcedDueAt` clears on any boot or on the operator's dismissal. `lastBootAt` comes from the OS (`kern.boottime`, `/proc/uptime`, Windows `LastBootUpTime`), so any restart, for whatever reason, resets the clock and there is no extra weekly restart after a power cut.

**Window.** 03:00–06:00 machine-local, per machine (`machineMaintenance.window`). Per-machine override is on the card. If a laptop sleeps through it, the next window applies.

**Host maintainer.** On a shared login, only the maintainer agent evaluates, samples wedge evidence, calls the judge and actuates; four co-resident agents do not each spend judge calls. It writes a heartbeat to the host store every 60 s. A heartbeat older than 10 minutes lets any co-resident enrolled agent take over under the host lock, so a dead maintainer server does not strand a wedged host. No co-resident agent: the lifeline path below.

**Host store and exclusive authority.** `HostMaintenanceStore` is the only writer of host files, under one host lock, with fsync and rename. `reserve(kind)` is the single transaction every path uses (scheduled, wedge, operator, lifeline), and it is the first write of any episode. Under the lock it checks the brakes, opens one episode, mints `episodeId` and `generation`, and commits a ledger row in state `reserved` before returning. Nothing that carries an episode id happens before it. The scheduled path calls it at T-70, before the `maintenance-claim`. The wedge path calls it at the start of rung 4, because rungs 1–3 restart nothing. The operator and lifeline paths call it first.

**What uses up restart budget.** Reservation holds the episode; it spends nothing. The count brakes count only rows that reached `claimRung`, which flips the row to `dispatched` before the command runs. A row closes one of these ways:

| Row ends as | Meaning | Uses budget |
|---|---|---|
| `aborted-unclaimed` | Closed before `notified`, such as a claim conflict | No |
| `aborted` | Closed at or after `notified` and before dispatch, including a reservation found expired | No, but counts toward the abort brake |
| `rolled` | The drain ran and a delay reached its maximum, so the restart moved to the next night | No, and not toward the abort brake: the maximum interval already bounds it |
| `refused` | Dispatched, and the OS refused it before accepting | No, but counts toward the abort brake |
| `restarted` | Boot time moved | Yes |
| `left-running` | Accepted or unknown, then cancelled or the owner chose to keep running | Yes |

A second automatic request joins the open episode and gets no authority to actuate. An operator request (card or lifeline) bumps `generation` and takes the episode over, so a server that died mid-drain cannot keep the owner waiting for `expiresAt`. Maintainer takeover bumps a `generation`. Immediately before each privileged command the caller runs `claimRung(generation, rung)`, atomic under the lock: it fails on a stale generation, an expired plan, or a rung already claimed. Every plan write and cleanup carries the generation and is refused when stale, so a stale controller's abort path cannot undo an operator's takeover. A plan's expiry invalidates its authority. `claimRung` keeps the host lock through spawning the command, and takeover and reopen take the same lock, so they serialize with dispatch. A process frozen between claim and spawn past the lock's staleness bound is the remaining gap (Honest limits); its only effect is one extra counted restart. Host-relative writes get a new arm in `WriteDomainRegistry`, whose direct-write entries are agent-root-relative today.

**State machine,** persisted in `~/.instar/host-maintenance/plan.json` (the drain record below) before every transition: `idle → due → committed → reserved → notified → quiescing → armed → actuating → (boot) → verifying → done | proof-failed`, with `quiescing` carrying a `phase` (`moving`, `checkpointing`, `pausing`, `receipting`), `actuating` also leading to `failed-to-restart` or `outcome-unknown`, and any state before `armed` able to close as `rolled`. Every plan carries `expiresAt` (the planned T-0 plus the delay ceiling plus 15 minutes, extended once at `armed` to cover the rung 2 wait). Every server checks it on its 60 s tick; an expired or malformed plan is ignored and that server reopens independently of the maintainer. The one exception is `outcome-unknown`: a dispatch record that reads `accepted` or `unknown` for this boot keeps admission closed whatever the plan says, and so does an unreadable dispatch record, because a privileged command may still be on its way.

**The restart is a commitment.** When a machine is due, the controller commits to a time before looking at what is running: T-0 is 60 minutes after the window opens (04:00 by default), written to the plan as `restartAt`. The drain then runs whether or not work is going. Nothing waits for the machine to be idle, because it never is. Work yields to T-0, and only the closed lists below can move it.

**Not delays.** A machine with no commitment has nothing to delay: not enrolled, mode not unattended or proving, off switch, `skipUntil` set by the owner, `proof-failed` latch, a brake. These are the owner's decisions or restart-safety brakes, not work.

**Global drain record.** The plan file is the one mechanism every agent uses. It lives at host level beside the other host-wide files (`~/.instar/host-spawn-holders.json`, the test limiter's holders, `host-recovery-slot.json`), written only through `HostMaintenanceStore` with the same lock, fsync and rename. It carries `episodeId`, `generation`, `state`, `phase`, `restartAt`, `originalRestartAt`, `final`, `activeDelays`, `delayMinutesUsed`, `holds`, `until`, `expiresAt`. Every instar server on the login reads it on a 60 s tick (10 s from T-10), with no token, including other people's agents on that login. Host-wide tools read it directly at their own chokepoints, so the test limiter works with no server up.

Pool peers learn from a new `plannedRestart: { at, until, phase }` in the presence advert, published at T-60, plus the `maintenance-claim`. A peer that sees it places no new work there, dispatches no Local Verify peer run there, moves no conversation there, and reads the machine as `stale` with positive evidence during the restart. An agent under a different OS login cannot read this file (Honest limits).

**Drain sequence.** All times are relative to the current `restartAt`. Each phase runs when due and does not wait for the one before.

| Time | Phase | What happens |
|---|---|---|
| T-70 | Reserve and claim | `reserve()`, then the `maintenance-claim` to pool peers. A conflict moves T-0 by delay D6. |
| T-60 | Announce | Drain record published, `notified`. Census of running agents. `plannedRestart` advertised. `MaintenanceGate` closes to new long work: scheduled jobs, autonomous starts, helpers, full test suites, Local Verify starts. Notice sent. Conversations with existing sessions carry on. |
| T-45 | Move | Pool agents only. Serving lease handoff (with the existing `target` selector below), Local Verify queue offered to the new lease holder, and recently active conversations moved through the cooperative transfer path. |
| T-20 | Checkpoint | Every session gets one stop-at-next-boundary notice. Autonomous runs and jobs are marked suspended. |
| T-10 | Cancel | Local Verify runs and test suites are cancelled. The gate closes to all automatic work, including targeted tests. |
| T-5 | Pause | Any session not yet at a boundary gets the existing Escape interrupt. Owned browsers close through Part B's checks. Yields are read back. |
| T-2 | Receipts | `receipting`: resume entries enqueued, receipts checked, snapshot and reap-log rows written. D3 can open here. |
| T-0 | Arm and restart | `armed` only after receipts pass or the final-night exception applies, then the fresh check, `claimRung`, Rung 1. |

The T-5 pause works without the agent's cooperation: the owner of a stopped thing is the controller, not the session.

**Short drain.** Restart now and wedge rung 4 run the same phases in 5 minutes: announce and close the gate, handoff tried for 3 minutes, checkpoint notice, cancel at T-3, pause at T-1, arm, restart. Conversation moves are skipped.

**Allowed delays, a closed list.** Delays are read every 5 minutes from T-60 until `armed`. Each one holds T-0 in 5-minute steps. Anything not on this list does not move T-0.

| # | Delay | Holds while | Maximum per episode | At the maximum |
|---|---|---|---|---|
| D1 | Owner at this machine | Input under 15 min (`HIDIdleTime` via `ioreg`, discounting Instar's own driver activity; Linux headless by tty activity), a live desktop grant, a live AnyDesk connection, an operator message to a topic on this machine in 30 min, or presence unreadable | 60 min | Rolls |
| D2 | Work with no resume path | Foreign tmux session with CPU, session with no topic, job or Slack identity, Live test harness, work with no yield declaration. A tmux session the operator lists in `machineMaintenance.nonAgentTmuxSessions` (exact name, or a prefix ending in `*`; default empty) is not foreign | 60 min | Rolls |
| D3 | Agent not answering | A census agent with no ack, or no receipt for its live autonomous run | 30 min | Rolls |
| D4 | Short critical step | Declared `finish-bounded` work: Instar update or migration, a merge in flight, a sign-in repair, a credential swap, a transfer in flight | 30 min | Restart proceeds |
| D5 | Lease will not hand off | Three failed handoffs | 30 min | Restart proceeds; the lease moves by TTL, as on any crash |
| D6 | Another pool machine restarting | `maintenance-claim` conflict | 90 min, only while the new T-0 fits the window | Rolls |
| D7 | Unsaved input in an owned browser | An owned browser reading `keptUnsaved` | 30 min | Rolls |

**Total ceiling.** T-0 moves at most 120 minutes in one episode (`maxEpisodeDelayMinutes`) and never past the window's end. A ceiling reached with a delay active rolls or proceeds as that delay's row says; if several are active, one that rolls wins. So the machine restarts or the episode closes by the end of the window, every night.

A delay can open up to `armed`, in `receipting` included. A delay active before a phase simply moves that phase, since phases hang off the current T-0, so the usual roll happens before anything has been stopped. Work already stopped stays stopped while a later delay lasts, because the wait is capped.

**Calling a drain off.** A notice cannot restore a stopped process, so each yield is undone by its own kind. Each agent writes a durable row to `~/.instar/host-maintenance/yields/<agent>.jsonl` before every yield, and every `WorkYieldRegistry` entry declares `undoYield()`. On a roll, Skip, plan expiry, refused Rung 1, verified cancellation or Keep running, the gate reopens, this episode's held resume entries are cancelled, and each agent walks its rows:

| Yielded | Undo |
|---|---|
| Local Verify run or queue entry | Starts again, first in line |
| Test run | The session is told to repeat it |
| Session stopped or interrupted, still alive | One "restart called off, carry on" notice, with the last unanswered message re-injected |
| Session gone, job session | New resume entry `kind: drain-called-off`, released on this boot with no boot-time condition |
| Autonomous run | `drain_suspended_for` cleared, then revived the same way if its session stopped |
| Script job | Reruns at its next trigger |
| Closed browser | Relaunches on demand |

Each undo is idempotent and is read back. A row with no read-back is retried on the tick, and a server that was down runs its rows at start, so a called-off drain cannot strand a marker. What cannot be undone is the tool call an interrupt ended; the notice names it.

**Maximum interval.** Rolling is limited too. `maxIntervalDays` (default 10, at least `cadenceDays + 1`) is the longest a machine goes between restarts without the owner choosing that. On day 7 it tries nightly. When the machine reaches `maxIntervalDays - 1`, one attention item goes out at 10:00 machine-local, never at night:

> "Mac Studio has gone 9 days without a restart, because a program I can't pause kept it running. It will restart tonight at 4:00, and that will end: backup-sync. Restart tonight / Restart now / Skip 3 days"

It needs one tap on a phone, and no tap keeps the default. That night is `final: true`: D1, D2, D3, D6 and D7 proceed at their maximum instead of rolling. Notices that night are audible, at T-60 and T-5, and name anything to be ended. The default takes effect only after the question has a delivery receipt, and a failed send retries. If it cannot be delivered, the night rolls and `GET /machine-maintenance` says why, because ending work on a question nobody received would be a silent default. Skip sets `skipUntil` 72 h ahead, and the question returns when that ends. At 14 days overdue the question also offers to turn restarts off for this machine.

**Safety holds.** These are not delays. They have no maximum, because restarting through them can do lasting harm. Each is named in the status and in a notice every night it stops a restart, and none is ever passed by the default. Only positive evidence counts: an unproven reading is no hold, so a hold cannot be reached by simply being unable to read something.

| # | Hold | Evidence | Who can pass it |
|---|---|---|---|
| S1 | OS update verifiably installing | A code-owned reading per OS, proven in L7: macOS update install state; Linux the dpkg, rpm or pacman lock with its live installer process | Nobody |
| S2 | Disk or firmware operation in progress | Positive process list, code-owned: `fsck`, `diskutil` repair or conversion, `asr`, Time Machine restore, `fwupd`, firmware install | Nobody |
| S3 | A person using the machine now | Console input under 5 min at the fresh check, or another user's session with tty activity under 15 min. An idle login is not a hold | The owner's Restart now, naming it first |
| S4 | On battery under 50% | Power source reading | The owner's Restart now, naming it first |

S1, S2 and S3 end by themselves in normal use. A hung installer does not, which is why it is reported every night. S3 means no automatic restart ever lands under someone's hands, on the final night included.

**Unsaved input in a browser: a delay, not a hold.** An owned browser reading `keptUnsaved` is D7. At T-20 its session is told to submit or clear the form. If nothing changes, the night rolls, and the final night proceeds with the browser named in the question. A hold would rebuild the trap, because one forgotten form would stop every restart for good. The harm is bounded: the profile is the agent's own, the text was typed by the agent's automation or on a page the agent opened, and the owner has been told by name. The operator's own Chrome is never read, so it sits with ordinary apps under the card's warning. `keptUnreadable` delays nothing and is listed in the notice.

**Work yield contract.** `WorkYieldRegistry` is one code-owned table of every kind of long work, on the pattern of `SELF_ACTION_CONTROLLERS`. Each entry declares `kind`, `discover()`, `class` (`cancel-requeue`, `checkpoint-resume`, `stop-at-boundary`, `finish-bounded`), `yield()`, `readBack()`, `undoYield()` and `maxYieldSeconds`. A test walks the spawn chokepoints (`SessionManager`, scheduler, spawn admission, `LiveTestRunner`, Local Verify) and fails the build if one can start work with no declared kind. **Safe default:** work found running with no declaration is D2. It delays a restart by a bounded amount and reaches the owner by name, so it neither stalls restarts for ever nor ends silently.

| Work | Class | Stops being admitted | Yields | Comes back |
|---|---|---|---|---|
| Local Verify run | `cancel-requeue` | T-60 | T-10, new `yieldForRestart()`: like `shutdown()` it keeps `resumeFirst`, and it adds `plannedYields`, not `interruptions`, so a weekly restart never raises the starved alarm | Same place in the queue, automatically. `queue.json` already persists PR entries, and `main` is re-queued at boot |
| Local Verify queue | `cancel-requeue` | T-60 | T-45: if the lease moved, each entry is re-requested on the new holder in queue order | There, or here on return if the new holder refuses |
| Local Verify peer attempt | `cancel-requeue` | T-60, peer answers busy | T-10 cancel; coordinator's existing peer failure path requeues | On the coordinator |
| Test suite, targeted run | `cancel-requeue` | Suite T-60, targeted T-10, a typed `HostDrainingError` saying this is not a test failure | T-10: SIGTERM to the holder's process group, identity checked by (pid, start time), on this path regardless of the limiter's posture or its TTL signal arm | The session's revival prompt names the run to repeat |
| Session mid-turn | `stop-at-boundary` | Existing sessions keep receiving messages | T-20 notice: "This machine restarts at 04:00. Save your place, finish this step and stop. You will be resumed." T-5 Escape if still going | Resume queue; last unanswered message re-injected |
| Slack session mid-turn | `stop-at-boundary` | Existing sessions keep receiving messages | The same T-20 notice and T-5 Escape | The channel-resume map holds the conversation for 24 hours; the next message in that channel or thread respawns it |
| `/build`, `/instar-dev` | `stop-at-boundary` | T-60 | As a session; worktree and build state are on disk | Resume queue |
| Autonomous run | `checkpoint-resume` | T-60 | T-20: state file marked `drain_suspended_for: <episodeId>`, on the `moved_to` pattern, so the stop hook lets it stop and this is not a completion | Resume queue; marker cleared on revival |
| Scheduled job session | `checkpoint-resume` | T-60 | As a session | Resume queue with or without `resumeOnReap`, unless the job sets `yield: next-trigger` |
| Script job | `checkpoint-resume` | T-60 | Ended at T-5 if still running | Next trigger; the run is recorded as yielded, not failed |
| Subagent, background shell | Part of the session | As the session | Interrupted with the session at T-5 | The revival note names what was interrupted, as a swap's mitigation note does |
| Owned browser | `stop-at-boundary` | T-60 | Part B's close at T-5; D7 if unsaved | Profile stays; relaunch on demand |
| Sign-in repair, merge, transfer, credential swap, Instar update | `finish-bounded` | T-60 | Finishes; D4 | Not needed |

Every yield is read back from state, not from the claim: the holder gone, the process gone, the state file marked. The monitors that would undo a drain read the record: `AutonomousLivenessReconciler` does not respawn, window-run liveness records a planned stop and spends no recovery, and PromiseBeacon revival waits.

**One machine at a time, best effort.** No coordinator and no consensus: this is staggering, not mutual exclusion. A rare delayed message can restart two machines together; that costs a few minutes of reduced cover and is cheaper than a grant protocol, which is not built. At T-70, the machine sends a signed `maintenance-claim` mesh command to every online pool peer, carrying `(claimedAt, machineId)`. A peer answers `ok`, or `conflict` when it holds an earlier claim (ties go to the lower machineId) or finished a restart less than 30 minutes ago, or has not yet passed proof. A `conflict` closes the reservation as `aborted-unclaimed` and commits a new T-0 90 minutes later under D6. An unreachable peer does not block, and its absence is recorded. An older peer's unknown-command answer is recorded and does not block. Lease holder goes last: a new `maintenanceDue` field in the presence advert lets the holder see a due non-holder and commit its own T-0 one drain later. The command needs the `MeshCommand` union, the `MeshRpc.ts` classification and a dispatcher handler. If several are due, the window fits them in sequence and the rest roll to the next night.

Pools overlap on one host (ai-guy's pool is not Echo's). Pools are per-agent, and the actual restart is per-host, so the claim is per-pool and the plan file is per-host. Co-resident agents in other pools see the drain through the host file and each makes its own lease handoff.

**Co-resident agents.** At `notified`, `MaintenanceGate` closes first, then the maintainer writes a census of running agents into the plan from `~/.instar/registry.json`, filtering `-lifeline` entries, because a graceful shutdown unregisters an agent and the registry cannot answer "who was running" after boot. Each writes `acks/<agent>.json`: `{ episodeId, generation, bootTime, state: draining|ready|enqueued, delaysClaimed, yields, leaseHandedOff, version, at }`, with `yields` holding per-kind counts and yield times. An ack, snapshot or receipt whose episode, generation or boot differs from the plan's is ignored, so a replacement plan cannot be satisfied by an old file. Each agent runs its own drain. An agent can claim only listed delays, each capped here, so no agent can extend an episode beyond the host's limits. A server starting during the episode joins it by reading the plan, and the census is reconciled in `receipting`. A running agent with no ack at T-5 (older version, hung) has unknown work, and a returning server does not prove work recovered, so it is D3. In its own pool, each co-resident agent sends a `maintenance-claim` too; a `conflict` makes it claim D6, so overlapping pools stay one-at-a-time with no new mechanism.

**What each agent does during the drain.**

1. Keeps new work refused through a new host-level `MaintenanceGate`, consulted at the same chokepoints as `WorkAdmission` (scheduler, spawn admission) but independent of it, because `WorkAdmission` forces open when disabled and may be dark. The recovery slot stays open to an operator session. Starting one no longer cancels the plan; it opens D1.
2. Pool agents, at T-45: if holding the serving lease, runs a planned handoff. `HandoffSentinel.initiate()` gains a `target` argument with a real selector (online, direct contact under 2 minutes, `loadVerdict` ok, no `plannedRestart`), because `HandoffWireTransport.peer` today returns the first registry machine with a URL. It never yields without a verified ack. Three failed tries open D5. With no handoff transport wired, the lease moves by TTL expiry as it does on any crash.
3. Pool agents, at T-45: moves conversations active in the last 6 hours through the existing cooperative transfer (`SessionDrainRunner`, the path overload shed uses), one at a time, up to `drain.maxMoves` (default 6), to a target chosen by the overload-shed rules. Pinned topics, Slack conversations and topics with a live autonomous run stay: moving a run needs the operator's consent, and it is revived here instead. A moved conversation stays where it landed. A failed move costs nothing; that conversation resumes here.
4. Publishes `plannedRestart` and a graceful-shutdown announcement. Inbound custody during the restart is what the machine already has. The holder answers a message for this machine's topics, ONE fixed line per topic per restart, sent directly with `telegram.sendToTopic` (not through the owner-dark ladder, which is journal-only until enforced), worded from real custody: durable queue live → "That machine is restarting and will be back in a few minutes. I have your message."; queue dark → "That machine is restarting and will be back in a few minutes. I can't hold this one, so please resend it then."
5. Runs the yields for its own work, then writes `state/planned-restart-snapshot.json`, listing every live session with its topic, and records each in the reap-log (`reason: planned-machine-restart`, `origin: machine-maintenance`) in `receipting`.
6. Writes its ack `ready`.

**Actuate.** From T-2: re-reads off switch, skip, safety holds, ledger brake, and governor admission against the open episode. The ledger is `~/.instar/host-maintenance/restarts.jsonl`, and the episode's row has been on disk since `reserve()`. In `receipting`, each agent in the census enqueues its resume entries and writes `state: enqueued`, within 90 s. Each ack carries per-session receipts. A missing receipt for an agent with a live autonomous run opens D3, holding T-0 in `receipting` with `armed` not yet entered, so an ordinary night can still roll. On the final night, at D3's maximum, the restart proceeds and the run is named in the notice, with its state file on disk for a manual or liveness revival. A missing receipt for an ordinary conversation is listed in the proof, since it resumes on its next message. Then the fresh check below, `claimRung`, then Rung 1.

**Fresh check before every privileged dispatch.** Immediately before Rung 1 and again before Rung 2, an automatic path re-reads off switch, skip and every safety hold, inside the `claimRung` lock. Delays are not re-read here; they closed at `armed`. Any failure aborts that dispatch: before Rung 1 the plan is cleared; before Rung 2 the episode goes to `outcome-unknown`, because Rung 1 may still be running. S1, S2 and the off switch are checked inside `claimRung` itself, for every caller and every rung, the lifeline's `force` included: an operator dispatch cannot pass them, and one that begins during a short drain refuses the dispatch. An operator dispatch passes exactly this: its own skip, S3 and S4, each named first. A refused Rung 2 goes to `outcome-unknown` like any other.

**Dispatch outcome.** `claimRung` writes the dispatch record as `unknown` before the command runs, so a crash at any point leaves the safe reading. The record changes on one of two results:

- `refused`: the failure is shown to be before dispatch: the process could not start, or sudo refused and never ran the command, confirmed by `sudo -n -l` no longer listing the exact line. The OS was asked for nothing.
- `accepted`: the command exited 0.

A timeout, a kill by signal, a lost result, or a nonzero exit from the shutdown command itself stays `unknown`, because that exit does not show earlier shutdown steps were undone. A timeout never means cancelled. Rung 2 runs only after an `accepted` or `unknown` Rung 1, once, if the machine is still alive after 8 minutes. A refused Rung 2 does not change Rung 1's outcome.

Only a refused Rung 1 takes the clean exit: `failed-to-restart`, attention item, plan cleared, drain undone, this restart's resume entries cancelled, ledger row closed.

**`outcome-unknown`.** The machine is still alive 5 minutes after Rung 2, or after a fresh check stopped Rung 2. No one can yet say the shutdown will not complete, so recovery stays armed:

- `MaintenanceGate` stays closed to automatic work. The recovery slot stays open to an operator session.
- Resume entries stay held and their TTL is frozen. The plan does not expire and the ledger row stays open.
- A new automatic request joins the episode and gets no authority.

It ends in one of three ways:

1. **Reboot.** Boot time moves, and resume and proof run as usual.
2. **Verified cancellation.** Rechecked on the 60 s tick, using an OS-specific reading that shows no shutdown is pending. A reading counts only after L3 has shown it telling a pending shutdown from a cancelled one on that OS. Until then no OS has one, and a quiet process table proves nothing. A pass runs the `failed-to-restart` cleanup and closes the row `left-running`.
3. **The owner decides.** One attention item goes out at once: "Mac Studio was told to restart and hasn't. I can't tell whether it still will, so I've paused automatic work here." It offers Restart now and Keep running, and it is sent once more, audibly, at 6 hours. Restart now re-dispatches in the same episode. Keep running is recorded, runs the same cleanup, closes the row `left-running`, and says that a late restart would then be an ordinary unplanned one with no resume entries.

Automatic work stays closed for as long as the owner has not answered. That wait is deliberate and is bounded only by that reply, a reboot or a cancellation. If the maintainer's server is gone, the item is raised by whichever agent takes over; a lifeline-dispatched restart states the same in its reply, and its server reads the record when it next starts.

A `shutdown -r` on macOS and `systemctl reboot` are not vetoed by a hung GUI app the way a `loginwindow` restart is; this is a claim to prove in L3, not assume. The test-process guard: `RestartActuator` refuses unless a reserved episode names this boot and `VITEST`/`CI`/throwaway are absent. It is the only code that holds those command lines, enforced by a lint; it has two callers, the controller and the lifeline path.

**Resume.** After boot, supervisors start servers and lifelines as they do now. Resume uses `ResumeQueue` with a new entry field `kind: planned-restart` (`ResumePriorityClass` is a different axis):

- Entries are enqueued at the last step before actuation, with the resume UUID read then, because the drainer's `validateReality` otherwise marks them `invalidated:live-session-exists` within a minute, and a UUID read earlier goes stale.
- Entries carry `episodeId` and `generation`. `claimRung` writes the durable dispatch record above. `nextCandidates()` releases an entry only when that record exists AND OS boot time is newer than `entry.bootTime`, so a held entry neither reaches `validateReality` nor consumes a tick. On plan expiry and at every server start, entries of an episode with no dispatch record are cancelled, so a later unrelated reboot cannot release them.
- `kind: planned-restart` is exempt from `classifyEligibility`'s evidence and origin refusals, from the resurrection tombstone cap (a weekly restart is not a crash loop), and from the queue-level dry-run branch through a per-kind path.
- Committed entries are exempt from overflow eviction. If autonomous-run entries alone would exceed capacity, that agent reports no receipt.
- It is NOT exempt from calm, quota and session-count gates, or one-at-a-time revival: a machine should not stampede at boot. Revival may therefore be slow.
- A paused queue holds these entries; TTL is 24 h, frozen during `outcome-unknown`. An autonomous-run entry that expires unrevived, or stays pending past 2 hours, raises one item per restart naming the topics; its state file stays on disk. The queue's 50-entry capacity stands. Job sessions are enqueued as the yield table says. The proof's Sessions row compares `planned-restart-snapshot.json` with the queue, so every session is accounted for by topic: revived, pending, invalidated, expired, overflowed, paused, or never enqueued (queue off or disabled, which returns before any per-kind path).

Conversations also resume on the next inbound message through `--resume`, as today. An autonomous run's state file is on disk, and its entry revives it even where `AutonomousLivenessReconciler` is dark. Spawn verification cannot prove the transcript attached, the existing limit. Interrupted turns get the existing last-unanswered re-injection, plus a line naming any cancelled test run. Local Verify resumes per `local-verify-survives-restart` and the yield table.

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

- Before, at T-60: "Restarting Mac Studio at 4:00 for its weekly clean start. Running work will pause and pick up afterward. Skip it: <link>"
- After: "Mac Studio restarted and everything came back: server, messaging, tunnel, desktop, 3 sessions resumed."
- Failure is an attention item, not a silent line, naming the failing check in plain words.
- A final night's notices are audible, name anything to be ended, and carry Skip.
- A rolled night is one silent line naming the delay. A safety hold is one line every night it stops a restart.

### Part E: wedge-triggered restart

**Evidence families.** Sampled every 10 minutes, and every 2 minutes once any family is positive. Every probe runs in a child with a hard timeout, single-flight, no `osascript` against apps. A probe that timed out is a completed result of that family, as its row says. The monitor itself not sampling is missing, not a result.

| Family | macOS | Linux | Windows + WSL |
|---|---|---|---|
| F1 GUI path | A shipped, signed and notarized no-UI canary app launched through LaunchServices (`open -g -j`), quits at once; a nonzero `open` (e.g. -600) or timeout. Also helper `capture` of one frame failing or blank; 2+ desktop grant failures in 30 min | `systemd-run --user` no-op | `cmd.exe /c exit` timing through interop |
| F2 Process table | Bounded `ps` itself times out; fork failure; uninterruptible-state count rising over 3 samples; `data.kalloc.1024` over 4 GiB from `echo-kmem-watch`-style reading | `ps`; D-state count | `ps` in WSL plus `tasklist` timing |
| F3 Stuck dialog | A pattern-listed dialog survived a press (Part B) | Not applicable | Not covered |
| F4 Agent symptoms | `loadVerdict` `impaired` while CPU idle ≥ 30%; session spawn failures for system reasons in 30 min; event-loop lag with low CPU | Same | Same |

**Eligibility.** F1 counts only on a machine where that same probe has passed since boot, and not while there is no console session or `lockState` is `locked`. The capture half also needs Screen Recording, a non-`unknown` `lockState` and an awake display; the canary half needs neither, so a machine with its display asleep overnight still has F1. So the Mini as measured today contributes no F1 evidence, and the Laptop contributes only the canary. Launch and capture failures are correlated, so they are one family.

**Wedge candidate.** One continuous 20-minute evidence window with at least 3 observations in which the same two families are positive at every observation. A negative observation of either family resets the window. One missing sample neither counts as positive nor resets, but a gap over 6 minutes between observations restarts the window, so a monitor stall or a maintainer takeover cannot bridge it. The judge call and rung 4 each need both families observed positive within the last 6 minutes. Peer reachability is not a family: `pool` rows are this machine's view of its peers, which says nothing about whether peers can reach it. F3 needs a ladder to exist, so it never forms a candidate; it informs the judge and a later episode. **Single-family fallback:** one family positive for 2 hours forms no candidate and calls no judge; it records `forcedDueAt` in the plan for the next window. This is deliberately a scheduled restart brought forward, under the scheduled brake (1 per 5 days) and the full idle gate, so it runs even while `wedgeRestart.dryRun` is true. On an `attended` machine it is the uptime reminder, sent now. Uptime under 6 hours marks the candidate `recently-restarted`, which caps the outcome at notify (a restart that did not help is not repeated).

**Decision.** Detection is signal. A candidate goes to one judge call, `machineWedgeJudge`, on the agent's ordinary intelligence path with the Jev-first cascade where available and the single-provider default otherwise. It runs on the maintainer only. It sees structured evidence only: families, ages, uptime, blockers, sessions count. Never window titles or dialog text. Enrolled in the Decision Quality meter. Bounded action space: `leave | gentle | restart-next-window | restart-now`.

**`restart-now` is earned.** While `wedgeRestart.dryRun` is on, the judge may propose any of the four, recorded only, and those rows are the evidence. Graduation: 14 days of wedge dry-run with no candidate on a machine later confirmed healthy, AND a benchmark of at least 30 labelled fixtures, including healthy-but-unpermissioned and saturated machines, at the meter's rate floors. Grades do not use "canaries cleared after a restart", which a restart nearly always achieves: a restart grades right only when the gentle rungs had already failed and evidence was still present immediately before it, and wrong when evidence cleared during the notice period.

One floor set, for every automatic restart: machine enrolled unattended or proving; `reserve()` admits it (brakes, not `proof-failed`); no Part D safety hold, and no D1, D2, D3 or D7 active. For wedge `restart-now`, D1's input test narrows from 15 to 5 minutes. Presence unreadable during a candidate blocks for at most 2 hours, then the operator is told plainly and the agent does not guess. Model unavailable or unparseable: **no forced restart.** The deterministic fallback runs the gentle rungs, then records `forcedDueAt` as above. So the ladder always ends at a defined step.

**Ladder,** each rung verified by re-sampling the positive families for 2 minutes before moving on. A rung whose feature is in dry-run is skipped and recorded:

1. Close instar's own idle browsers and sweep (Part B).
2. Pattern-listed dialogs and the `CoreServicesUIAgent` step (Part B).
3. Restart Instar's own desktop helper, skipped and recorded during a live desktop grant or operator input in the last 5 minutes.
4. Short planned restart: Part D's short drain.
5. Rung 1 privileged restart.
6. Rung 2 forced restart, once, if the process is still alive after 8 minutes.
7. Operator: attention item saying plainly that the machine needs a hand, and what evidence remains. While wedge restart is in dry-run, a confirmed candidate reaches this at once with no rungs run: the notice is real, carries Restart now, and also records `forcedDueAt`, so a two-family candidate is never treated more weakly than one family.

The judge chooses the entry point: `gentle` runs 1–3. `restart-next-window` runs 1–3 and records `forcedDueAt`, so the next window's ordinary drain does the rest. `restart-now` runs 1–3 then 4, outside the window and with the short drain. Rung 5+ always follow 4. Wedge actions hold the floor above and the receipt rule through the short drain, which is bounded to 10 minutes in total; at the bound it actuates only if that floor holds and receipts exist, otherwise it aborts and notifies with Restart now, which, being an operator action, actuates. A hung co-resident agent on a wedged machine therefore lands on the owner's tap, not on an automatic restart over unknown work. Rung 6 is the same episode and does not re-run the drain.

**Operator trigger.** "Restart now" on the card (any machine, relayed by signed mandate, and on `attended` machines too) runs from rung 4 at once. It passes every delay and brake except `reserve()`'s 6-hour rule, which it may override with a second confirmation. S3 and S4 are named first, and the tap passes them; S1 and S2 refuse it, and the card says why. It is a human action on the always-allow lane of the governor. It runs the short drain, not a bare restart, so work still yields.

**Lifeline path.** If the server is down but the lifeline is up, `/lifeline restart-machine` actuates rung 5. `handleLifelineCommand` gates nothing on identity today, so this command compares `fromUserId` with the verified operator uid recorded in `enrolment.json`, and refuses if absent. The reply names any other human on the machine and any S1 or S2 hold, which refuse it, and the command takes effect only on a typed `/lifeline restart-machine confirm` within 2 minutes (button presses are refused while the server is down). It calls `reserve()` and `claimRung` directly, with the same operator semantics as Restart now: the ledger records it, and its reply names any brake it is passing. The drain is skipped, so no resume entries are written and autonomous runs get no revival attempt; the reply says so. If the machine is still up 8 minutes later, the lifeline says so and a typed `/lifeline restart-machine force` runs rung 6. Requires an enrolled machine. It reaches only the machine whose lifeline polls Telegram; a standby's lifeline is suppressed, so a wedged standby needs the card.

**Brakes (durable ledger, host-level, enforcing from day one, not observe-only):**

| Brake | Limit |
|---|---|
| Any automatic restart | Not within 6 h of the last boot (except rung 6 of the same episode) |
| Wedge-triggered | 2 per 24 h, 3 per 7 days |
| Scheduled | 1 per 5 days; a `rolled` night spends none |
| After `proof-failed` | No automatic restart until the proof passes or the operator clears it |
| Aborted episodes | 3 rows ending `aborted` or `refused` in 7 days: no new automatic episode until the operator clears it, with one attention item. Aborts spend no restart budget, yet each one closes admission and may hand off the lease |
| During `outcome-unknown` | No new automatic restart |
| After a wedge restart whose evidence returns within 6 h | No further automatic restart; attention item says restart did not fix it |
| Governor | New class `machine-restart` in `GOVERNOR_DEFAULT_POLICIES` (`direction: relief`, `resource: hardware-bound`, `failDirection: closed-queue`, mode override `enforce`) and a modelled entry in `SELF_ACTION_CONTROLLERS`. A `queue` outcome is treated as refused at actuation and nothing is retained, because a queued restart must never fire later. `emergencyDisable` passes the class through; the ledger brakes still hold |

A boot loop cannot arise from Instar because each attempt is on disk before it happens and the ledger is checked before actuating. A boot loop from another cause is met by the agent doing nothing but the proof; it is not this feature's to fix. Corrupt or unreadable ledger: automatic restart refused (fail closed) and one attention item. An operator request sets the bad file aside and starts a new ledger, so `reserve()` still commits first.

### Part F: operator controls

Three controls, from the dashboard, the app and the question's own buttons:

- **Skip once:** this restart does not happen, and the next try is after `skipUntil` (72 h per tap). It never needs a reason. During a drain it closes the episode as `rolled`, with the same "carry on" notices.
- **Change window:** start and end for this machine, at least 2 hours long, effective from the next commitment. A drain already announced keeps its T-0.
- **Restart now:** Part E's operator trigger, with the short drain.

The app gets one fixed addition to its device-signed list: `GET /mobile/machine-care` and `POST /mobile/machine-care/:machineId/:action`, for `skip`, `window` and `restart`. A paired phone was enrolled through the owner's private code, so its Secure Enclave signature identifies the owner's device. Skip and window are in the safe direction, so an active device's signature is enough. `restart` also requires an in-app confirm naming the machine and what will be ended, bound to that action and expiring in 2 minutes. These go through the same store and audit as the dashboard, marked `viaMobileDevice`. The app's screen ships in the app's own release; until then the dashboard works on a phone.

Config, read live:

```json
"machineMaintenance": {
  "ownershipByMachine": {},
  "cadenceDays": 7,
  "window": { "start": "03:00", "end": "06:00" },
  "maxIntervalDays": 10,
  "maxEpisodeDelayMinutes": 120,
  "drain": { "maxMoves": 6 },
  "scheduledRestart": { "dryRun": true },
  "wedgeRestart": { "dryRun": true },
  "browserCare": { "enabled": true, "dryRun": true, "maxPerAgent": 4, "maxPerHost": 8, "idleMinutes": 30, "ttlMinutes": 120 },
  "dialogCare": { "enabled": true, "dryRun": true }
}
```

`enabled` is omitted so it resolves through the development-agent gate until Phase 5; `migrateConfig` adds the block without it. Enrolment is the machine's on switch. `enabled:false` is the off switch for the whole feature, re-read immediately before actuation.

Routes: `GET /machine-maintenance` (mode, readiness, last boot, next due, committed T-0, phase, active delays with minutes used, safety holds, yields, plan, brakes, last proof, last rehearsal, browser counts; `?scope=pool` merges with dark-peer-tolerant `failed` rows), `GET /machine-maintenance/lock-state`, `POST /machine-maintenance/enrol`, `/skip`, `/unskip`, `/window`, `/restart-now`, `/remove`, `/do-not-maintain` (all operator session, remote targets by signed mandate), `POST /machine-maintenance/tick` (Bearer, lease-free, single-flight). All are registered in `WriteDomainRegistry` as machine-local.

Surfaces: the dashboard "Machine care" page, reachable from the console's home, shows one sentence per machine ("Restarts weekly. Last clean start 3 days ago.") with Skip once, Change window, Restart now, Off. It works on a phone. `GET /guards` carries rows for the monitor and sweep.

Migration Parity: `migrateConfig` adds the block with existence checks; `migrateClaudeMd` adds the card with a content-sniff guard; browser scripts ride the existing always-overwrite installer; the existing `/normal-chrome-browser` skill's new close rule uses the hash-gated content migration; where the feature resolves on, the one attention offer fires per machine. On update a fleet agent is dark until Phase 5. Nothing restarts without the tap.

Agent Awareness card (added to `generateClaudeMd`):

> **Machine self-maintenance** — I keep my machines healthy: a clean restart about weekly in the small hours and if a machine wedges, plus closing browsers I opened. A scheduled restart is a commitment: every agent on the machine is told in advance through one host record, new long work stops, and running work checkpoints, is paused and resumes afterward. Each machine needs its owner's one tap on the dashboard's Machine care page; a machine I do not own is never restarted, and a machine that would stop at a login screen is never restarted by itself. Read before answering: `curl -H "Authorization: Bearer $AUTH" "http://localhost:4042/machine-maintenance?scope=pool"`. If I get a stop-at-next-boundary notice, I save my place and stop: it is not a failure and I will be resumed. A `HostDrainingError` from a test run is not a test failure. Is the screen really locked? `GET /machine-maintenance/lock-state`, and `unknown` means unknown. Never run a restart or `sudo shutdown` by hand: send the operator the Machine care page. Close what you opened with `chrome-close.sh`. **When to use** (PROACTIVE): the operator says a machine is unreachable, stuck or full of windows → read the status, then offer Restart now; "why did this machine restart?" → read `logs/machine-maintenance.jsonl`; "why was my work paused?" → `logs/machine-drain.jsonl`; a machine shows `attended` → name the one missing setting.

## Decision points touched

| Decision point | Class | Floor / justification |
|---|---|---|
| May this machine ever be restarted (enrolment) | `invariant` | Owner's verified tap, per machine. Irreversible-to-others action, rung floor 1. |
| Unattended vs attended (readiness) | `invariant` | A machine with FileVault on or no auto-login physically cannot return unaided. Unknown means attended. |
| Refuse: throwaway, not owned, other user | `invariant` | Safety property with no competing signal. |
| Restart count brakes, proof-failed latch | `invariant` | Capacity Safety convergence bound. |
| Safety holds S1–S4 | `invariant` | Positive evidence only. Restarting through them can do lasting harm, and a person at the keyboard always wins. Reported every time. |
| The delay list and each maximum | `invariant` | Closed list, fixed limits, set by the operator's instruction that a restart is a commitment. An agent can claim a listed delay and cannot add one or extend one. |
| Restart on the owner's silence (final night) | `invariant` | One plain question with a delivery receipt, a day's notice, one tap to change it. Work with no resume path is ended only on this path. |
| Undeclared work | `invariant` | Default D2: bounded and named. A build test stops new kinds from shipping undeclared. |
| Does work yield or hold T-0 | `judgment-candidate`, exempted | Competing signals: real work vs a promised restart. Argued exemption: the operator decided the direction, work with a resume path yields, and work without one reaches him by name. A wrong call costs one paused, resumable turn or a night's roll; a judge here would add a model dependency to the routine path and a way to argue with the commitment. Floor: delay table and yield contract; default: restart at T-0; end rung: the owner's question. |
| Is this machine wedged and what to do | `judgment-candidate` | Floor: two-family, 3-sample, 20-minute gate; bounded action space of 4; conservative default `leave`/`gentle`; arbiter `machineWedgeJudge`; ladder ends at deterministic fallback (gentle rungs + next-window restart) then operator. |
| `lockState` verdict | `invariant` | Deterministic table; conflict returns `unknown`. |
| Should this browser close | `invariant` | Ownership proof, plus a completion signal, an expired declared-disposable lifetime or a confirmed absent owner, plus no unsaved input and no live download. Uncertainty keeps the instance and reports it. A wrong close can lose page state, so the rule does not rest on a relaunch being cheap. |
| Dismiss this dialog | `invariant` | Positive pattern list, inside a confirmed wedge only, one-button alerts only; never a permission prompt. Everything else is report-only. |
| `MaintenanceGate` refuses automatic work | `invariant` | Closes in two stages (long work at T-60, all automatic work at T-10). Bounded by plan `expiresAt`, checked by every server, except `outcome-unknown`, which holds until a reboot, a verified cancellation or the owner's decision, with the owner told at once. |
| Is the reboot off | `invariant` | A failure shown to be before dispatch is `refused`, exit 0 is `accepted`, everything else is `unknown`. A timeout never reads as cancelled. |
| Pool `maintenance-claim` admit | `invariant` | Earliest claim wins, ties to lower machineId; a mechanical best-effort stagger with no competing signals. |

## Verify the State, Not Its Symbol

| Detector / gate | Symbol | Claimed state | Independent corroboration | Unmeasurable |
|---|---|---|---|---|
| `lockState: locked` | Session flag | A password is really needed to use the screen | Password policy reading plus loginwindow shield; a real capture attempt settles it | `unknown`; capture is attempted, no refusal on the flag |
| Restarted | Server started | The OS actually rebooted | OS boot time newer than the ledger row | `proof-failed` |
| Came back | Local `/health` 200 | Reachable by the operator | Tunnel URL fetched through the tunnel; peer sees the advert | Check marked `unknown`, proof not passed |
| Peer watch | Advert absent | Machine failed to return | Past `plannedRestart.until`, all ropes down | `unknown` raises the item, the safe side |
| Wedge candidate | Canary or capture failure | Machine's GUI or process path is unusable | A second, causally different family in the same 20-minute window; the probe passed here earlier this boot | A hung or missing sample is unknown, neither positive nor a reset; a gap over 6 minutes restarts the window |
| Stuck dialog (F3) | Window survives a press | The dialog cannot be cleared | The press happened and the re-list saw the same window | `unavailable-no-permission`, never evidence |
| Dialog in range | Local pattern and button count | A harmless launch-failure alert | Owner process, one button only | Report-only |
| D1: owner at the machine | HID idle time | Nobody at the machine | Live desktop grant, AnyDesk connection, recent message, Instar's own driver audit | Unreadable counts as D1, so it is bounded; during a candidate, for at most 2 h |
| S3: person using it now | Recent console input | A human, not automation | Instar's own driver audit is discounted | No reading means no hold; D1 already covered unreadable, and an unreadable source must not become an unbounded stop |
| S1, S2: install or disk operation | Named process or lock | The operation is really running | Live process holding the lock, or a reading proven in L7 | No hold; a bare process name with no proven reading does not count |
| Work yielded | Ack `ready`, or notice sent | The work really stopped | `readBack()`: holder released, process gone, state file marked | Counted as not yielded, then D3, and named in the proof |
| Rehearsal yield time | Natural boundary seen | How long a real yield would take | The session, run or job's own end or turn boundary | Censored at T-0 and recorded as over the limit |
| Reboot cancelled | Machine still alive after the wait | The dispatched shutdown will not complete | An OS reading proven in L3 | `outcome-unknown`; admission stays closed and the owner decides |
| Browser work finished | Declared-disposable lifetime expired, or owner gone | Nothing in that browser still matters | Completion signal, fresh owner read, per-tab unsaved-input check, download growth | Kept and reported |
| Privacy permission usable | Stored flag, or prompt shown | The helper can really capture and drive input | Live probe at enrolment and at readiness | Not ready |
| Unattributed reboot | Boot time with no ledger row | A restart not made by this feature | Ledger under lock | Treated as unattributed |
| Operator absent on Linux headless | No last-input reading | Same | Logged-in tty sessions | No tty means absent; a tty with activity under 15 min means present |
| Owned browser | `--user-data-dir` in jail | Instar opened it | Ledger entry with (pid, start time), or adoption rule | Not closed |
| Auto-login set | `autoLoginUser` value | Machine returns unaided | Proving restart | `attended` |
| FileVault off | `fdesetup status` | No pre-boot password | Proving restart | `attended` |
| Reboot grant installed | `sudo -n -l` exact line | The command will run and nothing broader was installed | Hash of installed bytes; proving restart | Not enrolled |
| Operator chose this | Approve press from bound operator | The person answerable for the agent agreed | Fresh dashboard unlock; authenticated sender | Not enrolled |
| Question delivered | Send attempted | The owner can see it | Delivery receipt | No default; the night rolls and status says why |
| Peer `ok` on claim | Signed reply | No concurrent restart known to that peer | Plan state in the same reply | Unreachable peer recorded; overlap is possible and accepted |

## Self-Heal Before Notify fields

**WedgeMonitor.** Class: `recoverable`, except while no healing rung can act (dry-run), when a confirmed candidate notifies directly, because there is nothing to wait for and pretending otherwise would be a no-op heal. Self-heal and `remediation-actions`: rung 1 close owned browsers (idempotent, by identity), rung 2 pattern-listed AX press and `CoreServicesUIAgent` restart (re-listed; launchd restores), rung 3 helper restart, rungs 4–6 privileged restart (idempotent through the `reserve()` episode). Compensation: rungs 1–3 restore by relaunch; a restart cannot be compensated, so it is bounded by the brakes. Brakes: `max-attempts: 1 ladder per episode`; `max-wall-clock: 30m to rung 4` for `gentle` and fallback, `10m` for `restart-now`; `backoff: 2m verification between rungs`; `dedupe-key: machineId + episode`; `breaker: 3 candidates in 24h reclassify critical and notify`, flapping included; `max-notification-latency: 300s` measured from gentle rungs exhausted, and rung 4's own notice covers `restart-now`; `audit-location: logs/machine-maintenance.jsonl` (metadata only).

**PostRestartProof.** Class: critical for the machine not returning (the peer notifies past `until`, no heal-gate) and for a failed check after its bound. Self-heal and `remediation-actions`: one restart per failing component through its existing supervisor (server, lifeline, tunnel), `POST /agent-identity/reload` for relay identity. Idempotent because supervisors are. Compensation: none needed. Brakes: `max-attempts: 5`; `max-wall-clock: 10m`; `backoff: 2m`; `dedupe-key: restartId + check`; `breaker: latch proof-failed`; `max-notification-latency: 300s` past the bound; `audit-location: logs/machine-maintenance.jsonl`.

**Browser sweep / dialog probe.** Class: `recoverable`. They raise no operator notice; the cap refusal is a reply to the caller and repeated sweep failure is a degradation report. `remediation-actions`: close by identity. Brakes: 5 closes per pass; `max-attempts: 1 per instance per pass`; `backoff: next pass`; `max-wall-clock: 60s`; `dedupe-key: instance identity`; `breaker: 3 failed passes pause sweep 24h`; `max-notification-latency: not applicable` (no notice); `audit-location: logs/browser-care.jsonl`.

**DrainController.** Class: `recoverable`: each yield that fails is retried or falls to a delay before anyone is told, and the plan's own notices are scheduled commitments, not alarms. Self-heal and `remediation-actions`: re-issue a yield to that kind (idempotent, keyed by episode and work identity), release a stale claim through `generation`, roll the episode. Compensation: every call-off runs each kind's `undoYield()` from the durable yield rows, with read-back, and reopens the gate. Brakes: `max-attempts: 3 per work item per episode`; `max-wall-clock: 180m` (T-60 to the ceiling); `backoff: 60s`; `dedupe-key: episodeId + work identity`; `breaker: 3 aborted episodes in 7 days stop automatic episodes and raise one item; rolled episodes bounded by maxIntervalDays`; `max-notification-latency: 300s` from a yield given up to its line in the notice; `audit-location: logs/machine-drain.jsonl` (metadata only).

**Owner question.** Class: critical in the sense of the heal-gate, because the question is the deliberate end rung, not a detection. One per episode plus the expiry of any Skip; send retried with backoff until a receipt; `dedupe-key: machineId + final episode`.

**Enrolment offer.** Not a watcher: one item per machine, again only on new facts.

## Multi-machine posture

Default `unified`: `GET /machine-maintenance?scope=pool` is a proxied-on-read merged view, the dashboard page is served from any machine and relays actions by signed mandate, notices are one-voice (the maintainer of the machine, the lease holder for non-return), and the claim is a mesh command. The drain is global across agents and machines: the host record reaches every agent on the login, `plannedRestart` in the presence advert reaches every pool peer from T-60, and each agent drains its own work. Serving moves by planned handoff. Recently active conversations move by cooperative transfer where a healthy peer exists, and the rest stay owned here and resume from `--resume` and the snapshot on this disk. A draining machine is never a target for placement, transfer, overload shed or a Local Verify peer run. No machine coordinates another's drain; each claim is best-effort staggering.

Machine-local surfaces:

- Host enrolment, drain record, acks, restart ledger: a physical machine's restart history, consent and commitment.

machine-local-justification: hardware-bound-resource

- Wedge samples and lock state: reading of this machine's own hardware and session.

machine-local-justification: hardware-bound-resource

- The sudoers rule: an OS grant on one physical machine.

machine-local-justification: hardware-bound-resource

- Browser ledger and profile close-out: describes live processes on one machine.

machine-local-justification: hardware-bound-resource


Single machine: claims, handoff and moves are no-ops, the rest of the drain runs unchanged, non-return is unobservable, so the proving restart needs the operator's tap.

## Frontloaded Decisions

1. **On by default, one tap per machine, no silent start.** Reversible, per machine. Why not fully automatic: a reboot is rung-floor 1, and the tap also answers "is this machine really yours".
2. **Cadence 7 days since last boot, 03:00–06:00 local, T-0 04:00, 120-minute delay ceiling, 10-day maximum interval.** Config. Replaces the 3-day wait and the unbounded blockers, by the operator's instruction of 2026-11-01.
3. **Lease holder restarts last; no central coordinator; claims over signed mesh.** Matches the decentralized-by-default direction. Unenrolled and unreachable peers do not block.
4. **Recently active conversations move where possible; the rest stay.** Reversed from the first version by the same instruction. Bounded to 6 moves, no move back, pinned, Slack and autonomous topics stay.
5. **Co-resident agents take part through a host file, with no shared token.** A silent older agent is D3 for 30 minutes, then rolls, then is named on the final night's question.
6. **M5 Pro:** `ownershipByMachine: shared` on Echo, never offered by Echo. The do-not-maintain marker stays a card setting; nothing writes to that machine at build.
7. **`fdesetup authrestart` not used; no password stored; no FileVault or auto-login change made for anyone.** Laptop-class machines get reminders.
8. **Instar never handles a machine password.** macOS uses its own administrator dialog; Linux without passwordless sudo is refused. Rejected: a Secret Drop, even a new server-consumed class: it is more mechanism, and a tunnel terminates TLS at a third party.
9. **No wrapper script and no root daemon.** Exact sudoers lines. Fewer root-owned things.
10. **Scheduled restart starts watch-only and enforces on the drain evidence below; wedge restart starts dry-run on every machine and leaves it only on the graduation evidence in Part E, never on a calendar alone.** Dry-run still sends the operator the real notice with Restart now.
11. **Browser care starts dry-run for 7 days,** live after a soak with no would-close of something in use. **Dialog action** needs a wedge, so it stays dry-run until wedge restart graduates.
12. **Linux desktop dialogs and Windows dialogs are out of v1,** reported as `not-covered`. **Windows + WSL is attended-only in v1:** Mama PC can be restarted by tap and reminded, and a WSL boot-autostart installer is not in v1.
13. **The app gets one fixed machine-care addition.** Reversed by the instruction naming the app. Dashboard on the phone is the surface until its screen ships.
14. **Graduated rollout:** dev-gated live on Echo first through the phases below; fleet default on once L1–L7 pass. Throwaways excluded forever.
15. **Unsaved input in an owned browser is delay D7, not a safety hold.** Reasoned in Part D.
16. **A person typing now is a safety hold on every night, the final one too.** The default ends work; it does not interrupt a human.

No choice here is tagged cheap-to-change-after: restarts and notices are durable effects, so each is decided above.

## Maturation plan

- **test-agent-live:** the integration and E2E tiers run the rehearsal on the production init path against temp homes, with real Local Verify, session and limiter readings faked only at their seams, and assert that it changes no state and that no restart command exists on that path. Throwaway agents never run it.
- **dev-agent-live:** live on the development agent from the release that carries Increment 1: watch-only on every development host, every night, due or not. Read `GET /machine-maintenance` and `logs/machine-drain.jsonl` each morning for the first week.
- **graduation criterion:** the per-host evidence gate below (14 rehearsal nights, no undeclared kind in the last 7, each declared kind seen at least 10 times or named as unobserved, 95th percentile of `stop-at-boundary` work under its 15 minutes), and round 9's three fixes read by a reviewer before any increment makes the drain real.
- **fleet:** dark on the fleet until Phase 5, on L1–L7 passing. No enrolment is offered and nothing restarts before then.
- **dark-window:** the watch-only rehearsal is bounded by the 14-night gate; if it has not produced evidence 30 days after merge, the review job re-decides it.

Phase 1, no privilege: Part A; browser ledger, helpers, cap; dry-run sweep and dialog probe; readiness probe and status route; WedgeMonitor dry-run. Phase 2: enrolment, rule install, `RestartActuator`, brakes, Part D with the drain in watch-only mode, proof. Phase 3: watch-only soak, then enforcement, then Echo's machines: Studio (proving), then Mini after its readiness is read; Laptop and Mama PC per their readiness, likely attended. Phase 4: wedge restart live on the graduation evidence. Phase 5: fleet default.

**Watch-only evidence.** With `scheduledRestart.dryRun` on, every enrolled or unenrolled agent on a development host runs the drain on paper, every night, due or not, against a real T-0 in the window. It stops nothing, refuses nothing and sends no notice. Each phase writes to `logs/machine-drain.jsonl` what it would have done: work it would have refused, conversations it would have moved and where, sessions it would have told, what it would have cancelled, which delays and holds would have applied with their minutes, whether the night would have rolled, and what on the final night would have been ended.

Yield time is measured from real work. From the moment a yield would have been asked, the rehearsal records when that work next reached its own yield point: the session's next turn boundary, the run's or job's end. A result past T-0 is censored and recorded as over the limit. It reports per `kind`: count, median, 95th percentile and censored count, in `GET /machine-maintenance` under `lastRehearsal`, plus any undeclared work it found.

Enforcement needs, per host: 14 nights of rehearsal; no undeclared kind seen in the last 7; each declared kind seen at least 10 times, or named as unobserved; the 95th percentile of `stop-at-boundary` work under its 15 minutes, or those slot times changed first. It is a recorded evidence gate, and the flip follows it with no operator step. Restart now uses the real short drain throughout, so the operator can restart a machine before this ends.

**Run boundaries.** The first build run is Phase 1 and Phase 2 code plus L1, L2 and the integration tiers, and it needs no operator input; wedge and enrolment code reach the machines inert, and the drain reaches them watch-only. The next run starts when the operator taps enrolment on the Studio. That single tap is the boundary. L3–L7 and Phases 3–5 are later runs, and each named soak is a timer, not a stop-and-ask. A possible administrator dialog for a Mac without passwordless sudo, and a no-peer proving tap, arise only in those later runs.

**Increment 1 as built.** The core, watch-only: the planner, the host drain record, the yield contract as a declared table, the drain on paper, delay and hold readings, audit log, `GET /machine-maintenance`, one line on the console's Machines page, the awareness section. It has no callable that can stop work or restart a machine, and a source test holds that. These parts of the Phase 1 and 2 scope above are left for later increments:

- Real yields, `MaintenanceGate`, `RestartActuator`, `claimRung`, restart ledger and brakes, `PostRestartProof`, notices, the owner question, the pool claim and advert, `planned-restart` resume entries, `?scope=pool`, and the D4, D5, D6 and D7 readings, which report `active: null` until then. <!-- tracked: CMT-1199 -->
- Enrolment taps, readiness, the reboot rule. <!-- tracked: CMT-1200 -->
- Browser cleanup, Part B. <!-- tracked: CMT-1201 -->
- Wedge restart, Part E. <!-- tracked: CMT-1202 -->
- App controls, Part F, and the POST routes. <!-- tracked: CMT-1203 -->
- Honest lock reading, Part A. <!-- tracked: CMT-1204 -->

Frozen carrier text, from `docs/specs/carriers/machine-self-maintenance.json`; each is carried on a date by an evolution action, ACT-173 to ACT-178 in the same order:

> **CMT-1199** — "Build the real drain of machine self-maintenance: the restart path, real work yields, the gate, restart proof, notices, the owner question, the pool claim and advert, resume entries, pool scope, and the D4 to D7 readings."

> **CMT-1200** — "Build machine enrolment for self-maintenance: the owner's tap, readiness, and the reboot rule install."

> **CMT-1201** — "Build browser cleanup for machine self-maintenance: the ledger, close helper, sweep and cap."

> **CMT-1202** — "Build wedge-triggered restart for machine self-maintenance, dry-run first."

> **CMT-1203** — "Build the operator controls for machine self-maintenance: skip, change window, restart now, on the dashboard and app."

> **CMT-1204** — "Build honest lock reading for machine self-maintenance."

Left out as not needed for watch-only evidence, each returning with the increment above that needs it: the `moved conversation target` in the rehearsal, D1's desktop-grant, AnyDesk and recent-message inputs and its discount of Instar's own input, D2's CPU reading of a foreign tmux session, the `maintenanceDue` advert, per-boot fsync of the record, a `machineMaintenance` block written by `migrateConfig` (absent config uses the code defaults), and the `DrainController` name: this build is `DrainRehearsal`, because it does not control anything. Two phases of the evidence differ from a real drain on purpose: phases keep the original T-0 so a rolled night still measures yields, and a dark co-resident agent reads as D3 until it carries this build.

## Tests

Three tiers, all with an injected actuator. `RestartActuator`'s real path has one lint-pinned callsite and refuses under test.

- Unit: `lockState` table including every conflict row; `reserve()` and `claimRung` concurrency across all four paths, stale generation and expired plan; no episode-bearing write before `reserve()`; each row ending against budget and the abort brake, `rolled` included; drain phases fire at their offsets whether or not work is running, and shift with T-0; each delay on both sides of its maximum, stacked delays against the 120-minute ceiling and the window's end, a delay outside the list refused from an ack, a co-resident claim unable to extend a maximum; final night proceeding through D1, D2, D3, D6 and D7 but not any safety hold; final-night default withheld with no delivery receipt; S1–S4 both sides, with no reading meaning no hold; call-off after each destructive phase, for every kind and each cause (roll, Skip, expiry, refused Rung 1, Keep running), with markers cleared, same-boot revival, and a server down during the undo; a missing receipt in `receipting` rolling an ordinary night and not entering `armed`; S1 or S2 appearing during a short drain refusing an operator dispatch and the lifeline's `force`; yield table per kind including `readBack` showing not yielded; Local Verify `yieldForRestart` keeps queue position and leaves `interruptions` unchanged; `HostDrainingError` by lane and time; registry test failing on an undeclared spawn chokepoint; undeclared work reaching D2; rehearsal mode changing no state, with censored yield times; dispatch outcome for exit 0, command nonzero, sudo refusal, spawn failure, timeout, signal and a crash after the claim; ledger brakes, unreadable-ledger fail-closed; state machine persisted across a simulated crash at each state; claim ties; browser ownership (operator Chrome path, pid reuse, excluded profiles); sweep both sides of each close condition, including live owner with a running lease, declared lease with owner gone, and unreadable owner; unsaved input yes, no and unreadable for sweep, cap and `chrome-close.sh`; dialog allowlist never matching `SecurityAgent`; wedge gate with one family sustained (no candidate), two (candidate), a reset, a missing sample, a gap over 6 minutes, stale evidence at judge and rung 4, and accelerated sampling; F1 ineligible on a healthy unpermissioned machine; judge fallback; `machine-restart` in `tests/unit/self-action-convergence.test.ts` under sustained wedge fixture.
- Integration: routes over HTTP (503 dark, operator-session refusal, signed relay refusal on a bad mandate, throwaway refusal); acks from a stub co-resident; a full drain with stubbed Local Verify, a test holder, a job and an autonomous run, in order; `MaintenanceGate` two stages; pool peer refusing to place on a `plannedRestart` machine; skip, window and restart from dashboard and signed app routes, refused without a device signature or confirm; resume drain of `planned-restart` with queue dryRun on, and held until boot time advances; `MaintenanceGate` with `WorkAdmission` disabled; plan expiry reopening with a dead maintainer; lifeline command refused for a non-owner and without `confirm`; a refused Rung 1 cancels resume entries; timeout and accepted-but-alive keep entries and admission closed past plan expiry and across a server restart; Keep running and a late reboot each resolve `outcome-unknown`.
- E2E: production init path: feature alive, `GET /machine-maintenance` 200, wiring integrity for every injected dep, migration on an existing home.
- Live (`Live-User-Channel Proof`), on real machines, ordered: **L1** lock matrix. **L2** browser close-out with the operator's own Chrome running. **L3** Studio proving restart with a deliberately hung test app open, proving `shutdown -r` is not vetoed, and all proof rows green; time to return recorded; and, for each OS, whether any reading tells a pending shutdown from a cancelled one. **L4** live session plus autonomous run on a co-resident throwaway resumes. **L5** lease handoff and peer non-return alert with the proof deliberately delayed. **L6** enrolment from a phone, end to end, through the dashboard, with a machine refused for each reason. **L7** a real drain on the Studio with every declared work kind deliberately running, on throwaway co-resident agents, including a foreign process and a test suite: each yields on time and returns with no human step, and the safety hold readings are shown to tell a real install from none on each OS. The operator's only part before these pass is the enrolment tap in L3 and any Mac administrator dialog; L6 uses Echo's own driven phone-width browser against a throwaway agent.

## Honest limits

- A machine hung below user space, or whose restart stalls after the agent's process died, cannot restart itself. A pool peer tells the operator. A single machine cannot. Hardware help (smart plug, `pmset autorestart` with power cycling) is a physical purchase and out of scope.
- Rung 2 on macOS (`reboot -q`) risks unflushed application data. It only runs after rung 1 failed for 8 minutes.
- A controller frozen between `claimRung` and spawning the command can still fire after takeover. Tested for the lock's behaviour; the residual is one extra, counted restart.
- A 2026-11-01-style state showing one family gets a next-window restart, not an immediate one; the operator can always tap Restart now.
- A restart is a remedy, not a diagnosis. The ledger, wedge samples and "restart did not fix it" brake keep the unknown cause visible.
- Everything here runs as one OS user, so operator proof is cooperative: a session deliberately reading the protected ingress secret could forge a press, and a session can run the sudo rule. Reboots are detected at the next boot, not prevented.
- Linux without passwordless sudo cannot be restarted by Instar in v1.
- After `outcome-unknown`, automatic work on that machine stays paused until a reboot, a proven cancellation or the owner's reply. A person's own sessions still start.
- A live owner that declared a disposable lifetime and then keeps background work in that browser can lose it when the lifetime ends. The unsaved-input check sees ordinary form fields. Text held only in a page's own memory or drawn on a canvas reads as no input. A browser kept as unreadable is reported, and it can hold the cap until someone looks.
- A foreign process the owner has not answered about is ended by the final night's restart. That is the operator's chosen default, stated on the card, in the question and in the notices.
- A safety hold on a hung installer stops automatic restarts until someone looks. It is reported every night.
- An agent under a different OS login cannot read the drain record, and enrolment sees another user's agent only if it has a tty or shows as that user's processes on the card. It is treated as foreign work.
- A session that holds no boundary loses its in-flight tool call at T-5. The revival note says what was running.
- Local Verify work moves to a new lease holder only if that holder has a source checkout; otherwise it waits here for the return.
- Yield slot times are first estimates until the rehearsal measures them.
- Whether macOS reopens windows after `shutdown -r` is measured in L3, not assumed.

## Side effects and rollback

`enabled:false` stops everything, read live, and leaves the sudoers file inert. Reverting the release leaves: an inert sudoers file, inert host files, and browser-ledger files. The `screenLocked` field stays so a rollback changes nothing for old dashboards. After a revert no code reads the plan, so a stale plan does nothing. A restart that has happened cannot be rolled back; the brakes bound how many can.

## Open questions

*(none)*
