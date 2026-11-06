---
title: "Linux lifeline is marked supervised, so its self-restart runs"
slug: "linux-lifeline-supervised"
author: "echo"
created: "2026-11-05"
parent-principle: "Structure > Willpower; Migration Parity Standard"
eli16-overview: "linux-lifeline-supervised.eli16.md"
status: "converged"
approved: true
approved-by: "echo, under the operator's standing rule (Justin, 2026-10-22 08:58 PDT: \"I should ONLY have to approve constitution changes\"); this spec touches no CODEOWNERS path"
related: "feedback fb-8af3913e-254; PR #2828 (lifeline-409-poll-deadlock); docs/specs/systemd-killmode.eli16.md (the migration this mirrors)"
review-convergence: "2026-11-06T00:56:49.819Z"
review-iterations: 5
review-completed-at: "2026-11-06T00:56:49.819Z"
review-report: "docs/specs/reports/linux-lifeline-supervised-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Linux lifeline is marked supervised, so its self-restart runs

## Problem

The lifeline's `RestartOrchestrator` exits the process for a self-heal (watchdog signals `conflict409Stuck`, `noForwardStuck`, `consecutiveFailures`, patch drift) only when `detectLaunchdSupervised()` says something will respawn it. Otherwise it logs `would restart ... but unsupervised; skipping exit` and stays up in the broken state.

On Linux, `buildLinuxSystemdUnit` (`src/commands/setup.ts`) writes `ExecStart=/bin/bash <stateDir>/instar-boot.sh lifeline start ...` with `Restart=always`. The node lifeline's parent is that bash wrapper, not systemd, so detection signal 4 (parent named `systemd`/`init`) never matches, and nothing sets signal 1 (`INSTAR_SUPERVISED=1`). Every self-heal exit on Linux is skipped, forever. The macOS LaunchAgent plist sets `INSTAR_SUPERVISED=1` in `EnvironmentVariables` for exactly this wrapper case; the Linux unit never got the same line.

Seen live on the two-server takeover drill (topic 137054, 2026-11-06 00:01Z, Ubuntu, instar 1.3.1680): a lifeline stuck in a 409 latch logged `skipping exit` every 30s for 20+ minutes while the agent was silent. The latch itself is fixed in #2828; this spec makes the backstop that should have cleared it work on Linux.

## Change

1. `buildLinuxSystemdUnit` adds `Environment=INSTAR_SUPERVISED=1` (constant `SYSTEMD_SUPERVISED_ENV_LINE`) directly after the `Environment=PATH=...` line. New installs and every unit regenerated from the template carry it.
2. A pure helper `addSystemdSupervisedEnv(unit)` in `PostUpdateMigrator.ts`, shaped like `addSystemdKillModeProcess`: inserts the line directly after the `[Service]` header (position differs from the template; systemd does not care about order within a section), using the file's own line ending, leaving every other byte identical. It returns the unit untouched when any `Environment=` line already assigns `INSTAR_SUPERVISED` (including inside a quoted or multi-assignment line such as `Environment="A=1" "INSTAR_SUPERVISED=0"`), or when there is no `[Service]` section.
3. `PostUpdateMigrator.migrateSystemdSupervised()`, shaped like `migrateSystemdKillMode()` and called right after it: Linux only, reads `~/.config/systemd/user/instar-<projectName>.service`, writes a `.bak-<ts>` copy, writes the patched unit, runs `systemctl --user daemon-reload` (skipped under a test runner). It never restarts the service. When `daemon-reload` succeeds, it reports that the setting applies at the next service start. When the reload fails or is skipped, it reports that the setting applies after a reload or the next login, the same two-message pattern KillMode uses: without a reload, a restart keeps using the unit systemd already loaded.
4. **A daily cap on watchdog self-restarts, and an alarm that can fire** (`src/lifeline/rateLimitState.ts`, `TelegramLifeline.initiateRestart`). Review found the existing brake does not bound a restart that fixes nothing: the `watchdog` bucket's 10-minute cooldown limits how often, not how many, and the restart-storm alarm (6 in an hour) counts only earlier restarts, of which at most 5 fit in the hour at that spacing, so it never fires for watchdog restarts. Turning supervision on for Linux would expose this on every Linux install, so it is fixed here, for all platforms:
   - `WATCHDOG_DAILY_CAP = 6` per rolling 24h. The 7th is refused with `watchdog-daily-cap`.
   - Only restarts that really exited count. The history entry is still written when a restart is allowed, because it starts the cooldown that throttles repeated attempts. But the orchestrator can still decline to exit (unsupervised, or deferring for a shadow-install update). So entries carry `exited`, which `RestartOrchestrator` sets through a new `recordExit` dependency (`markLatestRestartExited`) immediately before the process exits, on both the normal and the hard-kill path. The cap counts only `exited: true` entries. Entries written by older versions carry no flag and do not count. Without this, a Linux lifeline that has been logging "unsupervised; skipping exit" for hours would arrive at its first supervised start with the day's budget already used up by restarts that never happened. (Found by the second-pass review after convergence.) Evidence from the two agents with history on the Mac Studio (`<agent>/.instar/last-self-restart-at.json`):
     - Echo's busiest day had 3 (2026-09-04).
     - Luna (sagemind) had 21 watchdog restarts between 19:39 and 23:31Z on 2026-10-12, all `conflict409Stuck`, about every 10 minutes, and 4 more on 2026-10-19.

     Luna's loop is the unbounded case this cap exists for: 21 restarts for the same reason; the condition persisted through at least 20 of them, and the storm alarm could not fire. Luna runs on two machines, so a 409 that survives restarts is most likely a second poller that is really polling, which no restart can fix.

     Trade-off, stated plainly: if a late restart is what finally clears a condition, the cap delays that until the 24h window rolls. In exchange, the operator hears about it instead of never. If the restarts are bunched together, the 6th inside an hour raises `restartStorm`. If they are spread across the day, the first refused restart raises `selfRestartExhausted`. Spread-out restarts are not a storm, and one report at exhaustion is the right time to tell the operator. The lifeline logs from 2026-10-12 are gone, so whether Luna's 21st restart or something outside ended the loop is unknown. Self-Heal Before Notify decides it: once self-heal has failed repeatedly, stop and tell the operator.
   - The storm count includes the restart being decided, so the 6th restart in an hour raises `TelegramLifeline.restartStorm`.
   - `readRateLimitState` treats a history entry with a missing or unparseable `at` or an unknown `bucket` as a corrupt file. Before, such an entry passed the read and then threw inside `decide`, or quietly dropped out of the counts.
   - A corrupt rate-limit file (which already blocks every self-restart) now raises `TelegramLifeline.restartStateCorrupt` once per process instead of only logging, because the new entry check sends more file shapes down that path.
   - When the cap refuses a restart, `TelegramLifeline.selfRestartExhausted` is raised once per process ("self-restart did not clear it; messages may not be collected until the cause is fixed or the agent is restarted"). The lifeline then stays up as it is. Entries age out of the 24h window, so self-heal resumes the next day.

## Decision points touched

- `detectLaunchdSupervised()` "will something respawn me?" — **invariant**, unchanged. It is a fact about how the process was started, and the unit we write is the thing that respawns it (`Restart=always`). The change supplies the explicit signal that already decides it on macOS; no rule changes.
- `RestartOrchestrator` exit-for-restart — **invariant**: it exits only when supervised and when the rate limit allows; its rules are unchanged. On Linux it now actually exits when a watchdog signal trips. Its brakes are a 10-minute cooldown measured from the last self-restart of any kind (one shared `lastRestartAt`, so an upgrade restart also delays the next watchdog restart; seen in the drill as `restart suppressed by rate limit: cooldown-active`), the daily caps below, and systemd's `RestartSec=10`.
- Watchdog daily cap (`decide`, new) — **invariant**: a fixed budget of 6 per rolling 24h on a self-triggered restart. A hard bound on a self-action is a deterministic safety floor by design (No Unbounded Self-Action); it weighs no competing signals.
- Storm alarm (`decide.stormActive`, changed) — **invariant**: a count that includes the decided restart; signal only, it never blocks.
- Malformed history entry (`readRateLimitState`, new) — **invariant**: it is treated as a corrupt file, the existing fail-closed rule, applied to every entry.
- Migration "patch this unit?" — **invariant**: patch only when the unit is instar's (`instar-<projectName>.service` with a `[Service]` section) and no `Environment=` line already names `INSTAR_SUPERVISED`. An operator value, including `0`, wins.

## Behaviour change and its bounds

Before, on Linux: every self-restart the lifeline asks for is skipped and logged every 30s. That covers three kinds:
- `watchdog`: stuck in a 409 conflict, not forwarding, or repeated failures.
- `plannedUpgrade`: the auto-updater crossed a major or minor version, and the lifeline should load the new code.
- `versionSkew`: the server answered 426 because the lifeline is too old.

So a stuck Linux lifeline stays stuck until a human restarts it, and after a major or minor update it keeps running old code until the machine reboots. After this change Linux behaves as macOS already does for all three.

Brakes, all persisted in `<agent>/.instar/last-self-restart-at.json` so they survive the restart they govern. A corrupt file blocks restarts (fail-closed), and a history entry with a missing or bad time or an unknown kind now counts as corrupt (new: it was skipped before, which would undercount the cap):
- `watchdog`: refused within 10 minutes of the last self-restart of any kind (shared timestamp), and at most 6 per 24h (new). The 6th inside an hour raises `restartStorm`, and the refused 7th raises `selfRestartExhausted` (both new as live signals).
- Skew: a future `lastRestartAt` (clock skew) is allowed once and overwritten, as today (`decide` returns allowed for `skew`). That is one restart outside the caps per skew event, not a loop, because the overwrite clears the skew.
- `plannedUpgrade` + `versionSkew`: no cooldown, because waiting cannot cure them, and a shared cap of 3 per 24h (existing).

Cost of one cycle: a `watchdog` exit also tries to stop the server (`restartKeepsServer` is true only for `versionSkew` and `plannedUpgrade`, `RestartOrchestrator.ts`). The orchestrator gives that quiesce step 1 second and then exits whether or not the server has stopped. A server still running is adopted by the next lifeline (`ServerSupervisor.start` trusts a session that answers `/health`) or found by its orphan handling, so no second server starts. At worst the server is not restarted. That does not matter for `conflict409Stuck`, whose latch is in the lifeline. For `noForwardStuck` or `consecutiveFailures`, where the server can be at fault, an over-budget quiesce means the restart fixes nothing and still uses one of the 6. This is existing macOS behaviour, unchanged here; the quiesce budget is listed as left behind. Then systemd waits `RestartSec=10`, the agent boots, and Telegram may take up to about a minute to release the old poll connection (`flushStaleConnection`). Plan on one to two minutes without the agent per watchdog cycle. `versionSkew` and `plannedUpgrade` restart only the lifeline and keep the server running.

What survives a restart (the guarantees this spec relies on; end-to-end delivery across forwarding and acknowledgement is the existing design and is not changed or re-proved here):
- The lifeline's message queue is written to disk on every change (`MessageQueue.save`).
- The Telegram offset advances only after an update has been processed (`processUpdate`, then `saveOffset`), so an update in flight at the exit is fetched again after the restart.
- The orchestrator's own persist step is a no-op today. The spec claims nothing from it.

Settling:
- A restart that fixes the condition (the 409 latch, a wedged poll connection) settles in one cycle.
- A restart that fixes nothing settles at most 6 cycles per rolling 24h. Then the agent stays up in its stuck state for the rest of that window and `selfRestartExhausted` says so. The flag is per process, so it is raised at most once per refused cycle, and it never repeats every tick. The end state is the same as Linux today, plus at most 6 outages of one to two minutes a day and a report.

The variable is inherited by every process the lifeline starts (server, sessions). Only `detectLaunchdSupervised` reads it, at one call site in `TelegramLifeline.ts`. One more consequence, the same as on macOS today: in test mode the detector honours the variable, so a test run from inside an agent session inherits "supervised". The orchestrator tests that exercise the exit inject their own `exitFn`. Whether every other test is safe under an inherited variable is not verified here, and macOS has the same exposure.

## When it takes effect

`daemon-reload` reloads the unit file but does not change the environment of the running lifeline. The lifeline also caches its supervision check at boot. So a running Linux lifeline becomes supervised only at its next start: a manual service restart or a reboot. No self-restart can do it, because none run on Linux today. The migration says so in its result line. A Linux machine is therefore unprotected until its next restart. That is accepted (see Frontloaded Decisions).

## Multi-machine posture

Machine-local by design: each machine's service manager supervises the lifeline process running on that host, and only that host's systemd can respawn it.

machine-local-justification: hardware-bound-resource — the unit file and the systemd user manager that acts on it exist per host; a process on one machine cannot be respawned by another machine's init system.

No notices, durable shared state, or URLs. No status surface changes. Each machine is patched by its own update pass.

## Rollback

Revert the code change. Units already patched keep the line; that leaves Linux behaving like macOS. To fully undo on a machine, the `.bak-<ts>` copy written beside the unit is the exact prior file.

## Tests

- Unit: `buildLinuxSystemdUnit` output carries `Environment=INSTAR_SUPERVISED=1` inside `[Service]`.
- Unit: `addSystemdSupervisedEnv` inserts once right after `[Service]` and leaves the rest byte-identical. It is idempotent and keeps CRLF files CRLF. It keeps an operator value in plain, quoted and multi-assignment forms, and leaves a unit with no `[Service]` untouched.
- Unit: `migrateSystemdSupervised` on a temp HOME with the platform forced to linux: patches a real-shaped unit and writes the backup. It skips on non-linux and when no unit exists, and is a no-op on the second run.
- Unit: `detectLaunchdSupervised({ platform: 'linux', env: { INSTAR_SUPERVISED: '1' }, ppid: 4242, parentNameLookup: () => 'bash' })` is true, and false without the variable or with `0`. This is the exact drill shape.
- Unit (`rateLimitState`): the 7th watchdog restart in 24h is refused with `watchdog-daily-cap`, and one aged past 24h no longer counts. The 6th restart inside an hour (at 10-minute spacing) reports `stormActive`, and the 5th does not. `plannedUpgrade`/`versionSkew` are unaffected by the watchdog cap.
- Unit (`TelegramLifeline.initiateRestart`): a cap refusal raises `selfRestartExhausted` exactly once over repeated ticks.
- Wiring: `migrateSystemdSupervised` is called in the migration pass next to `migrateSystemdKillMode`.
- Live, on the Hetzner drill pair after one service restart:
  - `/proc/<lifeline pid>/environ` carries the variable.
  - A tripped watchdog exits, the boot wrapper exits with it (it `wait`s on node, then exits), and systemd starts exactly one new lifeline.

## Maturation plan

- **test-agent-live:** the Hetzner drill pair (two throwaway Linux agents). After the update and one service restart, `/proc/<lifeline pid>/environ` carries `INSTAR_SUPERVISED=1`. A tripped watchdog exits, the wrapper exits with it, and systemd starts exactly one new lifeline.
- **dev-agent-live:** Echo's Linux machines, if any are paired, from the release that carries it. Echo's Macs exercise the daily cap and the storm fix from the same release.
- **fleet:** the same release; ungated. It is a parity fix to an existing backstop, plus a bound on that backstop.
- **graduation criterion:** on the drill pair, one watchdog-tripped exit respawned by systemd, with exactly one lifeline afterwards, plus the migration's `systemd supervised:` line in the update log. A zero count is not a pass.
- **dark-window:** none, because the fix is live on release. If the criterion is not met within 7 days of merge, the reason and a new date go on topic 137054.
- **ladder:** not applicable: no flag, live on release (parity fix plus a bound on an existing backstop).

## Frontloaded Decisions

1. **No forced restart to apply the setting.** It takes effect at the next service start. Restarting every Linux agent on update for a backstop costs more than one more restart cycle without it.
2. **Opting a machine out uses a systemd drop-in**, for example `~/.config/systemd/user/instar-<name>.service.d/supervised.conf` containing `[Service]` and `Environment=INSTAR_SUPERVISED=0`. Drop-ins are read after the unit and override it, and template regeneration (`installAutoStart`, re-running setup, `migrateSystemdStableStart`) never touches them. With `0`, detection falls back to the parent-process check, which on Linux sees bash, so the machine stays unsupervised. The migration also leaves alone any `INSTAR_SUPERVISED` already written in the unit itself. A regeneration would replace that value, as it already does for every other line in the unit, so the drop-in is the documented route.
3. **Same shape as the KillMode migration**: surgical insert, `.bak-<ts>` backup, `daemon-reload` skipped under a test runner.
4. **The watchdog daily cap is 6 per rolling 24h, for every platform.** It is fixed in this change rather than left behind, because enabling supervision on Linux without it would turn on a self-restart loop with no bound on how many times it repeats. 6 is twice the busiest day in Echo's own history (one agent's sample). A later change can tune it; it is a single constant.

## Open questions

*(none)*
