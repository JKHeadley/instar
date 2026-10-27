# Side-Effects Review — Test-agent leak guard

**Version / slug:** `test-agent-leak-guard`
**Date:** `2026-10-26`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

A throwaway agent (temp-folder project, sandboxed `HOME`, or a recorded expiry) can no longer become a
permanent launchd/systemd job or run scheduled work on the operator's login. New module
`src/core/ThrowawayAgentGuard.ts` holds the classifications, the init posture, the boot backfill, the
locked teardown and the startup decision. Call sites: `installAutoStart` (the funnel every installer
uses, now under the teardown lock), `PostUpdateMigrator.migrateFleetWatchdog` and
`migrateBootWrapperToCjs`, the server startup self-heal and a new 5-minute expiry timer
(`server.ts`), the lifeline start and a 60-second timer (`TelegramLifeline.ts`), `JobScheduler.triggerJob`
(new `throwaway-agent` skip), `loadConfig` (carries `scheduler.allowOnThrowawayAgent`), `initProject`
(`--autostart`, `--expires-in`, `--keep`), `instar autostart install --force`, `instar join`, the
CLAUDE.md template + migration, and one dashboard label. Tier 2; 21 files; spec review ran 6 rounds
(the Tier-2 cap) — rounds 4–6 were teardown failure-handling edge cases after the spend is already
stopped, which is the long tail.

## Decision-point inventory

- `installAutoStart` funnel — add — refuse for a throwaway location / expired marker unless `force`.
- `migrateFleetWatchdog` — add — skip for a throwaway agent.
- Server/lifeline startup self-heal install — modify — skip install-when-missing on `autostart.autoInstall === false`.
- `JobScheduler.triggerJob` — add — refuse every job for a temp-folder / recorded throwaway, no retry.
- Startup decision (server + lifeline) — add — run / exit / idle on expiry.
- Expiry teardown — add — remove only this agent's own unit (exact working-directory match, file and loaded job).

---

## 1. Over-block

- A person who deliberately keeps a real, long-lived agent in `/tmp` or `/var/folders` loses autostart
  and scheduled jobs and gets a 24-hour expiry at its next boot. Overrides: `--keep` (init),
  `instar autostart install --force`, `scheduler.allowOnThrowawayAgent: true`. This is the accepted
  default policy (spec, Frontloaded Decision 4 and "Why deterministic").
- A real agent created or run with `HOME` different from the account home (a systemd
  `Environment=HOME=`, `sudo -E`, a container) cannot install autostart from that environment without
  `--force`. Jobs and expiry are unaffected (they need a temp-folder project, a record, or
  `--expires-in`).
- A non-interactive `init` at a normal location records `autoInstall:false`; such an agent no longer
  installs autostart by itself until `instar autostart install` runs. The setup wizard already runs it
  (step 5c and the restore flow), and `join` marks it explicit.
- Existing tests that write plists from tmpdirs are refused by the funnel; the funnel sits in front of
  all plist writing on purpose (see Evidence for how those tests were handled).

## 2. Under-block

- A throwaway in a normal folder with the real `HOME` (e.g. `~/.instar/test-deploys`) is not detected
  by location: no expiry, jobs still run. Recorded in the spec's Left behind and filed as fb-f9982c10-c77.
- Background LLM calls that are not scheduled jobs are not gated before expiry; they stop when the agent
  expires.
- A teardown whose unload is accepted is not re-verified; a failed final marker write after a
  successful unload gets no further retry. Neither can restart spend (the scheduler gate and funnel
  already refuse).

## 3. Level-of-abstraction fit

Right layer. The autostart check is in the single install funnel rather than at each caller, so every
present and future writer is covered; the one writer that bypassed the funnel (the fleet-watchdog
migration) gets the same function. The job check is one gate at the scheduler's admission point, which
every trigger path (cron, catch-up, manual, retry) already funnels through. Classification is a shared
pure module, so server, lifeline, scheduler and CLI cannot disagree.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Yes, deterministic — and deliberately so (not brittle-heuristic authority over competing signals).

These are invariants, not heuristics: a path comparison against fixed OS temp roots, `$HOME` vs the
user-database home, and a recorded deadline vs the clock. There are no competing signals to weigh, the
inputs are not message content, and every rule has an explicit operator override. Putting a model in
front of a mechanism whose purpose is to stop spending on a model would add the cost and a failure
mode it exists to remove; all three cross-model reviewers agreed with that (spec, "Why deterministic").

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Each point is classified `invariant`
with its justification in the spec's `## Decision points touched`.

## 5. Interactions

- **Server autostart self-heal**: install-when-missing is skipped on `autoInstall:false`; the regenerate
  branch now only runs when the unit exists (it used to fall into a reinstall when the plist read failed).
- **Lifeline `selfHealPlist` / migrator regenerations**: go through the funnel; a throwaway is refused
  and the migrator records a skip, not an error.
- **ServerSupervisor**: when the server exits on expiry the supervisor may restart it within the
  lifeline's 60-second window; the restarted server stops at the marker immediately.
- **test-as-self**: its throwaway home's dying server can no longer re-install a plist (the class its
  teardown comment describes); its own teardown keeps working.
- **Same-name real agent**: teardown never touches a unit whose working directory is not this agent's,
  including a loaded job whose output merely mentions our path.
- **Install vs teardown**: both take the same per-agent lock (pid-liveness takeover only).

## 6. External surfaces

- New CLI flags: `init --autostart/--expires-in/--keep`, `autostart install --force`.
- New config fields: `throwawayAgent`, `autostart`, `scheduler.allowOnThrowawayAgent`.
- New skip reason `throwaway-agent` (dashboard label "test agent in a temporary folder").
- launchd/systemd: an expired throwaway removes and unloads its own unit. Under a test runner no
  `launchctl`/`systemctl` command runs from the teardown.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The only operator-surface change is one label string in `dashboard/console/schedule-model.js`.
1. Leads with the primary action? Unchanged layout; the label is a reason line on an existing schedule row.
2. Zero raw internals? Yes — the raw key `throwaway-agent` is replaced by "test agent in a temporary folder".
3. Destructive actions de-emphasized? No actions added.
4. Plain language + phone width? Plain words; same short-label slot as the existing reasons.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design (`physical-credential-locality`): the autostart unit, the temp-folder location
and the Keychain login all live on one machine. The new config fields are per-machine and not
replicated. No user-facing notices are added (one-voice not applicable), no URLs, and the expiry
teardown also runs on a read-only standby because it is machine-local.

## 8. Rollback cost

Revert the PR; the new config fields are inert without the code. An agent that already expired stays
stopped; deleting `.instar/state/throwaway-expired.json` and its `throwawayAgent` field (or
`instar autostart install --force`) revives it.

## Conclusion

Ship. The incident path is closed at the point that caused it (the funnel), verified live on macOS
with the real launchd, and the scheduler gate stops the spend independently of teardown.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (claude-opus-5-5), 2026-10-26
**Independent read of the artifact:** concern raised (4 items), all resolved, then concur.

1. *`withTeardownLock` caught `fn()`'s own errors and could re-run it unlocked (or treat an `EEXIST`
   from inside the install as lock contention).* Resolved: lock acquisition is now its own function;
   `fn` runs exactly once outside any catch and its errors propagate unchanged. Test: "the lock runs
   fn exactly once and never retries its errors".
2. *A real agent created under a different HOME (`sudo -E`, a container) got a 24h expiry.* Resolved:
   a sandboxed HOME alone, at init or at boot, now only blocks autostart; an expiry needs a temp-folder
   project or `--expires-in`. Spec table, P20 section and Frontloaded Decision 4 updated. Test: "a
   sandboxed HOME alone at a normal location blocks autostart but records no expiry".
3. *A failed `autostart install` step after a non-interactive init leaves the agent without
   auto-start, silently.* Partly resolved: the server now prints one boot line ("Auto-start is off for
   this agent … run `instar autostart install`") and the lifeline already did. A `doctor`/`/guards` row
   for that state is filed as fb-bd38cf89-0b1 (feedback queue).
4. *Self-unload kills the caller before the outcome is written.* Resolved: the outcome the unload
   would produce is written first and corrected on failure. Test: "the outcome is written before the
   self-unload".

Clean per the reviewer: teardown cannot touch another agent's unit; startup cannot crash on the guard;
the server self-heal change is equivalent to the old logic for existing agents; signal-vs-authority.

## Evidence pointers

- Live macOS reproduction `scripts/livetest-test-agent-leak-guard.mjs`: 14/14 checks passed on the Mac
  Studio (2026-10-26 ~19:50 PDT) — init in the incident shape records both fields; two foreground
  server starts load no job and write no plist in either home; the fleet watchdog plist is untouched; a
  `--force`-installed throwaway is loaded with this agent as its working directory, and after its
  record is expired and launchd restarts it, it unloads itself, removes its plist, is not restarted,
  and the marker says `complete`.
- Unit: `tests/unit/ThrowawayAgentGuard.test.ts` (31), `tests/unit/JobScheduler-throwaway-guard.test.ts`,
  `tests/unit/Config-throwaway-scheduler.test.ts`.
- Integration: `tests/integration/test-agent-leak-guard.test.ts` (7).
- E2E: `tests/e2e/test-agent-leak-guard-lifecycle.test.ts` (5) — the built CLI exits 0 on an expired
  throwaway, writes the marker, binds no port; wiring integrity for server and lifeline.

## Class-Closure Declaration (display-only mirror)

This change adds self-triggered controllers (the expiry timers and teardown).
- **`defectClass`** — `unbounded-self-action`.
- **`closure`** — `guard`.
- **`guardEvidence`** — enforcementType `ratchet`, citation `tests/unit/self-action-convergence.test.ts`;
  howCaught: control-loop edge = expiry check → teardown → exit; steady-state bound = teardown runs at
  most once per process start and at most 5 attempts per agent ever (then `quarantined`, terminal);
  settling brake = the marker makes every later start exit (or idle when quarantined) without starting
  any subsystem, so launchd `KeepAlive` cannot form a restart loop. Timers are 5 min (server) / 60 s
  (lifeline), cleared on first expiry.
