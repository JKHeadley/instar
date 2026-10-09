---
title: "Watchdog test-runner floor (ACT-069)"
slug: "watchdog-test-runner-floor"
author: "echo"
parent-principle: "Bounded Blast Radius; Judgment Within Floors"
eli16-overview: "watchdog-test-runner-floor.eli16.md"
status: "converged"
approved: true
approved-by: "Justin, 2026-10-08 14:49 — standing approval for agent-comms work and the fixes it surfaces: \"Yes, you have my approval to proceed on this without asking for further approval\". This fix closes evolution action ACT-069."
review-convergence: "2026-10-09T11:32:47.551Z"
review-iterations: 4
review-completed-at: "2026-10-09T11:32:47.551Z"
review-report: "docs/specs/reports/watchdog-test-runner-floor-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Watchdog test-runner floor

## 1. The failure

On 2026-10-08 the session watchdog (`src/monitoring/SessionWatchdog.ts`) sent
SIGINT to a full `npm test` run three times, each at about 190 seconds, and to a
python polling helper at 251 seconds. The intervention log shows the same shape
before and after: `npm run test:integration` (10-05), `npm exec vitest run …`
(10-05, 10-07), the Vitest main process `node (vitest)` (10-05) and a Vitest
worker `node (vitest 1)` (10-09).

The path: once a child process of a session has run past `stuckCommandSec`
(default 180 s), the watchdog asks an LLM judge "stuck or legitimate?". Under CPU
saturation a busy test run prints slowly, and the judge answered "stuck". There
is already a deterministic, time-bounded floor that skips the judge for known
waiters (`classifyProtectedWait`: safe-merge, `gh run watch`,
`gh pr checks --watch`, two-hour bound). Test runners were not on it.

A second, smaller gap: when the judge cannot run, the hard ceiling
(`hardCeilingSec`, default 1800 s) kills any command past 30 minutes, including
a full suite that is slow because the machine is busy.

## 2. The change

1. **`classifyTestRunnerCommand(command)`** — a pure, exported function that
   matches the argv contract of known test runners, by executable position,
   never by substring:
   - `npm test`, `npm t`, `npm run test`, `npm run test:<name>`,
     `npm run-script test…`;
   - `pnpm` / `yarn` `test`, `test:<name>`, `run test…`;
   - `npm|pnpm|yarn exec vitest …`, `npx vitest …`, `pnpx vitest …`;
   - `vitest …`, `node …/vitest`, `node …/vitest.mjs` (any path);
   - Vitest's own rewritten process titles, exactly `node (vitest)` and
     `node (vitest N)`.

   Near-misses do not match: `echo npm test`, `grep -r vitest src`,
   `node worker.mjs --label npm test`, `npm run build`, `npm run testing-tool`,
   `npx tsc`, `sh -c npm test`.
   **Input contract.** `command` is the `ps` command column: the process's
   argv joined by spaces, or a title the program set for itself (Vitest does).
   This is command-line *display* matching, not true argv: matching splits on
   whitespace and decides by the executable token (`path.basename`, skipping a
   leading `node`) and the tokens right after it; the two Vitest titles are
   matched as whole strings. Known limits: an executable path containing a
   space (`/Users/x/My Projects/node_modules/.bin/vitest`) is not recognised —
   a false negative that falls back to today's judge behaviour; and any
   process may set its title to `node (vitest)` — accepted, because the cost
   of a false positive is bounded at 60 minutes of withheld interrupt.

   **Ancestors of a running test.** A process that is not itself a runner is
   protected (reason `test-runner-ancestor`) **only while a matched runner is
   running below it** in the process-table snapshot the watchdog already took
   for that poll. This covers the two real carriers: a shell wrapper around a
   compound command (Codex shows `/bin/zsh -lc 'cd repo && npm test'`, which the
   watchdog would otherwise pick first because a parent is always older than
   its child) and `git push` running the instar pre-push test tier. A bare push,
   a push whose hook runs no tests, or `zsh -lc sleep 900` has no runner below
   it and gets no protection. The ancestor's own argv is a symbol; the running
   descendant is the state.
   **Skip, keep looking.** The floor is applied inside the watchdog's
   stuck-child search (`classifyTestRunnerProtection`), not only after it:
   - an over-threshold **matched runner** is left alone and its whole subtree
     (its workers) is skipped;
   - an over-threshold **ancestor** of a runner (wrapper shell, `git push`) is
     left alone but **not** pruned — its other children are still checked;
   - the search then continues with the remaining processes.
   So a test run shields only itself and its own workers. It cannot hide an
   unrelated stuck command elsewhere in the session, or a stuck sibling under
   the same parent shell (`zsh -lc 'npm test & python3 poll.py'`).
2. **`classifyProtectedWait` checks it first**, with its own bound
   `MAX_TEST_RUNNER_PROTECTION_MS = 60 min`. Within the bound the result is
   `{ protected: true, reason: 'test-runner' | 'test-runner-ancestor' }`; past it,
   `{ protected: false }` — returned directly, so wait-looking output cannot
   stretch a test run to the two-hour wait floor. The age used is the age of
   the process being judged, so an ancestor's bound runs from the ancestor's own
   start (always at or before its runner's).
3. **No new wiring for the hard ceiling.** `checkSession` already returns on a
   protected result before it calls `isCommandStuck`, and the hard ceiling only
   lives inside `isCommandStuck`. So a protected test run is not killed by the
   30-minute ceiling before its own 60-minute bound. Past 60 minutes the judge
   decides; if the judge cannot run, the ceiling (already exceeded) applies, as
   for any other command.
4. **Live thresholds.** `stuckCommandSec` and `hardCeilingSec` are read at check
   time through an optional `readLiveWatchdogConfig` constructor option; the
   server passes `liveConfig.get('monitoring.watchdog')`, the existing
   `LiveConfig` reader. A live value is used only if it is a finite number
   `>= 0`; a missing, non-numeric, `NaN`, infinite, negative or unreadable
   value falls back to the boot value (never to an implicit 0). Zero keeps its
   existing boot meaning: `stuckCommandSec: 0` sends every command to the judge
   at once, `hardCeilingSec: 0` disables the ceiling. `pollIntervalMs` stays
   boot-only: it sizes a `setInterval`, and changing it live is not cheap.
   Note the direction: unlike items 1–3, a live edit can make interrupts
   *earlier* (lowering `stuckCommandSec` or `hardCeilingSec` now takes effect
   without a restart). That is the same authority the boot value already has;
   only the timing of when it applies changes.

### Why 60 minutes

A full instar unit suite takes about 5–15 minutes on an idle machine and has run
past 30 minutes under CPU saturation, which is exactly when the judge misreads
it. One hour covers a saturated full suite with margin. It is shorter than the
two-hour external-wait floor because a test run is local CPU work, not a wait on
someone else's system, and a genuinely hung run should go back to the judge the
same afternoon.

## 3. What this does not do

- It does not protect watch-mode runs specially. `npm run test:watch` is matched
  and protected for 60 minutes like any test script, then judged as before.
- A genuinely hung process *inside* a runner's own subtree is shielded until
  the 60-minute bound. Everything else, including other children of the
  runner's wrapper, is judged as before.
- The bound is effectively per test run. Each process is bounded by its own
  age, and the search visits parents before children, so once the outermost
  matched runner passes 60 minutes it is the one selected and judged; young
  workers it keeps spawning are never reached ahead of it.
- An ancestor's bound runs from the ancestor's own start. A wrapper that ran
  for an hour before starting its tests (`setup; npm test`) is judged at 60
  minutes even though the runner below it is young. Late-starting tests under
  a long-lived wrapper get less than 60 minutes of protection; that case is
  accepted rather than adding per-runner age tracking.
- Vitest's process title (`node (vitest)`) is the strongest evidence available
  without structured process data. It is set by the runner itself; a process
  that deliberately claims it gets at most 60 minutes of withheld interrupt
  (and its ancestors the same), never any other authority.
- When protection lapses and the judge errors or is absent, the existing hard
  ceiling decides, as it does for every other command today. That fail-closed
  path predates this change and is unchanged by it.
- Signal targeting is unchanged. When protection lapses and the judge says
  "stuck", the existing path sends a targeted SIGINT to the one selected PID
  after its action-time identity check, exactly as for any other command. This
  change does not alter what a wrapper or runner does with that signal.
- It does not change the judge prompt, the escalation ladder, or the stdin
  consumer and pipeline guards.

## Decision points touched

| Decision point | Change | Classification |
|---|---|---|
| `classifyProtectedWait` / `classifyTestRunnerProtection` — skip the stuck judge for a known waiter | modified: adds test runners, and any process with a running test runner below it, with a 60-minute bound | invariant — deterministic command-line match plus a time bound; as a rule it can only withhold an interrupt from the process it classifies |
| stuck-child selection in `checkSession` | modified: a protected runner's subtree is skipped and the search continues (previously the first over-threshold process ended the search) | invariant — traversal order; it can surface a *different* over-threshold process to the judge, which then decides as for any command |
| `checkSession` stuck threshold (`stuckCommandSec`) | modified: read live, boot value as fallback | invariant — numeric knob, same semantics |
| `hardCeilingExceeded` (`hardCeilingSec`) | modified: read live, boot value as fallback | invariant — numeric knob, same semantics |
| `isCommandStuck` LLM judge | pass-through: still decides every unprotected command and every test run past 60 minutes | judgment-candidate (already a judgment point; unchanged) |

## Multi-machine posture

Unified, unchanged. This change adds no state and no new config surface.

- The classifier is a pure function of one process's argv, its age, and the
  argv of the processes below it. It holds nothing between polls.
- The thresholds it reads (`monitoring.watchdog.stuckCommandSec` /
  `hardCeilingSec`) are the existing keys in the agent's config, carried across
  machines exactly as the rest of that config already is. This change only moves
  *when* they are read (each check instead of once at boot); it does not make
  them more or less shared than they are today.
- What the watchdog acts on is the operating-system processes of sessions
  running on the machine doing the check — the same scope as before. No
  decision, record or signal crosses machines.

## Maturation plan

- **test-agent-live:** the integration tests drive the real `checkSession`
  path with the recorded process trees (the 2026-10-08 `npm test` at 190 s,
  a wrapper shell, a `git push` with Vitest below it) and a judge that always
  says "stuck"; none of the protected processes is signalled.
- **dev-agent-live:** live on the development agent from the release that
  carries it. For one week, read `.instar/watchdog-interventions.jsonl` and the
  server log's `protected wait (test-runner…)` lines.
- **fleet:** the same release, ungated. The classification only withholds an
  interrupt from what it classifies, so holding it back would keep the harm.
  The traversal change can put a different process in front of the judge (an
  unrelated stuck command a test run used to hide); that process is judged
  exactly as it would be with no test run present. The live-threshold read can
  move interrupts earlier or later, but only when an operator edits the
  existing keys.
- **graduation criterion:** over the dev-agent week, zero SIGINT rows whose
  selected process was, in that poll's snapshot, a matched runner or an
  ancestor of one younger than 60 minutes, and at least one `protected wait
  (test-runner…)` log line (a zero count means nothing was exercised, which is
  not a pass). Protection is best-effort against the snapshot: a wrapper that
  starts its test between the snapshot and the signal (one judge call) is not
  seen; the next poll sees it.
- **dark-window:** none. This removes a false interrupt; shipping it dark would
  keep the incident going.
- **Rollback:** revert the PR. There is no config switch; the 60-minute bound
  is the safety valve.

## Testing

- Unit (`tests/unit/session-watchdog-test-runner-floor.test.ts`): every matched
  shape, every near-miss, both sides of the 60-minute boundary, and the
  wait-output-past-bound case.
- Integration (`tests/integration/session-watchdog-safe-wait.test.ts`): the
  2026-10-08 shape (`npm test` at 190 s, judge says stuck) is neither judged nor
  signalled; a compound shell wrapper over `npm test` is not signalled; a
  `git push` with Vitest below it is protected and a bare push is judged; a
  45-minute run with the judge erroring or absent is not killed by the
  30-minute ceiling; past 60 minutes protection is removed and the outcome
  follows the judge (stuck → signalled, legitimate → left alone, erroring →
  hard ceiling already exceeded → signalled); an ordinary quiet command at the
  same age is still judged; a protected background test run does not hide an
  unrelated stuck command, either elsewhere in the session or as a sibling
  under the same parent shell (that command is judged and signalled); an ancestor
  past 60 minutes with a young runner below it is judged; live `stuckCommandSec` / `hardCeilingSec` take
  effect and invalid values fall back.

## Open questions

*(none)*
