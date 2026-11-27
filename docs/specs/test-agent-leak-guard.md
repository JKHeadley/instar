---
title: "Test-agent leak guard: throwaway agents cannot become permanent jobs on the operator's login"
slug: "test-agent-leak-guard"
author: "echo"
eli16-overview: "docs/specs/test-agent-leak-guard.eli16.md"
parent-principle: "Close the Loop"
parent-principle-fit: "A throwaway agent is a loop someone opened (a test) and nobody closed; it ran for five days because nothing brought it to a deliberate close. The recorded expiry and self-teardown make every throwaway reach a close structurally, instead of relying on the creating script to remember teardown."
review-convergence: "2026-10-27T02:24:33.944Z"
review-iterations: 6
review-completed-at: "2026-10-27T02:24:33.944Z"
review-report: "docs/specs/reports/test-agent-leak-guard-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin, 2026-10-22); the fix itself is Justin's request, CMT-1058"
---

# Test-agent leak guard

## Problem statement

Incident, 2026-10-21 → 2026-10-26 (CMT-1058). A release-check script run by a sibling agent created a
throwaway agent named `rtcheck` with `instar init`, non-interactively, with `HOME` and `CODEX_HOME`
pointed at a folder under `/private/tmp/.../scratchpad/`. It started a foreground server twice and
killed it twice. The agent was never torn down. For five days it ran its built-in scheduled jobs at
about 27 Claude sessions an hour on the operator's real Claude subscription: about 2.9 billion
tokens, 12% of all Claude use across the fleet that week.

### Root cause (traced in the code, not assumed)

`instar init` itself does not install autostart. Two other paths did, and they compose into the leak:

1. **The server's startup self-heal** (`src/commands/server.ts`, the block that calls
   `isAutostartInstalled` → `installAutoStart`). Every server start (`--foreground`, or the tmux-spawned mode, which runs `--foreground` inside tmux) checks
   for `ai.instar.<projectName>.plist` under `os.homedir()` and, if missing, installs it. Under the
   fake `HOME`, `os.homedir()` is the temp folder, so the plist was written to
   `<tmp>/Library/LaunchAgents/`. But `installMacOSLaunchAgent` then runs
   `launchctl bootstrap gui/<uid> <plist>`. The launchd domain belongs to the **macOS user**, not to
   `$HOME`. The fake-home plist was loaded into the operator's real launchd with `RunAtLoad` and
   `KeepAlive`. The same function also installs the fleet watchdog plist (`installFleetWatchdog`).
2. **The second plist in the real home.** launchd starts jobs with the **account's** environment:
   `HOME` is the account home from the user database, not the sandbox (documented launchd
   behaviour; the live reproduction records the launched process's `HOME`, `projectDir` and loaded
   job). The plist's
   `EnvironmentVariables` sets only `PATH` and `INSTAR_SUPERVISED`. So the launchd-started rtcheck
   process ran with the **real** `HOME`; its own startup self-heal looked for the plist under the real
   `~/Library/LaunchAgents`, found none, and wrote a second one there. That is why one of the two
   plists "landed in the real home despite the fake HOME": no code resolved the home from `getpwuid`
   at install time (`grep` over `src/` finds no `userInfo().homedir` or `getpwuid` use); the
   writing *process* simply had a different `HOME`, because launchd gave it one. The lifeline's own
   self-heal (`TelegramLifeline` startup → `installAutoStart`) is a third writer of the same shape.
   The leak is macOS-specific: a Linux user systemd does not read a unit file under a fake
   `~/.config`, so the same sequence fails to enable there.
3. **The login.** On macOS, Claude Code keeps its OAuth credential in the login Keychain, which is
   per macOS user. A process with a sandboxed `HOME` can still reach the operator's real login, and
   the launchd-started process had the real `HOME` anyway. So the throwaway agent's scheduled jobs
   ran on the operator's real subscription.

Nothing in instar knew the agent was a throwaway, nothing would ever stop it, and nothing refused to
spend a real subscription on scheduled work for an agent that lived in a temp folder.

## Proposed design

One new module, `src/core/ThrowawayAgentGuard.ts`, holds every classification and the teardown. The
rest of the change is small edits at the call sites listed below.

### Classifications (deterministic, injectable inputs for tests)

- `accountHomeDir()` — `os.userInfo().homedir` (the user-database home, which launchd and the
  Keychain use); falls back to `os.homedir()` if `userInfo()` throws. Used only for comparison and for
  finding this agent's own autostart files, never as a place to write new ones.
- `isHomeSandboxed(env)` — `realpath($HOME) !== realpath(accountHomeDir())` (unreadable paths compare
  by `path.resolve`; never throws).
- `isUnderTempRoot(p)` — `realpath(p)` (or `path.resolve(p)`) is under one of the **fixed** OS temp
  roots: `/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders`, `/var/tmp`,
  `/private/var/tmp`, `/dev/shm`. `$TMPDIR` and `os.tmpdir()` are deliberately NOT roots: a user can
  set `TMPDIR=$HOME/tmp`, and a supervised process may not inherit it, so the same agent would be
  classified differently by the CLI and by launchd. (On macOS `os.tmpdir()` is under `/var/folders`
  anyway.) A Claude Code scratchpad is under `/private/tmp`, so it is covered.
- A **throwaway record** is `config.throwawayAgent`. A record with `expiresAt` is the `recorded`
  reason. `--keep` writes `throwawayAgent: { createdAt, keep: true }` with no `expiresAt`: an explicit
  exemption from expiry that also stops the boot backfill. It does not lift the location rules (a kept
  agent under a temp root still needs `--force` for autostart and `allowOnThrowawayAgent` for jobs).
- `classifyLocation({ projectDir, env, record })` → reasons from `home-sandboxed`,
  `project-under-temp`, `recorded`.

Which reason blocks what:

| Reason | Blocks autostart install | Blocks scheduled jobs | Expiry |
|---|---|---|---|
| `home-sandboxed` | yes | **no** (a real agent may run with `HOME` set by a unit, `sudo -E` or a container) | **never** on its own, at init or at boot |
| `project-under-temp` (runtime) | yes | yes | recorded at init; **backfilled at server boot** if missing |
| `recorded` (`throwawayAgent.expiresAt`) | yes | yes | is the expiry |

### (1) Autostart: one funnel, plus an install-time record

**The funnel.** `installAutoStart(projectName, projectDir, hasTelegram, opts?)` refuses — returns
`false`, writes nothing, loads nothing — when any reason above applies, unless `opts.force === true`.
The reason is stored for `takeLastAutoStartRefusal()` so callers print it instead of "not available".
`installFleetWatchdog` is only reached from inside the funnel. `PostUpdateMigrator.migrateFleetWatchdog`
writes and reloads the machine-wide `ai.instar.watchdog` job on its own, so it gets the same check: a
throwaway agent's migration never touches the machine-wide watchdog (it would otherwise replace the
real one with a copy pointing into a temp folder that is later deleted).

Every call site, and what it is:

| Call site | Kind | Behaviour after this change |
|---|---|---|
| `cli.ts` `autostart install` | explicit | funnel; `--force` passes `force`; success sets `autostart.autoInstall=true` |
| `machine.ts` `instar join` | explicit | funnel; success sets `autostart.autoInstall=true` |
| `server.ts` startup self-heal (every server start, `--foreground` or tmux) | self-heal | funnel; the *install-when-missing* branch is skipped when `autostart.autoInstall === false`; the *regenerate-an-existing-unit* branch still runs (through the funnel) |
| `TelegramLifeline` startup install | self-heal | skipped when `autoInstall === false`; funnel otherwise |
| `TelegramLifeline.selfHealPlist` regenerate | repair of an existing unit | funnel |
| `PostUpdateMigrator.migrateBootWrapperToCjs` | repair of an existing unit | funnel; a refusal is recorded as *skipped*, not an error |
| `PostUpdateMigrator.migrateFleetWatchdog` | machine-wide singleton | skipped for a throwaway agent |
| `PostUpdateMigrator` process-ceiling / systemd kill-mode rewrites | edit text of an existing unit file, no new load | unchanged (they only touch a unit that already exists; a throwaway's unit is removed by expiry) |
| `restartServer` / `cli.ts` kickstart | explicit operator command on an existing unit | unchanged |
| `listener.ts` dev listener plist | separate opt-in feature | out of scope (not reached by init or server start) |

**The init record.** When `instar init` creates a new `config.json` (never on a re-run over an
existing one) it records `autostart: { autoInstall: false, reason }` if stdin or stdout is not a TTY or
a throwaway reason applies, unless `--autostart` was passed. The setup wizard runs `init` without a TTY
and then runs `instar autostart install` itself (wizard step 5c and the restore flow), so wizard agents
still get autostart; that command sets `autoInstall=true`.

### (2) The real-home plist write is closed

The second plist was written by the launchd-started process, whose `HOME` was the real one and whose
`projectDir` was still the temp folder. The funnel refuses it (`project-under-temp`), and the first
load into the real launchd is refused too (`home-sandboxed` and `project-under-temp`). No instar code
derives a write location from `getpwuid`; this change adds none.

### (3) Throwaway agents expire and tear themselves down

- **Recording.** At init, a temp-folder project (or `--expires-in <30m|6h|2d>`, clamped to 1 minute …
  30 days) records `throwawayAgent: { createdAt, expiresAt, reasons }`; default lifetime 24 hours.
  `--keep` records `{ createdAt, keep: true }` instead. `--keep` and `--expires-in` together are
  refused as contradictory. At **server boot**, an agent whose project is under a temp root and that
  has no record at all (neither an expiry nor a `keep`) gets one with `expiresAt = now + 24h`. This is what stops agents that already leaked
  before this release (rtcheck-shaped ones): they expire one day after updating. Boot never backfills
  for `home-sandboxed` alone.
- `isThrowawayExpired(record, now)` — `expiresAt <= now`; an unparseable `expiresAt` counts as expired
  (it is only ever written for a throwaway).
- **Teardown order** (`teardownExpiredThrowaway`):
  1. For each autostart file at `os.homedir()` and `accountHomeDir()` (`ai.instar.<name>.plist` or
     `instar-<name>.service`), read it; it is ours only if its `WorkingDirectory` (XML-unescaped)
     canonically equals this `projectDir` (`realpath` on both sides, so `/tmp/x` and `/private/tmp/x`
     match, and `/tmp/check-production` does not match `/tmp/check`). Not ours or unreadable: left
     alone.
  2. **Write the marker first**, `.instar/state/throwaway-expired.json`, listing every unit judged
     ours (`kind`, `label`, `path`) as `pending`. Ownership is decided once, here, and persisted; a
     later retry works from the marker and never needs the deleted file.
  3. **Delete every owned file first.** For each pending unit: if the file still exists, re-check
     that its `WorkingDirectory` is still ours (an explicit install may have replaced it since); if
     not, drop it from `pending` untouched. Linux: `systemctl --user disable <unit>` before deleting.
     Delete the file and mark it `deleted` in the marker. No unload happens until every file is gone,
     so being killed by an unload can never leave a file behind.
  4. **Unload last, once.** A user launchd domain holds at most one job per label, so there is one
     unload, not one per file. The expected label `ai.instar.<name>` (Linux `instar-<name>.service`)
     is **always** checked, whether or not any file was found, because a job can stay loaded after its
     plist was deleted (a temp folder cleaned by the OS). Ownership of the loaded job:
     - macOS: parse the top-level `working directory = <path>` line of
       `launchctl print gui/<uid>/<label>`;
     - Linux: `systemctl --user show -p WorkingDirectory --value <unit>`.
     Only a value that canonically equals `projectDir` counts; missing, ambiguous or different means
     not ours, and the loaded job is left alone (a same-name real agent stays loaded, even if our path
     appears elsewhere in its output). Ours: macOS `launchctl disable gui/<uid>/<label>` then
     `bootout gui/<uid>/<label>`; Linux `daemon-reload` then `stop <unit>`. The unload may kill the
     caller; everything else is already done.
  5. **Outcome.** Teardown returns one of three outcomes, recorded in the marker:
     - `complete` — every owned file deleted and no owned job loaded (or the unload was issued);
     - `retryable` — something failed; `attempts` is incremented;
     - `quarantined` — 5 attempts have failed. One degradation is reported
       (`ThrowawayAgent.teardown`) and no more attempts are made.
  6. **Serialization.** Teardown holds `.instar/state/throwaway-teardown.lock` (exclusive create,
     holding the pid; taken over only when that pid is no longer alive — never by age). The
     server and the lifeline never run it at the same time; a caller that cannot get the lock does not
     tear down and simply exits (the holder is doing it). Every marker write is an atomic replace
     (`SafeFsExecutor.atomicWriteJsonSync`), read-modify-written only under the lock. The funnel
     takes the same lock around its own check-and-write and re-checks for a marker while holding it,
     so an install cannot cross a teardown. Once a marker exists the funnel refuses without
     `--force`; a forced install after expiry is the operator reviving the agent and also removes the
     marker and the expiry record.
  The fleet watchdog is never removed (shared by every agent on the machine). Under a test runner
  (`VITEST` / `INSTAR_SKIP_LAUNCHCTL_LOAD`) no `launchctl`/`systemctl` command runs.
- **The marker is a stop sign.** `startServer` and lifeline start check first: if the marker exists or
  the record is expired, they run the teardown (a `complete` marker skips straight to exit), print one
  line, and then:
  - `complete` or `retryable` → exit 0 without doing anything else (with the files deleted and the
    job unloaded, launchd has nothing to restart; a `retryable` job that is still loaded gets the
    next attempt from launchd's own restart, at most 5 times);
  - `quarantined` → stay alive holding one idle timer, starting nothing (no HTTP server, no
    scheduler, no sessions, no polling), so a job that cannot be unloaded does not become an endless
    10-second restart loop.
- **One outcome handler.** Startup and runtime expiry, in both the server and the lifeline, go through
  one function `handleThrowawayExpiry(outcome)`: stop productive work (scheduler, sessions, polling),
  then exit 0 on `complete`/`retryable`, or stay idle on `quarantined`.
- **Running processes.** The server re-checks every 5 minutes (one `unref`'d timer, also on a
  read-only standby: teardown is machine-local). On expiry it stops the scheduler, kills the sessions
  its own `SessionManager` lists as running, runs the teardown, and hands the outcome to the shared
  handler (graceful shutdown on exit). The lifeline re-checks every 60 seconds; if its supervisor restarts the server in
  that window, the restarted server stops at the marker immediately. The lifeline then tears down and
  hands the outcome to the same handler.

### (4) Scheduled jobs are refused for a temp-folder or recorded throwaway

- `JobScheduler.triggerJob` gains one gate right after the `paused` check: when the injected
  `throwawayJobGuard()` returns `{ refuse: true, reason }`, the job gets the new `SkipReason`
  `'throwaway-agent'`, one `job_skipped` event, and returns `'skipped'` **before** `scheduleRetry`
  can run. Every trigger path (cron, missed-job catch-up, manual trigger, `retry:`) goes through
  `triggerJob`.
- `server.ts` wires `buildThrowawayJobGuard({ projectDir, allowOnThrowawayAgent })`; the location is
  computed once when the guard is built, the record is re-read per trigger (one small file read).
- `loadConfig` builds `scheduler` field by field, so `allowOnThrowawayAgent` is added there
  explicitly; without that the override would be dropped on load.
- Instar cannot prove a session would not use the operator's real login (the macOS Keychain
  credential is per user, not per `HOME`), so it does not try: every login is treated as real, and
  the explicit `scheduler.allowOnThrowawayAgent: true` is the only way through. The startup log
  prints one line when the guard is active.
- The new skip reason gets a plain label in the console dashboard (`schedule-model.js`).

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Funnel refusal (`installAutoStart`, `migrateFleetWatchdog`) | `invariant` | Deterministic location facts (path comparison). No competing signals: a throwaway must never load a keep-alive job into the real user launchd. Explicit `--force` override. |
| Self-heal install skip on `autoInstall === false` | `invariant` | Reads a recorded install-time decision; the explicit commands flip it. |
| Init records `autoInstall:false` when non-interactive | `invariant` | TTY is a fact; the wizard's explicit `autostart install` is the path back. |
| Expiry record + teardown | `invariant` | A recorded deadline vs the clock; recorded only for init-time throwaway reasons, temp-folder projects at boot, or an explicit `--expires-in`. |
| Teardown ownership (file, then loaded label) | `invariant` | Canonical path equality; anything not provably ours is left alone. |
| Scheduler refusal | `invariant` | Location fact or recorded record, plus an explicit override; instar does not judge "is this login real" because it cannot measure it. |

## Why deterministic, not an LLM judge

The design principles prefer LLM judgment for blocking
decisions among competing signals. These points have no competing signals: each is a location or a
recorded deadline, and the point of the change is to stop spending on a model. Path location is an
adopted default policy ("an agent in a temp folder is disposable"), not proof of intent; every rule
has an explicit override for the case where the policy is wrong.

## Verify the state, not its symbol (P20)

- **Throwaway location.** Symbol: project under a fixed temp root; or `$HOME` ≠ account home; or a
  record. Claimed state: "disposable, must not persist or spend". Corroboration: whoever created the
  agent chose the location; fixed OS temp roots are cleared by the OS, so nothing durable belongs
  there. *Symbol without state*: a person deliberately running a real agent from `/tmp` → `--force`,
  `--keep`, `allowOnThrowawayAgent`; a real agent created or run with a different `HOME` (no
  temp-folder project) → only autostart install is refused, never jobs or expiry. *State without symbol*: a throwaway created in a normal
  folder with the real `HOME` → not detected by location; `--expires-in` covers deliberate tests and
  the non-interactive `autoInstall:false` record still prevents autostart (see Left behind).
  *Unmeasurable* (`realpath` fails): compare `path.resolve`; never throw.
- **Expiry.** Symbol: `expiresAt`. Unparseable → expired (least harmful for a field that only exists
  on throwaways).
- **Ownership before removal.** Symbol: `WorkingDirectory` canonically equals `projectDir` (file), and
  `launchctl print`'s top-level `working directory` canonically equals `projectDir` (loaded job). Unreadable or unparseable → not ours, left alone.

## Multi-machine posture

All behaviours are machine-local BY DESIGN.

- machine-local-justification: physical-credential-locality (the autostart unit, the temp-folder
  location and the Keychain login all physically live on one machine; there is nothing to replicate)

`throwawayAgent` and `autostart` are ordinary per-machine config fields and are not replicated.

## Migration parity

- No `migrateConfig` entry: both new fields are written only by `init` (and the boot backfill), and
  their absence means today's behaviour.
- The funnel, the fleet-watchdog check, the boot backfill and the scheduler gate apply to existing
  agents on update, but only to throwaway-classified ones: an already-leaked temp-folder agent stops
  scheduled jobs at its next boot and expires 24 hours later. Background LLM calls that are not
  scheduled jobs are not gated (they stop at expiry).
- CLAUDE.md template: a short "Throwaway test agents" section in `generateClaudeMd`, and
  `migrateClaudeMd` appends it when the sniff string `Throwaway test agents` is absent.

## Testing

- Unit `tests/unit/ThrowawayAgentGuard.test.ts`: each classification on both sides of its boundary;
  `TMPDIR` ignored; prefix collision (`/tmp/check` vs `/tmp/check-production`); `/tmp` vs
  `/private/tmp`; XML escaping; expiry parsing; `keep` stops the backfill; teardown order (marker →
  disable/delete → unload), an interrupted teardown resumed from the marker, a failed unload retried,
  and that a not-owned file or a loaded label whose `working directory` differs (even when its
  arguments mention our path) is left alone; the fifth failed attempt quarantines; a held lock makes
  a second caller back off; a file replaced between attempts is not deleted; funnel refusal and `force`.
- Unit `tests/unit/JobScheduler-throwaway-guard.test.ts`: refusal records `'throwaway-agent'`, emits
  one event, and leaves no retry scheduled; no guard → unchanged.
- Unit `tests/unit/Config-throwaway-scheduler.test.ts`: `allowOnThrowawayAgent` survives `loadConfig`.
- Integration `tests/integration/test-agent-leak-guard.test.ts`: `initProject` under a sandboxed
  `HOME` in a temp dir writes both records; a re-run does not; `--autostart` / `--keep` / `--expires-in`.
- E2E `tests/e2e/test-agent-leak-guard-lifecycle.test.ts`: the production path — the guard
  `server.ts` builds refuses for a temp project and allows with the override; wiring-integrity check
  that `startServer` installs a non-null guard; expired-marker start exits before building anything.
- **Live reproduction** `scripts/livetest-test-agent-leak-guard.mjs` (macOS, run by hand, not in CI):
  repeats the incident — `init` under a sandboxed `HOME` in a temp folder, a foreground server start
  and kill — with the real `launchctl`, then asserts that no `ai.instar.<name>` job is loaded
  (`launchctl print`) and no plist exists in either home; then forces a recorded expiry on a second
  throwaway that was installed with `--force`, and asserts teardown unloads it and launchd does not
  restart it. Its output is recorded in the PR.

## Rollback

Revert the PR. The new config fields are inert without the code. An agent that expired stays
stopped (that is the intent); deleting `.instar/state/throwaway-expired.json` and the
`throwawayAgent` field revives it.

## Maturation plan

This is a safety floor and ships **on** for every agent; there is no flag that turns it off (each rule
has an explicit per-agent override instead). Shipping it dark would leave the leak open on exactly the
agents that do not know to opt in.

- **test-agent-live:** the full unit/integration/e2e suites, plus the live macOS reproduction
  (`scripts/livetest-test-agent-leak-guard.mjs`) run on the Mac Studio before merge: a throwaway made
  under a sandboxed HOME in a temp folder loads no launchd job and writes no plist in either home; a
  force-installed throwaway with a past expiry unloads itself and is not restarted.
- **dev-agent-live:** live on Echo at the next update after merge; Echo's own agent home is not a
  throwaway location, so the check is that nothing changes (autostart self-heal, jobs) on Echo.
- **fleet:** live at the same release. Only throwaway-classified agents change behaviour.
- **graduation criterion:** the live reproduction passes before merge, and Echo shows no new
  `throwaway-agent` skips or autostart refusals in its first day on the release.
- **dark-window:** none (ships on; see above).

## Frontloaded Decisions

1. Default throwaway lifetime **24 hours**; `--expires-in` / `--keep` override.
2. A non-interactive `init` without `--autostart` records `autoInstall:false` even at a normal
   location; the wizard is unaffected because it runs `autostart install` explicitly.
3. "Real subscription login" is not detected; every login is treated as real.
4. `home-sandboxed` alone blocks autostart only, at init and at runtime. Jobs, expiry and boot
   backfill need a temp-folder project, a record, or `--expires-in`.
5. The scheduler refusal does not retry and raises no attention item; the startup line, the skip
   ledger and the dashboard label are the record.
6. Expiry exits 0 and leaves a marker that makes every later start exit immediately, except a
   `quarantined` teardown, which idles instead (see section 3).
7. `--force` on `autostart install` bypasses only the location refusal; any successful explicit
   install sets `autoInstall=true`.

## Left behind

Accepted at the round cap (round 6), with reasons. None of them can restart the spending: the
scheduler gate refuses every job for a recorded throwaway before teardown even runs, and the funnel
refuses any reinstall.

- `complete` means the unload was issued and accepted, not independently re-verified afterwards. A
  later start (if any) re-checks the loaded job.
- If the unload succeeds but the final marker write fails, or the agent runs with no supervisor at
  all, there is no further retry. The job is gone in the first case; in the second there is nothing
  to restart it.

- A throwaway created in a normal folder with the real `HOME` (e.g. a script deploying under
  `~/.instar/test-deploys`) gets no expiry and keeps running jobs. Location cannot see it; covering it
  needs a different signal (e.g. "non-interactive init never followed by an explicit autostart
  install"); it is in the feedback queue as fb-f9982c10-c77.
- Override use (`--force`, `allowOnThrowawayAgent`) is printed to the console but not written to a
  separate audit log.
- An agent misclassified as throwaway raises no attention item (it only logs and records skips).
- The pre-existing install path's `bootout` of a same-name loaded label (`setup.ts`) can replace a
  different home's job; unchanged here.
- `installLinuxSystemdService`/`uninstallAutoStart` call `systemctl` without a test-runner guard;
  pre-existing, unchanged.

## Open questions

*(none)*
