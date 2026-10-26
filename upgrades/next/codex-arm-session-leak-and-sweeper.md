## What Changed

**Codex arm-session leak closed at the source, with a watch-only sweeper behind it**
(spec `docs/specs/codex-arm-session-leak-and-sweeper.md`, side-effects
`upgrades/side-effects/codex-arm-session-leak-and-sweeper.md`).

- `makeTmuxTrustDriver` now creates the `instar-codex-arm-*` tmux session WITH its own
  `kill-session` scheduled inside the tmux server, in the same single request
  (`new-session … ';' run-shell -b …`, `armSessionCreateArgv`). A parent killed mid-poll —
  which is PostUpdateMigrator on every update — no longer leaves an interactive codex running
  forever. The job is guarded by `has-session`, silent, and always exits 0, so a timer firing
  after the normal teardown cannot render an error into another session's pane. Exact
  `=session` targets everywhere; two-interpreter quoting guard (`#`, `'`, relative path) that
  refuses to create a session rather than create one without a net.
- `projectHooksAreInstarOwned` (F1) is now exact equivalence: an extra non-instar command or an
  undeclared event in `.codex/hooks.json` refuses to arm, instead of being trusted along with
  instar's own hooks.
- New `CodexArmSessionSweeper` (`GET /codex-arm-sweeper`, `/guards` row, audit
  `logs/codex-arm-sweeper.jsonl`): lists tmux, keeps only names whose embedded base36 birth
  time agrees with tmux's own `session_created`, keeps attached sessions, and reports (dry-run,
  the default) or kills (`dryRun: false`, read live) corroborated orphans older than 15 min
  (5-min clamped floor). Fail-closed on an unreadable session or protected-name list; recovering
  breaker; per-pass attempt cap + 3 s wall-clock budget; `alreadyGone` via a three-state probe.
- Registered as self-action controller `codex-arm-session-sweep`; awareness section shared by
  `templates.ts` and `PostUpdateMigrator.ts` (`CODEX_ARM_SWEEPER_CLAUDEMD_SECTION`).

## What to Tell Your User

Nothing to do. If a machine of yours has been slowly filling with abandoned Codex terminal
sessions after updates, that stops with this release: each one now closes itself ten minutes
after it is opened, whatever happens to the process that opened it. A small watcher also
reports, but does not close, any of the old kind still sitting around; its report is on the
agent's status page under the codex-arm sweeper, and the number to read is the count of
distinct sessions it would close. Turning it live is one setting, read on the fly; turning it
off is one setting too.

## Summary of New Capabilities

- `GET /codex-arm-sweeper` — posture, counters, last kills, kept reasons, breaker state.
- `monitoring.codexArmSessionSweeper` — `enabled` (default true), `dryRun` (default true, live),
  `maxAgeMs`, `sweepIntervalMs`, `maxKillsPerPass`, `maxPassMs`, `maxConsecutiveListFailures`,
  `breakerProbeEveryPasses`, `maxKillFailuresPerSession`.
- `/guards` row `monitoring.codexArmSessionSweeper.enabled` with a live runtime getter.

## Evidence

- Measured on the operator's laptop: 25 orphans retired 2026-10-24, 16 more (oldest 43 h)
  2026-10-25 — ~8/day; the machine held 112 tmux sessions while `GET /sessions` said 11.
- `tests/integration/codex-arm-self-destruct-real-tmux.test.ts` (isolated tmux socket): the
  abandoned session dies after the TTL with no help from its creator; the finally-first path
  leaves a sibling pane's `pane_in_mode` at 0 and still receiving keystrokes; `=target`
  refuses a longer-named sibling.
- Unit: `codex-arm-session-sweeper.test.ts` (44), `codex-hook-arm-create-argv.test.ts` (6),
  `codex-hook-arm-driver-wiring.test.ts` (2), `codexHookArm.test.ts` (9, incl. F1 exact
  equivalence); integration `codex-arm-sweeper-routes.test.ts` (3); e2e
  `codex-arm-sweeper-lifecycle.test.ts` (3); `self-action-convergence.test.ts` proves the
  horizon-independent bound.
- Spec converged over 2 review rounds + a verification re-read: Standards-Conformance Gate,
  an independent code review, codex gpt-6-astra and claude-fable-5 clean-door each round, and
  the six internal lenses — report `docs/specs/reports/codex-arm-session-leak-and-sweeper-convergence.md`.
