---
title: "Unattended macOS restart: start without a console login, and say how long we were dark"
slug: "feedback-feedback-2d869697-c555-461f-a44a-a3559bc554d1"
author: "echo"
parent-principle: "Close the Loop"
---

# Unattended macOS restart: start without a console login, and say how long we were dark

Feedback initiative: `feedback-2d869697-c555-461f-a44a-a3559bc554d1`
Cluster: `cluster-agent-is-fully-dark-after-a-machine-restart-until-someone-lo`
Severity: critical. Status: draft. No code has changed.

## Problem statement

On macOS every instar process that can keep an agent alive is a per-user **GUI-domain
LaunchAgent**:

- the agent's server or lifeline: `~/Library/LaunchAgents/ai.instar.<name>.plist`, loaded with
  `launchctl bootstrap gui/<uid>` (`src/commands/setup.ts` `macOSAutoStartLoadCommands`,
  `installMacOSLaunchAgent`);
- the fleet watchdog: `~/Library/LaunchAgents/ai.instar.watchdog.plist`
  (`installFleetWatchdog`).

launchd creates the `gui/<uid>` domain only when that user logs in at the console. After a
restart that stops at the login window, which is the normal case with FileVault or with
auto-login turned off, **none of these processes start**. Nothing on the host can notice the
outage, because the watchdog that would notice is also stopped. The agent stays dark until a
human logs in.

Three things make this worse once the agent comes back:

1. **Messages are lost and nobody is told.** Telegram keeps undelivered updates for about 24
   hours. Anything sent earlier in the outage is gone. On recovery the user saw only the usual
   `🔄 Session restarting — message queued.` (`src/commands/server.ts`). It did not say the
   agent had been down for days or that earlier messages might be lost.
2. **Long-interval jobs are not caught up.** `JobScheduler.checkMissedJobs` marks a job missed
   only when `now - lastRun > 1.5 × interval`. A weekly job whose slot fell during a 3-day
   outage usually stays under 10.5 days since its last run, so it never runs until the next
   week. Daily jobs were caught up; weekly ones were not.
3. **Catch-up crowds out the user.** For about 4 minutes after boot, background catch-up filled
   the host spawn cap (8/8 holders, up to 18 waiting). The tone gate could not get a slot, so it
   failed closed and held every interactive reply to the user who had been waiting three days.

## Evidence

One report (n=1, received 2026-09-28, instar 1.3.1285, single-machine agent). The evidence
file's `truncation` is `null`, but the triage marks the evidence incomplete because some
reports were cut. Only this one report is available.

- An orderly macOS restart, not a crash. The host then sat at the login window for **71.5
  hours**.
- Server, lifeline and watchdog were all GUI LaunchAgents, and none of them ran.
- No scheduled work ran for three days.
- Telegram kept updates for about 24 hours, so messages from roughly the first 47 hours were
  lost for good. The messages that survived were answered about 20 hours late.
- The only notice on recovery was "Session restarting — message queued".
- Gaps seen at recovery: weekly jobs not caught up, interactive replies held by a saturated
  spawn cap, and a script job whose measurement window spans the outage exits non-zero as
  "unmeasurable" for a week, which the scheduler reports as a failure.

Code checks done for this draft:

- Every macOS install path uses `gui/<uid>`. There is no `system`-domain (LaunchDaemon) option
  and no `user/<uid>` option.
- Nothing checks whether auto-login is on (`/Library/Preferences/com.apple.loginwindow`
  `autoLoginUser`) or whether FileVault is on. FileVault turns auto-login off.
- The 1.5× missed-job threshold in `src/scheduler/JobScheduler.ts` does not depend on how long
  the interval is. That explains gap (2).
- `state/lifeline-started-at.json` (`src/lifeline/startupMarker.ts`) records when the lifeline
  started, but nothing records when it was last alive. So the length of an outage cannot be
  worked out today.

## Goals

- **G1.** There is a supported way to run instar on a host that is not watched, and it starts
  after a restart with no console login.
- **G2.** On a setup that cannot do this, the operator is told clearly, both at install time
  and from `instar doctor`.
- **G3.** After any outage longer than a threshold, the user gets one plain notice with the
  outage window. If the outage was longer than the messaging platform keeps messages, the
  notice says that earlier messages may be lost.
- **G4.** Recovery after an outage puts the user first: interactive replies come before
  background catch-up, and long-interval jobs whose slot was missed are caught up.

Non-goals: Linux. systemd user units already need `loginctl enable-linger`, so Linux gets only
a matching doctor check (see 3c). Windows. Getting back messages a platform has already
deleted, which is not possible.

## Proposed design

### 1. Unattended install mode on macOS (G1)

Add an install mode `autoStart.mode` with values `"login"` (current behavior, the default) and
`"boot"`.

- In `"boot"` mode, the agent plist and the watchdog plist are written to
  `/Library/LaunchDaemons/ai.instar.<name>.plist` and `ai.instar.watchdog.plist`, with
  `UserName=<agent user>`, `GroupName=staff`, explicit `HOME`, `PATH` and `WorkingDirectory`,
  `RunAtLoad`, and the same `KeepAlive` and throttle as today. They are loaded into the
  `system` domain.
- Writing to `/Library/LaunchDaemons` needs root. instar must **not** escalate silently. The
  CLI command `instar autostart install --boot` creates the plist in a user-owned staging
  path, runs `plutil -lint`, prints the exact `sudo install …` and
  `sudo launchctl bootstrap system …` commands, and then checks the result. It can run them
  itself only when the operator invokes it under `sudo`.
- Background self-heals (server, lifeline, `PostUpdateMigrator`) must not move an install
  between modes. They regenerate only the mode that is installed. If they find a boot-mode
  plist they cannot rewrite because it is root-owned, they record a doctor finding and do
  not fall back to writing a GUI LaunchAgent next to it. Running both would start two
  supervisors for one agent.
- `uninstallAutoStart` and the throwaway-agent guard (`autoStartRefusalReason`) must handle both
  domains. The guard matters more in boot mode, because a system-domain job survives logout.
- **Known limits, which must be in the docs and in the doctor output:** a daemon has no
  Aqua/GUI session. Keychain items in the login keychain are not readable until the user logs
  in once, and features that need a window server (Playwright with a visible browser, some
  `open` calls) will fail. Part of this mode's acceptance work is to list every instar feature
  that needs the login keychain or a GUI, and to fail each one with a clear message rather
  than hang. If the list turns out large, the fallback is item 2 alone (auto-login documented
  as the supported way to run unattended) plus items 3–5.

**Decision to settle in review:** LaunchDaemon with `UserName`, or a documented "auto-login
plus FileVault off" prerequisite. The reporter suggests either one. This draft recommends
offering the daemon mode and documenting auto-login as the simpler option for hosts where
FileVault can be off. The doctor check in 3a covers both.

### 2. Docs (G1, G2)

Add a "Running on a host nobody watches (macOS)" section to the install docs. It names the
three supported setups (boot mode; auto-login with FileVault off; attended only) and says
plainly that a login-mode install on a host stuck at the login window does nothing until
someone logs in.

### 3. Diagnostics (G2)

a. **`instar doctor` check `autostart.unattended`** (macOS). It reports:
   - which domain each instar job is loaded in (`launchctl print gui/<uid>/…` and
     `system/…`);
   - whether auto-login is set (`defaults read /Library/Preferences/com.apple.loginwindow
     autoLoginUser`, read-only) and whether FileVault is on (`fdesetup status`, read-only).

   It **warns** when all instar jobs are GUI-only and auto-login is off or FileVault is on.
   The warning reads: "If this Mac restarts, the agent stays offline until someone logs in at
   the screen." It then lists the fix options. It does not warn when the operator has
   recorded `autoStart.attended: true`.

b. The same check runs once at the end of `installAutoStart`/setup on macOS. The warning is
   printed there, not only in doctor.

c. On Linux, a matching check: warn when the unit is a `--user` unit and
   `loginctl show-user <user> -p Linger` is `no`.

### 4. Outage detection and notice (G3)

a. **Last-alive marker.** The lifeline, or the server when it has no lifeline, writes
   `state/last-alive-at.json` (`{ ts, pid, bootTime }`) every 60 s, writing a temp file and
   renaming it, as `startupMarker.ts` does. On a clean shutdown it also writes
   `{ cleanShutdown: true }`.

b. **Gap computation at startup.** Before overwriting the marker, compute
   `gap = now - lastAlive.ts`. Also read `sysctl kern.boottime` (macOS) or `/proc/stat btime`
   (Linux). The notice uses this to tell "the machine restarted" apart from "the agent alone
   was down".

c. **Notice.** If `gap ≥ outageNoticeThresholdMs` (default 30 min), send **one** deterministic
   notice, in the same style as the restart notice, to the agent's primary/attention topic.
   It is not sent per topic.

   > I was offline from {start, local time} to {end} ({duration}). The machine restarted at
   > {boot} and I couldn't start until someone logged in.

   The "couldn't start until someone logged in" clause appears only when the boot time is
   well before the agent's start time and the install is login mode.

   If `gap` exceeds the adapter's retention (`messageRetentionMs`, a new optional adapter
   property: Telegram 24 h; Slack/others undefined, which means no loss clause), add:

   > Messages sent to me before {end − retention} may not have reached me. Please resend
   > anything important.

d. **Dedup.** The notice is keyed on `lastAlive.ts`, so lifeline and server restarts during
   one recovery send it only once. It goes into the outbound queue, so a failed send is
   retried and not dropped.

e. The existing "Session restarting — message queued" text stays the same. The outage notice
   comes before it.

### 5. Recovery behavior (G4)

a. **Long-interval catch-up.** In `checkMissedJobs`, a job is also missed when at least one
   scheduled fire time fell inside `(lastAlive.ts, now]` and `lastRun < that fire time`. Get
   the fire times from the cron expression with `nextRuns` starting at `lastAlive.ts`. Keep
   the 1.5× rule as a fallback for when no last-alive marker exists. Run each job's catch-up
   **at most once**, not once per missed slot.

b. **Interactive replies first after boot.** For a post-outage window (default 10 min after a
   detected gap), the host spawn admission keeps at least one slot, or a priority lane, for
   interactive and tone-gate work. Background catch-up waits behind it. The tone gate must
   not fail closed because background holders filled the cap. This needs a check against
   the existing host-spawn-cap and tone-gate specs before it is built. It is listed here so
   it is not lost, and it may be split into its own spec.

c. **Outage-spanning measurement jobs.** Script jobs can exit with a distinct "unmeasurable"
   code (proposal: 75, `EX_TEMPFAIL`). The scheduler records that run as `skipped`, not
   `failed`. To be confirmed against the scheduler's exit-code contract. It may also be split
   out.

## Rollout

1. Items 3 and 4 first. They need no root, change no install, and cover "the user is told"
   and "the operator is warned".
2. Item 5a.
3. Item 1 (boot mode) and the item 2 docs, after the limits review in item 1.
4. Items 5b and 5c, possibly as separate specs.

## Testing

- Unit: the plist generator for boot mode (`UserName`, `HOME`, `system` domain load commands);
  the doctor rule as a pure function over (domains, autoLoginUser, fileVault, attended); the
  gap calculation and notice text, with and without the retention clause; dedup on
  `lastAlive.ts`; `checkMissedJobs` with a weekly cron and a 3-day gap fires once, and the
  same case with no marker keeps the 1.5× behavior.
- Integration, no real launchctl (`launchctlLoadAllowed()` already returns false under
  vitest): startup with a 72 h stale marker sends exactly one notice through a fake Telegram
  adapter, and a second startup sends none.
- Manual, documented: a real restart left at the login window, once with a boot-mode install
  and once with a login-mode install. In login mode, check that the doctor warning was shown
  beforehand and that the outage notice comes after login.

## Open questions

1. Is boot mode worth its Keychain/GUI limits, or should "auto-login with FileVault off" be the
   only supported setup for a host nobody watches?
2. Where should the outage notice go on agents with many topics: the attention topic only, or
   also the most recently active topic?
3. Should the last-alive marker be shared with the existing sleep/wake handling
   (`src/lifeline/agentSleepWake.ts`) so laptop sleep is not reported as an outage?
