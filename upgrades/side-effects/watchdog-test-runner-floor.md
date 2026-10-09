# Side-Effects Review — Watchdog test-runner floor (ACT-069)

**Version / slug:** `watchdog-test-runner-floor`
**Date:** `2026-10-09`
**Author:** `echo`
**Second-pass reviewer:** `internal combined reviewer (spec-converge round 1) + codex-cli external passes (4 rounds), see docs/specs/reports/watchdog-test-runner-floor-convergence.md`

## Summary of the change

`SessionWatchdog` SIGINTed legitimate test runs (`npm test`, `npm run test:integration`, `npm exec vitest run`, `node (vitest)`, `node (vitest 1)`) at ~190 s because its LLM stuck-judge said "stuck" under CPU saturation. This change adds `classifyTestRunnerCommand` (argv contract, executable position only) and checks it first in `classifyProtectedWait` with its own 60-minute bound (`MAX_TEST_RUNNER_PROTECTION_MS`). Any other process (a shell wrapper such as `zsh -lc 'cd repo && npm test'`, or `git push` running a pre-push test tier) is protected (reason `test-runner-ancestor`) only while a matched test runner runs below it in the same process snapshot. `stuckCommandSec` / `hardCeilingSec` are now read live through an optional `readLiveWatchdogConfig` option, which `server.ts` wires to the existing `LiveConfig`. Files: `src/monitoring/SessionWatchdog.ts`, `src/commands/server.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, tests.

## Decision-point inventory

- `classifyProtectedWait` — modify — adds test runners and any process with a running test runner below it, bounded at 60 min.
- `checkSession` stuck threshold — modify — read live, boot value as fallback.
- `hardCeilingExceeded` — modify — read live, boot value as fallback.
- `isCommandStuck` LLM judge — pass-through — still decides everything unprotected and every test run past 60 min.

---

## 1. Over-block

The "block" here is withholding an interrupt, and only within the protected subtree. A test run that is genuinely hung (e.g. a test spawning a process waiting on stdin) is now left alone for up to 60 minutes instead of being judged at 3 minutes. Same trade the existing safe-merge floor makes; the bound limits it. `npm run test:watch` is matched and protected for 60 minutes, then judged as before.

## 2. Under-block

- Test runners the matcher does not know (jest, pytest, `make test`, custom `node scripts/run-tests.js`) are still judged at 3 minutes as before.
- `npm --silent test` (flags before the subcommand) is not matched.
- A run past 60 minutes can still be interrupted by the judge, by design.

## 3. Level-of-abstraction fit

Right layer: it extends the existing deterministic pre-judge floor (`classifyProtectedWait`) rather than adding a parallel check or changing the judge prompt. It reuses the process snapshot the watchdog already took for the descendant check, so no new process enumeration.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface over user content; it can only withhold an existing destructive action.

The judge keeps authority over everything not on the floor. The floor is an argv contract plus a time bound, so it is an invariant, not a brittle detector holding authority to act.

## 4b. Judgment-point check (Judgment Within Floors standard)

This is a floor under an existing judgment point (the stuck judge), declared in the spec's `## Decision points touched`. It is a safety guard on an irreversible action (SIGINT kills the run and its output) and the domain (known test-runner argv) is enumerable. Past the bound the judge decides again.

## 5. Interactions

- **Shadowing:** the floor runs inside the stuck-child search: a protected runner and its own workers are skipped, an ancestor of a runner is left alone but its other children are still checked, and the search continues — so a test run cannot hide an unrelated stuck command anywhere in the session. It is also re-checked in `classifyProtectedWait` before the judge.
- **Hard ceiling:** only applies inside `isCommandStuck`, which a protected command never reaches, so the 30-minute ceiling cannot fire before the 60-minute bound.
- **Double-fire / races:** none; no new state, re-evaluated every poll, no PID exclusion is recorded for protected runners.
- **Feedback loops:** none.

## 6. External surfaces

- Other agents / users: every agent stops losing test runs to false "stuck" verdicts. No new routes, no new persistent state, no notices.
- Live thresholds: a lowered `stuckCommandSec`/`hardCeilingSec` now applies without a restart, so it can make interrupts earlier — same authority as the boot value.
- Agent awareness: one CLAUDE.md template line plus an idempotent `migrateClaudeMd` append (`Command-watchdog test-runner floor:`).
- Operator surface: no operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Unified, unchanged. No new state or config surface; the classifier is a pure function of a process's argv, age and descendants, and the thresholds are the existing `monitoring.watchdog` keys carried however the agent's config already is. No user-facing notices, no durable state, no URLs.

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state. A revert does not remove the CLAUDE.md line already appended on migrated agents; there it would overstate behaviour slightly.

## Conclusion

Clear to ship. Review changed the build twice: the conformance gate flagged that protecting every `git push` trusted a symbol, and both the codex pass and the internal reviewer flagged that a shell wrapper (`zsh -lc 'cd repo && npm test'`) would still be picked and killed first. Both were resolved by one rule: an ancestor is protected only while a matched runner is running below it. A second codex pass flagged that stopping at the first protected process would let a background test run hide an unrelated stuck command; the floor now skips only the runner's own subtree (an ancestor is left alone but its other children are still checked) and keeps searching. A third pass prompted that refinement plus documenting the display-string matching limits and that the bound is effectively per run. The posture wording and the live-threshold direction (a live edit can make interrupts earlier) were also clarified.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (the watchdog is a self-triggered controller that kills processes).
- **`closure`** — `n/a`: this change adds no new emit, retry, loop or target; it only narrows the set of processes the existing kill path may act on, and adds a bound after which behaviour is unchanged. Convergence of the watchdog loop is unchanged or improved.

## Evidence pointers

- `tests/unit/session-watchdog-test-runner-floor.test.ts` — matches, near-misses, both sides of the bound, git-push descendant rule.
- `tests/integration/session-watchdog-safe-wait.test.ts` — the 2026-10-08 shape is not judged or signalled; the hard ceiling does not fire before 60 min; past 60 min the judge runs; live thresholds apply.
- `.instar/watchdog-interventions.jsonl` (2026-10-05 → 10-09) — the real argv shapes the matcher was built from.
