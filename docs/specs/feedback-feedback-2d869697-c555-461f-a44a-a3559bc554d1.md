---
title: "Unattended macOS startup posture and prolonged-outage disclosure"
slug: "feedback-feedback-2d869697-c555-461f-a44a-a3559bc554d1"
author: "Echo"
parent-principle: "The Agent Is Always Reachable — A Guaranteed Reachability Floor"
feedback-initiative: "feedback-2d869697-c555-461f-a44a-a3559bc554d1"
feedback-cluster: "cluster-agent-is-fully-dark-after-a-machine-restart-until-someone-lo"
severity: "critical"
status: "draft"
---

# Unattended macOS startup posture and prolonged-outage disclosure

## Problem statement

On macOS every instar recovery process is a per-user LaunchAgent in the `gui/<uid>` domain:
the agent (server or lifeline, `installMacOSLaunchAgent` in `src/commands/setup.ts`) and the
fleet watchdog (`installFleetWatchdog`, label `ai.instar.watchdog`). launchd starts none of them
until that user logs in at the console. After an orderly restart a host that nobody logs into
sits at the login window with the agent, its supervisor and its watchdog all stopped, and
nothing on the machine can observe or report that state.

The install and status surfaces say the wrong thing about this. `instar autostart install`
prints "Your agent will start automatically when you log in" on macOS, which is true in a way
that means *never* on an unattended host. `instar autostart status` reports only whether the
plist file exists. `instar doctor` has no startup check at all. On Linux the same gap was
already found and fixed for systemd lingering (`ensureLinuxLingering`,
`describeLingerOutcome`): the install reports whether the service starts at boot or only at
login, and never escalates privilege itself. macOS has no equivalent.

When the agent finally comes back, the lifeline has no record of how long it was gone. The
only thing the user saw was the per-topic `🔄 Session restarting — message queued.` notice
from `src/commands/server.ts`, which describes a session restart, not a multi-day outage.
Telegram keeps unconfirmed updates for roughly 24 hours, so an outage longer than that loses
messages permanently, and nothing tells the user which messages may be gone.

### Evidence

One scrubbed reporter account (received 2026-09-28, instar 1.3.1285, single-machine agent):

- Orderly macOS restart; the host sat at the login window for 71.5 hours. Server, lifeline and
  watchdog were all per-user LaunchAgents, so none started. No detection, no recovery, no
  notice to the user.
- No scheduled work ran for three days. Messages sent during the first ~47 hours were lost
  beyond Telegram retention; the survivors were answered ~20 hours late.
- On recovery the user was told only "Session restarting — message queued".
- The reporter also observed three related recovery gaps (weekly jobs not caught up, boot
  catch-up saturating the spawn cap ahead of interactive replies, a spanning script job
  reported as failure). These are real but are **out of scope here**; see "Out of scope".

The evidence is marked incomplete by triage; the single report above is what exists.

### Why the previous fix was refused

The earlier spec for this item (PR #2568) was refused by independent review for four reasons.
This draft is shaped to avoid each one:

1. It widened scope into Linux diagnostics, scheduler catch-up, spawn admission and script exit
   codes. This draft covers macOS startup posture and outage disclosure only.
2. It proposed new shell-outs and a privileged install into `/Library/LaunchDaemons` performed
   by instar. This draft never runs `sudo` or touches the system launchd domain; privileged
   steps are staged and printed for the operator, mirroring the Linux lingering precedent.
   Fact collection is file stats plus one bounded, read-only, unprivileged query.
3. It presented a boot-mode LaunchDaemon as an unattended-restart solution without addressing
   FileVault. This draft treats FileVault as a first-class posture fact and warns in both
   login and boot mode when it is on.
4. It lacked tests for the extra scope. Every change below names its regression test.

## Proposed design

### 1. One pure posture assessment, shared by every surface

Add `src/core/MacStartupPosture.ts` with a pure function
`assessMacStartupPosture(facts): StartupPosture`. Facts are collected separately and
injected, so the matrix is unit-testable without a Mac. Each fact is `true | false | null`;
`null` means "could not determine" and is reported as such, never assumed.

Facts:

| fact | how it is collected | reach |
| --- | --- | --- |
| `loginAgentInstalled` | stat of `~/Library/LaunchAgents/ai.instar.<name>.plist` | file stat |
| `bootDaemonInstalled` | stat of `/Library/LaunchDaemons/ai.instar.<name>.plist` and content equality with the staged copy (§2) | file read |
| `autoLoginConfigured` | stat of `/etc/kcpassword`; macOS creates it when automatic login is enabled and removes it when disabled | file stat |
| `fileVaultOn` | `fdesetup status`, read-only and unprivileged, bounded 5 s timeout, injected runner, `null` on any failure | one read-only query |
| `watchdogAgentInstalled` | stat of `~/Library/LaunchAgents/ai.instar.watchdog.plist` | file stat |

No other commands are introduced. The existing `plutil -lint` and user-domain `launchctl`
calls in `setup.ts` are unchanged.

Posture outcomes and their user-facing lines (final wording in implementation, meaning fixed
here):

| install | auto-login | FileVault | posture | message |
| --- | --- | --- | --- | --- |
| login agent only | off | off | `login-only` (warn) | Starts only after someone logs in at the console. After a restart an unattended host stays dark. Fix: enable automatic login in System Settings › Users & Groups, or run `instar autostart install --mode boot`. |
| login agent only | on | off | `unattended-via-autologin` (ok) | Starts after a restart because automatic login is on. |
| login agent only | any | on | `blocked-by-filevault` (warn) | FileVault requires a person at the pre-boot screen after every restart; automatic login and boot mode do not change that. An orderly restart you start yourself can skip it once with `sudo fdesetup authrestart`. |
| boot daemon | any | off | `unattended-via-daemon` (ok) | Starts at boot with nobody logged in. The fleet watchdog is still a login-time supplement. |
| boot daemon | any | on | `blocked-by-filevault` (warn) | Same FileVault line as above. |
| both login agent and boot daemon | any | any | `duplicate-install` (warn) | Two launchd jobs would start the same agent. Remove one: `instar autostart uninstall` for the login agent, or the printed daemon removal commands. |
| none | any | any | `not-installed` (warn) | Existing message, unchanged. |
| any fact `null` | | | `unknown` (warn) | Names the fact that could not be read. Never reported as ok. |

`instar doctor` gains a "Startup after restart" check that prints the posture line.
`instar autostart status` and the tail of `instar autostart install` print the same line in
place of the unconditional "when you log in" sentence. The watchdog line is informational:
in boot mode the lifeline supervises the server from boot, while the watchdog continues to
run only in the GUI domain. Making the watchdog boot-capable is a follow-up, not part of this
item.

### 2. `instar autostart install --mode login|boot` on macOS

`--mode login` is the default and is today's behaviour, unchanged. `--mode boot`:

1. Generates a LaunchDaemon plist with the same `ProgramArguments`, `WorkingDirectory`,
   `RunAtLoad`, `KeepAlive`, `ThrottleInterval`, log paths, `INSTAR_SUPERVISED=1` and the
   process-ceiling limits as the login plist, plus `UserName` set to the current user and
   `GroupName` to that user's primary group. It carries no GUI-only keys. The raise-only
   process-ceiling rule (`preserveHigherProcessCeiling`) applies against any existing staged
   copy.
2. Writes it to `<projectDir>/.instar/autostart/ai.instar.<name>.daemon.plist` (user-writable,
   `plutil -lint` validated as today) and records `{ mode: 'boot' }` in
   `<projectDir>/.instar/autostart.json`.
3. Removes the login-domain agent for this label through the existing user-domain
   `launchctl bootout` path, so the two cannot both start the agent.
4. Prints the exact operator steps and stops. instar never executes them:

   ```
   sudo install -o root -g wheel -m 644 <staged> /Library/LaunchDaemons/ai.instar.<name>.plist
   sudo launchctl bootstrap system /Library/LaunchDaemons/ai.instar.<name>.plist
   ```

   followed by `instar doctor` to confirm the posture reads `unattended-via-daemon`. When
   FileVault is on, the FileVault warning from §1 is printed above the steps so the operator
   is not promised unattended recovery that the host cannot deliver.

Switching back with `--mode login` reinstalls the login agent as today, records
`{ mode: 'login' }`, and prints the matching `sudo launchctl bootout system/...` and `sudo rm`
lines for the operator.

Startup self-heal and post-update migration paths that regenerate the login plist
(`markAutoStartExplicit` consumers, `autoStartNeedsLifeline`, `PostUpdateMigrator`) must read
`autostart.json` and, in boot mode, refresh the **staged** daemon plist instead of recreating
a login agent. If the staged file changes, the lifeline logs one line and the next
`instar doctor` reports `bootDaemonInstalled: false` with "staged copy differs from the
installed daemon; re-run the install steps", because instar cannot update the system copy.

`detectLaunchdSupervised` already recognises system-domain supervision through `ppid === 1`
and `INSTAR_SUPERVISED=1`; no change is needed there.

Known constraints to verify in the maturation plan, stated rather than assumed: a daemon runs
outside the user's GUI session, so it has no login keychain and a different TCC posture. The
agent reads its secrets from its own encrypted vault, not the login keychain, and the login
plist already avoids `/bin/bash` for TCC reasons, but boot mode is not declared supported for
the fleet until a real host has restarted under it.

### 3. Liveness marker so the lifeline can measure its own absence

The lifeline writes `<stateDir>/last-alive-at.json` every 60 seconds (atomic temp-and-rename,
mode 0600, same pattern as `startupMarker.ts`): `{ at, pid, version }`. The write is
best-effort and never blocks the poll loop. A missing or corrupt file means "unknown", which
suppresses the notice in §4; it never produces a guessed gap.

### 4. One prolonged-outage disclosure per recovery

Add a pure function `computeOutageDisclosure(input)` in `src/lifeline/outageDisclosure.ts`:

- Inputs: `lastAliveAt` (from §3, may be null), `startedAt` (this boot's startup marker),
  `bootAt = startedAt − os.uptime()` (no shell-out), `prolongedGapMs` (default 1 hour),
  `retentionMs` for the configured platform (Telegram default 24 hours).
- Output: `null`, or `{ offlineFrom, offlineUntil, lossBefore?, attribution }`.
- `attribution` is `'host-restart-without-login'` when `lastAliveAt < bootAt` and
  `startedAt − bootAt > 10 minutes` (the machine was up for a long time before the agent
  started), otherwise `'unknown'`. The attribution only chooses an extra hint sentence.
- `lossBefore = offlineUntil − retentionMs` is set only when the gap exceeds `retentionMs`.

On lifeline boot, after `ensureLifelineTopic`, the lifeline computes the disclosure and, if
non-null, sends exactly one deterministic notice to the lifeline topic through the existing
fixed-notice path (the same path `consumeDriftRestartPendingMarker` uses, never the LLM tone
gate):

> I was offline from {offlineFrom} to {offlineUntil} ({duration}). Messages sent before
> {lossBefore} may not have reached me. This host only starts me after someone logs in at the
> console; run `instar doctor` for options.

The last sentence appears only for `'host-restart-without-login'`; the loss sentence only when
`lossBefore` is set. Idempotency: before sending, the lifeline writes
`<stateDir>/outage-disclosed.json` recording `offlineUntil`; a disclosure whose `offlineUntil`
is already recorded is not sent again, so a lifeline crash-loop after recovery produces one
notice, not one per restart. The first user message forwarded to a non-lifeline topic within
the hour after that send receives the same text once, so a user who never opens the lifeline
topic still sees it. That is the full outbound surface: at most two sends per recovery
episode, both fixed text, both on the deterministic delivery path. The existing per-topic
`Session restarting — message queued.` notice is untouched.

### Out of scope, filed as follow-ups

The three recovery gaps from the report are separate behavioural changes and are not designed
here: weekly jobs whose slot fell inside an outage are not caught up by the boot sweep in
`JobScheduler`; background catch-up can saturate the host spawn cap ahead of interactive
replies for minutes after boot; a script job whose measurement window spans the outage exits
non-zero as "unmeasurable" and is recorded as failure. Linux diagnostics are also out of
scope; the lingering precedent is referenced only as the pattern to copy.

## Decision points touched

- **Privilege — invariant:** instar never runs `sudo`, never writes under `/Library`, and never
  calls `launchctl` against the `system` domain. The boot-mode install stages a file and
  prints steps. Same contract as `ensureLinuxLingering`.
- **Posture truth — invariant:** an unknown fact is reported as unknown. No surface may print
  "starts after a restart" unless the matrix row says so.
- **Outage disclosure — invariant:** fixed text, deterministic path, once per recovery, only
  from recorded liveness. No gap is inferred when the marker is absent.

## Multi-machine posture

All state in this spec is machine-local: launchd plists, `autostart.json`, the liveness marker
and the disclosure marker describe one host. None of it replicates. A standby node that wakes
up on another machine reports that machine's posture. machine-local-justification:
physical-host-locality — launchd domain membership, automatic login and FileVault are
properties of the host, not of the agent.

## Verification and acceptance

Each test is named with the change it guards; the first listed is the failing-then-passing
regression for the reported symptom.

- `tests/unit/mac-startup-posture.test.ts` — the full matrix in §1, including every `null`
  fact yielding `unknown`, `duplicate-install`, and FileVault overriding both auto-login and
  boot mode. The regression `login-only agent without auto-login is reported as a warning,
  never ok` fails on today's code because no assessment exists.
- `tests/unit/autostart-boot-mode-staging.test.ts` — staged plist content (`UserName`,
  `GroupName`, identical program arguments and limits, no GUI-only keys), `autostart.json`
  recorded, login agent booted out through the user-domain command list, and an assertion
  that the recorded command list contains no `sudo` and no `system` domain argument. Printed
  operator steps match the staged path. FileVault-on prints the warning above the steps.
- `tests/unit/autostart-mode-respected-by-selfheal.test.ts` — with `{ mode: 'boot' }`, the
  self-heal and migration regenerate paths refresh the staged daemon plist and write no file
  under `~/Library/LaunchAgents`; with mode absent or `login`, behaviour is unchanged.
- `tests/unit/lifeline/last-alive-marker.test.ts` — periodic atomic write, 0600 mode, a
  write failure is logged once and does not throw, corrupt file reads as null.
- `tests/unit/lifeline/outage-disclosure.test.ts` — null marker yields null; gap below one
  hour yields null; 2 h gap yields window without loss sentence; 71.5 h gap with 24 h
  retention yields `lossBefore = offlineUntil − 24 h`; `lastAliveAt` before `bootAt` with
  the agent starting 71 h after boot yields `'host-restart-without-login'`; a marker newer
  than `bootAt` yields `'unknown'`; retention per platform is honoured.
- `tests/integration/lifeline-outage-notice.test.ts` — a fake transport receives exactly one
  lifeline-topic notice across three consecutive lifeline boots with the same marker, the
  text is on the fixed-notice path, and the first forwarded message to another topic within
  the hour receives the one-line copy once. A boot with no `last-alive-at.json` sends nothing.
- `tests/unit/autostart-status-and-doctor-lines.test.ts` — `instar autostart status`,
  `instar autostart install` and `instar doctor` print the posture line and no longer print
  the unconditional "when you log in" sentence on macOS.
- Existing suites `tests/unit/launchctl-load-guard.test.ts`,
  `tests/unit/init-join-launchd-handoff.test.ts`, `tests/unit/launchd-process-ceiling.test.ts`
  and `tests/unit/linux-autostart-lingering.test.ts` must stay green: login mode is byte-for-
  byte today's plist.
- Live acceptance (maturation): one macOS host with FileVault off installed in boot mode by an
  operator following the printed steps, restarted, left at the login window for at least
  30 minutes; the lifeline topic shows the startup marker from the daemon with nobody logged
  in and `instar doctor` reads `unattended-via-daemon`. A second run with the agent stopped
  for more than 24 hours produces exactly one disclosure with the loss sentence. Boot mode is
  documented as supported only after that evidence exists; until then the install prints
  "experimental" on its first line.

## Open questions

- Whether the fleet watchdog should get a boot-mode variant in the same release or stay a
  login-time supplement. This draft keeps it login-only and says so in the posture line.
- Whether `fdesetup status` is acceptable as the single read-only query, or whether FileVault
  should be reported as `unknown` until a file-based signal is confirmed. The matrix works
  either way; `unknown` simply warns.
