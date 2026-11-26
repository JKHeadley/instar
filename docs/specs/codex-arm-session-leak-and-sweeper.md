---
title: "Codex arm-session leak: bound the session's own lifetime, and sweep what already leaked"
slug: "codex-arm-session-leak-and-sweeper"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "codex-arm-session-leak-and-sweeper.eli16.md"
status: "converged"
approved: true
approved-by: "echo — standing operator rule (Justin, 2026-10-22, topic 61449): only constitution/CODEOWNERS files need his approval; everything else is merged by the agent after the full gate. Convergence report read in full before approving."
tracked-followups: "<!-- tracked: CMT-1016 --> The SessionReaper pressure-signal fix (docs/specs/reaper-pressure-signals.md) and the machine-wide footprint view are separate changes carried by the same commitment."
review-convergence: "2026-10-26T04:40:57.279Z"
review-iterations: 3
review-completed-at: "2026-10-26T04:40:57.279Z"
review-report: "docs/specs/reports/codex-arm-session-leak-and-sweeper-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 1
contested-then-cleared: 2
---

## 1. The measured problem

`makeTmuxTrustDriver` (`src/core/codexHookArm.ts`) creates a detached tmux session named
`instar-codex-arm-<base36 ms>` to drive Codex's interactive hook-trust prompt. The session
is owned by the **tmux server**, not by the node process that created it. Its teardown lives
solely in a `finally` block:

```js
} finally {
  try { tmux(['send-keys', '-t', `${session}:`, 'C-c']); } catch { /* noop */ }
  try { tmux(['kill-session', '-t', session]); } catch { /* noop */ }
}
```

If the creating process dies between `new-session` and that `finally`, the session survives
**forever**, holding an interactive `codex` at a prompt. The caller that dies this way is not
exotic: `PostUpdateMigrator.ts` calls the arming path on **every update**, and an update
restarts the server — so the race is a scheduled event, not an accident.

Measured on the operator's laptop (`justins-macbook-pro`, 16 cores, 128 GB):

| When | Orphaned `instar-codex-arm-*` sessions | Note |
|---|---|---|
| 2026-10-24 00:40 PDT | 25 | all retired by hand |
| 2026-10-25 20:09 PDT | 16 | oldest 43 h — i.e. they returned after the sweep |

That is roughly **8 new orphans per day on one machine**. On the same census the laptop held
112 tmux sessions while the owning agent's `GET /sessions` reported 11, 1,461 processes and
13,698 threads, and 115 of 128 GB resident with 35 GB in the macOS compressor. The agent
sharing that machine (`ai-guy`) had its server event loop drifting 8-19 s ("CPU starvation" in
its own log), every scheduled job session dying during startup, and its Telegram lifeline
timing out and re-forwarding a single user message ~40 times in 9 minutes.

`git grep instar-codex-arm` over `src/` and `scripts/` on `main` returns exactly one file:
`codexHookArm.ts` itself. **Nothing sweeps these.** Nothing can even see them: instar's
session surfaces enumerate its own `SessionManager` registry, and an arm session was never in it.

## 2. What this change does

Two pieces, deliberately independent, because each fixes a different failure:

**(a) Source fix — the session is created WITH its death already scheduled, in one request.**
The driver issues a single tmux command sequence:
`new-session -d -s <session> … ';' run-shell -b "sleep <TTL>; '<tmux>' kill-session -t '=<session>'"`.
tmux's `;` separator runs both inside the server as one request, so there is **no window in
which the session exists without its timer** — an earlier draft created the session and then
scheduled the timer in a second subprocess call, and the cross-model review pointed out that a
parent killed between the two calls leaves exactly the untimed session this change exists to
prevent. `run-shell -b` runs as a detached job of the **tmux server** (verified end-to-end on an
isolated socket: the kill fires after the invoking process is gone). The pane's content and the
trust state machine are unchanged.

If the argv cannot be built safely (a `#` or `'` in `tmuxPath`, or a RELATIVE `tmuxPath` — the
`detectTmuxPath() || 'tmux'` fallback — which would resolve against the tmux *server's* PATH
inside the job; the string crosses tmux's own `#{…}`/`#(…)` format expansion and then
`/bin/sh`), **no session is created and codex is not launched**: arming without a net is the
leak, so the driver refuses, logs it, and the parent's readback honestly reports not-armed
(`partial`). The trade, stated: a host whose tmux path cannot be quoted never arms its Codex
hooks through this path (they stay dark, which the migrator already reports), where before it
armed without a timer. Both callsites now pass a logger, so the refusal line reaches the
update log.

**Why the race fires as often as it does — a hypothesis, recorded for the check.** The arm
runs inside the post-update migration on the boot path, *before* the server listens, and can
block for the full ~150 s budget. ~8 orphans/day against ~1-3 arms per agent per day on a
five-agent host means a large fraction of arms leak — more than a narrow race would explain.
Candidates: the supervisor's grace-ceiling path, a cascaded second update, the version-skew
lifeline restart. The check is the migrator's new outcome line plus the dry-run audit; the
deeper fix (a long blocking TUI drive on the pre-listen boot path) is out of scope here and
noted, not built <!-- tracked: CMT-1016 -->.

`ARM_SESSION_TTL_MS` is **600 s**. The legitimate worst-case arm lifetime under the
**modeled timeout budget** is **~150 s**, not the "50 s plus `sleep 3`" an earlier draft
claimed: every `tmux` call carries a 10 s timeout, each blocking `sleep` a 15 s timeout, and
the 50 s deadline is only set after creation and launch, so create ≤10 + launch ≤10 + poll ≤50
+ a last iteration that entered at deadline−ε (≤10+10+15+10+15 = 60) + finally (≤20) ≈ 150 s.
600 s is ~4x that; the sweeper floor of 300 s is ~2x. The cost of the margin is that a leaked
session lives ten minutes rather than three, against a measured leak lifetime of 43 hours.

Stated honestly: that is a *budget*, not a hard wall-clock guarantee. Process descheduling
*between* calls under the memory-pressure regime that motivated this spec is unbounded. If a
timer ever fired mid-arm, the effect is fail-safe by construction — the pane dies, the
capture reads empty, and the parent's readback reports not-armed — never a wrong arming.

**The timer job is guarded and silent — a decision, not a detail.** In the happy path the
driver's `finally` has already killed the session, so a bare `kill-session` fails 600 s later.
The lessons-aware review reproduced on tmux 3.7c what happens then: tmux renders a run-shell
job's error into the active pane of ANOTHER session and flips it into view-mode, where
`send-keys` — instar's inbound-message injection path — no longer reaches the shell. Every
*successful* arm would have planted that. The job is therefore
`if has-session -t '=X'; then kill-session -t '=X'; fi` with all output redirected and an
unconditional `exit 0`; the real-tmux integration test asserts a sibling pane's
`pane_in_mode` stays 0 and still receives keystrokes after the timer fires on a dead target.

**Foundation audit, stated rather than taken as given.** The driver this rides is a TUI
state machine: two cheap regexes over `capture-pane` that *act* (press Down/Enter in a live
interactive codex), with the authoritative outcome being the parent's `config.toml` readback.
The matcher is an acting matcher, not a mere flag. Its blast radius is bounded by
construction: the session carries no task, only trust prompts; a mis-press can select the
wrong prompt option but never execute work; and the session is torn down within the budget —
which this change tightens with a hard timer. That foundation is inherited, not endorsed, and
is noted here so it is weighed rather than invisible.

**The simpler alternative, and why it was rejected.** `new-session -d 'timeout 600 codex …'`
would bound the lifetime with no `run-shell`, no two-interpreter guard and no refuse path.
It was rejected because it changes the pane from shell + `send-keys` to a direct exec: the
driver's whole mechanism types a launch line and prompt answers into a shell, and
`/usr/bin/timeout` is absent on older macOS. The chosen design leaves the driver's pane
contract untouched.

The kill target uses tmux's exact form (`=session`). Without it tmux resolves `-t` by
prefix/fnmatch, and a timer for `…-aaa` could kill a live `…-aaabbb` (confirmed on tmux 3.7c).
The existing `finally` teardown stays and now uses the exact form too; in the happy path it
still ends the session in a couple of seconds, and the timer is the floor beneath it. The
driver records whether the schedule succeeded, so "is the source fix working?" is answerable.

The command string crosses TWO interpreters — tmux's own `#{…}`/`#(…)` format expansion first,
then `/bin/sh` — so the quoting guard refuses a `tmuxPath` containing `#` or `'`, and a session
name outside `[A-Za-z0-9._-]`. A refusal degrades to the sweeper; it never guesses.

**(b) Backstop — `CodexArmSessionSweeper`.**
A small monitor that lists tmux sessions and kills any whose name is a **corroborated** arm
session (§3.0 below) and whose `session_created` is older than `maxAgeMs` (default 900 s,
clamped to a 300 s floor — ~2x the ~150 s modeled arming budget). It runs once shortly after
boot and then on an interval. It exists because (a) can still fail
— a `sh` that never starts, a tmux socket that moves, a machine that was already carrying
orphans from a release before this one — and because *the thing that cleans up must not be the
thing that might have died*.

### Why a self-destruct timer is safe HERE, and would not be everywhere

Reviewed with Dawn's agent on 2026-10-25, which runs the same shape of problem on the
same machine and deliberately does NOT use a timer. Its reason is worth recording: a timer
inside a dying session raced that session's own final commit-and-push seven times in
fourteen days, so for its lanes the right owner is a reaper that re-checks at the moment
it kills.

That hazard does not exist for an arm session, and the reason is structural rather than
lucky: **an arm session produces no durable artifact of its own.** It presses two keys at
a TUI prompt. The authoritative outcome — whether the hooks are actually trusted — is the
`config.toml` readback performed by the PARENT (`armCodexHooks`' F2 readback), not by
anything inside the session. Killing the session at any moment can therefore lose nothing
but the pressing of keys that have either already landed or already failed.

The general rule this draws out: a self-destruct timer is safe exactly when the session is
a pure means and its result is recorded elsewhere. Where a session is itself the producer
of durable work, the timer must be a reaper that re-checks at kill time instead.

### Why the sweeper reads tmux, not instar's session list

This is the load-bearing design decision. The 112-vs-11 gap is the whole reason the leak was
invisible for days. A sweeper built on `SessionManager`'s registry would have reaped zero of
the 41 orphans, because an arm session is never registered there. The machine is the source of
truth about what is running on the machine.

## 3. Safety invariants (each one a named test)

(Numbered by the order they were established, not by position in the code.)

0. **The symbol is not the state — the name must corroborate itself.** The prefix alone is a
   string anyone can type. What makes a session provably the driver's is that the driver
   mints the suffix from `Date.now().toString(36)`, and tmux *independently* records
   `session_created`. The sweeper decodes the suffix and requires it to agree with tmux's
   record within `NAME_TIME_TOLERANCE_MS` (5 min — slack for a clock adjustment, not a
   coincidence). A hand-made `instar-codex-arm-SCRATCH` fails the shape check; a hand-made
   `instar-codex-arm-zzzzzzz` passes the shape check and fails the time check. Anything that
   does not corroborate is kept and reported under `keptReasons`.
1. **Prefix is exact and total.** Only `instar-codex-arm-` prefixed names are ever considered.
   A session named `instar-codex-armadillo` is fine (the prefix includes the hyphen); a session
   named `my-instar-codex-arm-x` is not matched (prefix is anchored at position 0).
2. **Age floor beats the arming window.** `maxAgeMs` is clamped to a minimum of `300_000`,
   ~2x the ~150 s modeled worst case (§2a). A live arm in progress is not killed within that
   modeled bound, even by a carelessly configured threshold.
3. **No clock inversion.** A `session_created` in the future (clock skew, a restored machine)
   yields age ≤ 0 and is kept, never treated as infinitely old.
4. **Fail closed.** Any failure listing sessions ends the pass with zero kills and an error
   counter — never a blind kill loop.
5. **Protected and standing names are never touched — and the lookup fails CLOSED.** The
   sweeper reads `sessions.protectedSessions` + `sessions.standingSessions` live on every pass
   and keeps any match (`keptReasons['protected-or-standing']`). If that lookup itself throws,
   the pass kills nothing (`failedClosed`): not knowing what is protected means not knowing
   what may be killed. Unreachable through invariants 0+1 today; asserted as code.
6. **Bounded per pass — on LIVE attempts AND on wall clock.** At most `maxKillsPerPass`
   (default 50) kill *attempts* per pass, counting failures; and once a pass has spent
   `maxPassMs` (default 3 s) it stops issuing kills (`keptReasons['pass-time-budget']`).
   Dry-run observation is exempt from both: it costs a Set insert and no subprocess, and
   capping it would let the first 50 of a standing backlog hide every later candidate from
   the report forever (cross-model review). Both
   subprocess calls are synchronous on the server's event loop. `withSyncOp` lets the
   lifeline's cross-process supervisor attribute the block to a sync op (it reads the mirror
   file during the block); the in-process SleepWakeDetector can only tick after the pass
   returns, so the marker does not protect it — the bound does. Worst case per pass is the
   3 s budget (which the list's time consumes) plus one kill admitted at the budget's edge
   overrunning by its 3 s timeout plus that kill's 3 s failure probe — ~9 s, not the ~510 s
   that 50 kills × a 10 s timeout would have allowed. A healthy tmux lists 36 sessions
   in ~10 ms and an exact-target kill is ~0 ms.
7. **Brakes that RECOVER (No Unbounded Loops).** After `maxConsecutiveListFailures` (5)
   unreadable passes the breaker opens — visible as `breakerOpen` on the route and as a stale
   tick on `/guards`. It is half-open, not permanent: every `breakerProbeEveryPasses` (6, i.e.
   hourly) one probe goes through, and a readable list closes it and sweeps on the same pass.
   This matters because an absent tmux server at boot is the *normal* order on a host; a
   permanent breaker would leave every later session unswept until a restart. After
   `maxKillFailuresPerSession` (3) failed kills of one name, that session is never retried
   (`keptReasons['kill-failures-exhausted']`); the failure map is pruned to names still
   present after every readable pass, so it cannot grow without bound. A kill that fails
   because the session is ALREADY gone — a sibling agent's sweeper or the self-destruct won
   the race, expected on a shared host — is told apart by a three-state `has-session` probe
   (present / absent / UNKNOWN): `absent` only when tmux itself ran and exited non-zero; a
   timeout, a missing binary or a dead socket is `unknown` and counts as an `error`, never as
   a successful cleanup. A failing protected-name lookup charges the same breaker as a list
   failure, so a persistently unreadable config opens the breaker rather than failing closed
   silently forever.
9. **Attached sessions are kept whatever their age — and that is the ONLY activity-shaped
   keep.** `tmux ls` reports `#{session_attached}` for free; a session a client is looking at
   is never an orphan. An earlier draft also kept sessions with recent `#{session_activity}`
   as a "version-independent" live-arm safeguard. Measured on tmux 3.7c (round-2 review, on
   an isolated socket): that field moves ONLY on an attached client's input — not on
   `send-keys`, not on pane output — so for the detached, send-keys-driven arm it was meant to
   protect it never moves at all. The keep was withdrawn rather than left as dead
   reassurance. **Stated plainly: the 300 s floor is the sole protection for a live arm
   driven by a sibling agent on another instar version.** It is a cross-version contract, and
   its margin is ~2x the ~150 s modeled budget; a sibling whose driver genuinely runs past
   300 s would have its arm killed and its readback honestly report not-armed. Whether
   `#{window_activity}` (which DID advance on `send-keys` in the same measurement) can serve
   instead depends on whether an idle leaked codex TUI redraws it — unknown, and named in the
   maturation plan as a thing to measure during the dry-run window, not assumed either way.
8. **Timer periods are validated.** `sweepIntervalMs` / `initialPassDelayMs` pass through
   `resolveTimerMs`, so a `null`, string or NaN from JSON config cannot make `setInterval` spin
   at 1 ms doing a synchronous `tmux ls` (the 2026-09-21 ContextWedgeSentinel incident). A
   throw inside a pass is caught at the interval callback, never escaping as an
   `uncaughtException`.

**Capacity convergence (Capacity Safety).** At 50 attempts per pass and a pass every 10 min
the sweeper can retire 7,200 sessions/day against a measured arrival of ~8/day; with the
source fix live, the arrival is ~0. The per-session kill-failure brake means a session that
cannot be killed costs at most 3 attempts ever, so sustained failure converges to zero work.

## 4. Posture

Ships **enabled, in dry-run**. An earlier draft shipped the kill authority live and argued
from a safety margin that turned out to be built on the wrong number (§2a). The review's
strongest point stands on its own regardless: the **source fix carries the whole forward
benefit** — it stops new orphans — so the sweeper's kill authority only matters for a backlog
that already exists, and the dry-run report (`wouldKill`, `keptReasons`) says *empirically*
whether that backlog is real on a given machine before anything is killed. The graduated path
costs nothing here, which is unusual, and so it is taken.

- `enabled: true, dryRun: true` by default — observes and reports; kills nothing. Read
  `wouldKillDistinct` for the backlog, not `wouldKill`: the cumulative figure re-counts the
  same orphan every 10-minute pass (~144x/day), while `wouldKillDistinct` is the set seen in
  the LATEST readable pass — so a backlog a sibling clears drops out of it next pass.
- `monitoring.codexArmSessionSweeper.dryRun: false` arms it once a dry-run report has shown a
  real backlog. It is **read live at the start of every pass** (`LiveConfig`), so the one
  arming action takes effect within one interval with no restart — the integration review
  found the first draft snapshotting it at boot with no pending signal. The guard row carries
  `dryRunConfigPath`, so the shipped default grades `on-dry-run`.
- `enabled: false` turns it off entirely (next server start — the monitor is constructed at
  boot). Because `defaultEnabled: true`, that grades `off: diverged-from-default` on `/guards`
  and the Guard-Posture Probe raises one attention item. That is deliberate for a default-on
  guard: a sweeper someone switched off should be visible, not silent.
- No dashboard lever: the only operator actions are the two config flags above (precedent:
  McpProcessReaper).
- The 41 orphans measured on the operator's laptop were retired by hand on 2026-10-24/25, so
  no machine is known to be carrying a backlog that needs live kills today.

**Multi-agent machines, stated honestly.** Every instar agent on a host shares the default
tmux socket as the same uid, so each agent's sweeper sees — and in live mode could kill —
every *other* agent's arm sessions, booking them in its own counters and audit. With the
corroboration check and the 300 s floor no live arm is reachable, so the effect is
misattribution of an orphan kill, not harm; a pid-ancestry or `CODEX_HOME` scope would be
the next refinement and is noted rather than built.

## 5. Surfaces

- `GET /codex-arm-sweeper` → `{ enabled, dryRun, maxAgeMs, sweepIntervalMs, maxKillsPerPass,
  passes, killed, wouldKill, wouldKillDistinct, alreadyGone, kept, errors, lastPassAt,
  lastTickAt, lastKills[], lastKillsAt, breakerOpen, consecutiveListFailures, breakerProbes,
  keptReasons }`. `keptReasons` keys: `name-shape-mismatch`, `timestamp-mismatch`,
  `within-age-threshold`, `attached`, `recent-activity`, `protected-or-standing`,
  `kill-failures-exhausted`, `per-pass-cap`, `pass-time-budget`. **503 only when not wired**; a disabled
  sweeper answers 200 with `enabled: false` — read the field, not the status code.
- One row on `GET /guards` (`monitoring.codexArmSessionSweeper`) with a LIVE runtime getter
  (`enabled`, `dryRun`, `lastTickAt`) and `expectRuntime: true`, so the declared 10-minute
  cadence is evaluated. Honest limit: `guardPostureView` grades `on-dry-run` before it
  considers staleness, so under the shipped default a wedged sweeper reads `on-dry-run` with
  `stale: true` only in the runtime projection; the plain `on-stale` grade appears once
  `dryRun: false`. The route's `lastPassAt` / `breakerOpen` / `consecutiveListFailures` are the
  unconditional wedge signals. (For the first 90 s after boot — `initialPassDelayMs` — the row
  reads stale because no pass has run yet; expected.)
- Audit retention (Observable Intelligence's "balanced by Responsible Resource" clause): the
  log is bounded by arrival, not by rotation — one line per LIVE kill (~8/day at the measured
  leak rate, ~0 with the source fix) and in dry-run one per DISTINCT name per process lifetime,
  never one per pass. No rotation is added; at those rates a year is a few thousand lines.
- Audit: one JSON line per kill — and in dry-run, one per DISTINCT name per process lifetime —
  to `logs/codex-arm-sweeper.jsonl` (session name, age, dryRun). Session names carry no content
  (`instar-codex-arm-<base36 timestamp>`). A failed kill also writes one line to `server.log`
  carrying tmux's stderr and the tmux path — names and a binary path, never content.
- Process cost of the source fix: each arm leaves one `sh` + one `sleep` in the tmux server's
  tree for up to 600 s even on the happy path (the `finally` kills the session, not the job).
  Two tiny processes per arm at ~8 arms/day.

## 6. Testing (all three tiers, per the Testing Integrity Standard)

- **Unit** (`tests/unit/codex-arm-session-sweeper.test.ts`): each invariant in §3 against an
  injected tmux lister/killer; the happy path; the dryRun path; the error path.
- **Unit** (`tests/unit/codex-hook-arm-create-argv.test.ts`): the production argv builder —
  one request, the guarded silent job, the TTL, the two-interpreter + relative-path guard, and
  the session-name shape. (The standalone two-call helper was deleted with its test.)
- **Unit** (`tests/unit/codexHookArm.test.ts`): F1 manifest verify is EXACT equivalence — an
  extra, non-instar command in `.codex/hooks.json` refuses to arm.
- **Unit — wiring** (`tests/unit/codex-hook-arm-driver-wiring.test.ts`): drives the REAL
  `makeTmuxTrustDriver` against a recording fake tmux and asserts the creation request ITSELF
  carries `; run-shell -b … kill-session -t '=session'` (no second request, no window), that
  codex launches only after it, that the `finally` tears down with `=session`, and that an
  unsafe `tmuxPath` creates NO session and launches nothing. Deleting the timer from the argv
  fails this test.
- **Integration — real tmux** (`tests/integration/codex-arm-self-destruct-real-tmux.test.ts`):
  the Bug-Fix Evidence Bar. On an isolated tmux socket: issue the REAL atomic argv (short
  TTL), then *walk away* — no finally, no kill, the parent-dies case — and assert the session
  is gone after the TTL. Also proves `=target` refuses to kill a longer-named sibling.
- **Integration**: `GET /codex-arm-sweeper` returns 200 with the shape above when wired, 503
  only when not wired, and 200 with `enabled: false` when disabled.
- **E2E**: the feature is alive on the production initialization path — the route answers 200,
  not 503, after a real server boot.

## 7. Rollback

`monitoring.codexArmSessionSweeper.enabled: false` disables the sweeper (next server start —
the monitor is constructed at boot; it then grades `diverged-from-default`, see §4). The source
fix in (a) changes the arm session's creation request to carry its timer; reverting the commit
restores the two-call creation for every arm that starts afterwards.
Honest caveat: a revert does not cancel `run-shell` jobs already scheduled in a running tmux
server — those fire once, up to 600 s later, against sessions the old code would have left
leaking anyway. Neither piece writes durable state beyond an append-only audit log.

## Decision points touched

| Decision point | Class | Justification / floor |
|---|---|---|
| "Is this tmux session an orphaned arm session that may be killed?" | **invariant** | Deterministic by design and correctly so: a string prefix anchored at position 0 plus an integer age comparison against a clamped floor. There are no competing signals to weigh — the target class is produced by exactly one callsite, has a legitimate lifetime bounded under the modeled budget at ~150 s (§2a), and carries no work. Making this a judgment call would introduce an LLM into a kill path whose correct answer is already total. |
| "May the arm session be created with its kill timer?" | **invariant** | A quoting-safety check for BOTH interpreters the string crosses (`tmuxPath` is absolute and contains no `#` or `'`; session name matches `^[A-Za-z0-9._-]+$`). A refusal creates NO session and launches nothing — the conservative default. |
| "Is the session list readable?" | **invariant** | Any failure ends the pass with zero kills. There is deliberately no classification of the failure (an earlier draft matched tmux's "no server running" message text and returned "no sessions" — a swallowed error in the one component whose job is noticing accumulation). |

No decision point here chooses among competing signals, so none is a judgment-candidate.

## Multi-machine posture

machine-local-justification: hardware-bound-resource

| Surface | Posture | |
|---|---|---|
| The sweeper's kill | **machine-local** | `hardware-bound-resource` — a tmux session exists only inside one machine's running tmux server, a process on that physical host. No other machine can kill it. Each machine sweeps its own. |
| The `run-shell -b` self-destruct job | **machine-local** | `hardware-bound-resource` — a job of that host's tmux server. |
| `logs/codex-arm-sweeper.jsonl` | **machine-local** | `hardware-bound-resource` — an append-only record of kills performed on this host. |
| `GET /codex-arm-sweeper` counters | **proxied-on-read, not yet built** | The counters are OPERATIONAL state, for which the correct posture is a merged `?scope=pool` read — the same shape every other pool view uses. The row's `enabled` / `dryRun` / `lastTickAt` / `stale` are ALREADY pool-visible via `GET /guards?scope=pool`; only the counts are not. Tracked <!-- tracked: CMT-1016 -->. |

`unified` is infeasible for the kill and the tmux entity (there is nothing to replicate — a
process-table handle no other machine can act on). It is not infeasible for the counters,
which is why their row says proxied-on-read rather than claiming the same key.

No durable state crosses a topic transfer; no user-facing notice is emitted, so there is no
one-voice gating question; no URL is generated.

## Verify the state, not its symbol

| | |
|---|---|
| **Symbol** | A tmux session name beginning `instar-codex-arm-`, and its `#{session_created}` timestamp. |
| **Claimed state** | "This is an arm session that `makeTmuxTrustDriver` created and never tore down." |
| **Corroboration** | The name is not incidental: `makeTmuxTrustDriver` is the sole producer (`git grep instar-codex-arm` over `src/` + `scripts/` returns that one file), and it mints the suffix from `Date.now().toString(36)`, so the name is causally tied to a specific creation. The age threshold is corroborated independently by the driver's OWN deadline constant, not by a guess about what "old" means. |
| **Can the symbol be present while the state is absent?** | Yes, in two ways: (1) a human or a future callsite minting a corroborating name on purpose; (2) a LIVE arm from a sibling agent on an older release, descheduled past the floor (§2a admits the budget is not a wall-clock bound) — this is what invariant 9's attached/recent-activity keep exists for, and its fail direction is not-armed, never a wrong arming. The age floor means such a session survives anything under five minutes, and an attached or recently-active one survives regardless (invariant 9); beyond that a forged, idle, detached session would be killed — and it kills only the forged session. This is accepted, named, and is why invariant 5 asserts the protected/standing check as code even though it is unreachable today. |
| **Can the state be present while the symbol is absent?** | Yes — a leaked session whose name was changed (`tmux rename-session`). Nothing in instar does that, and the sweeper would simply not see it. The failure mode is under-reaping, which is the safe direction. |
| **Unmeasurable case** | An unreadable session list is reported as `errors` + `failedClosed: true` with zero kills — an explicit `unknown`, never a flattering "nothing to clean up". |

## Frontloaded Decisions

1. **Ships on, not dark** — argued in §4 rather than assumed. The off switch and the
   dry-run mode are both present for an operator who disagrees.
2. **Threshold defaults: 900 s age, 300 s clamped floor, 10 min sweep interval, 50 attempts
   and 3 s per pass, 600 s self-destruct.** Derived from the ~150 s modeled worst-case arming
   time (§2a), not chosen for feel.
3. **The sweeper reads tmux rather than `SessionManager`** — the load-bearing decision
   (§2); the alternative would have reaped zero of the 41 measured orphans.
4. **No generic "kill any old session" behaviour**, and no action on another system's
   sessions (the 33 `dawn-evolve-*` lanes found in the same census were left to their
   owner, who closed them herself).
5. **No config migration** — defaults live in code, so an absent key already yields the
   shipped behaviour.
6. **Refuse-to-arm beats arm-without-a-net.** When the timer argv cannot be built safely, the
   driver creates no session and launches nothing, so that host's Codex hooks stay dark until
   its tmux path is fixed (the migrator already reports "guards may not fire until re-armed").
   The alternative — create untimed and let the sweeper catch it — would be the more
   conservative choice for the *hooks*, and this is a competing-harms trade, not an invariant:
   it is decided here for the leak, because the sweeper ships dry-run and an untimed session
   on a machine whose path we could not quote is the exact orphan this change exists to stop.
   The refusal reaches the update log on both callsites.
7. **On a shared socket, any agent's orphan is any agent's to close.** Five instar agents share
   one tmux socket as one uid; each agent's sweeper sees all arm sessions. A kill of a
   corroborated, idle, detached, >15-minute-old arm session is the right outcome whichever
   agent performs it; the cost is misattribution in counters/audit and that agent A's live
   sweeper consumes agent B's dry-run evidence. A pid-ancestry / `CODEX_HOME` scope is the
   refinement, tracked <!-- tracked: CMT-1016 -->, not built. The migrator passes port 4040
   to the shared awareness constant (five existing precedents); an agent on another port
   reads the same prose with that one number differing.
8. **Audit retention is bounded by arrival and dedupe, not rotation** (§5).
9. **The timer job is guarded and silent** (§2a) — never a bare `kill-session`.
10. **`expectedTickMs` on the `/guards` row is the shipped 10-minute default.** An operator who
    lengthens `sweepIntervalMs` past ~30 min will read a perpetual `stale`; the manifest is
    static and this is accepted rather than plumbed.

## Maturation plan

- **test-agent-live:** the real-tmux integration test on an isolated socket (parent walks
  away → session dies; finally-first → sibling pane untouched; exact target refuses a sibling),
  plus the unit/integration/e2e tiers, all green before merge.
- **dev-agent-live:** the shipped default (`enabled: true, dryRun: true`) on the development
  agent and on the five laptop agents from the first release that carries it. The agent
  holding CMT-1016 reads `GET /codex-arm-sweeper` on each once a day for the dark window and
  records `wouldKillDistinct` and `keptReasons` on the commitment, plus the update log's
  "created with self-destruct / refused" line from the migrator; the first census is the day
  the release lands on the laptop. Nothing polls on its own, and that is stated rather than
  hidden. The same window measures, on a real idle leaked codex session, whether
  `#{window_activity}` advances on TUI redraw: if not, it is a usable live-arm signal for a
  later increment; if it does, no activity field can serve and the 300 s floor stays the only
  cross-version protection. The answer is recorded on CMT-1016 either way.
- **fleet:** the source fix (the one-request creation with its timer) and the dry-run
  sweeper ship to the fleet in the same release — both are inert as kill authority. No fleet
  flip of `dryRun: false` is planned: the per-machine graduation below is the only path to a
  live kill, decided per host from that host's own report.
- **graduation criterion:** `dryRun: false` on a machine is warranted when `wouldKillDistinct > 0`
  there — a backlog is real on that host. Because `maxAgeMs` (900 s) exceeds the TTL (600 s),
  a corroborated name minted after EVERY agent on that host carries the release is evidence
  the timer failed there; on a shared socket a sibling still on the old release mints untimed
  corroborating names that every agent's report counts, so the criterion is gated on the
  whole host being updated, not on this agent's install. Zero post-release survivors across
  the five laptop agents for 7 days after the last of them updates is the criterion for
  calling the source fix proven; a non-zero count names a host to investigate before anyone
  arms live kills. A zero `wouldKillDistinct` is a pass for the source fix, not a reason to
  arm.
- **dark-window:** 14 days from the release reaching the laptop. If the source fix is proven,
  the sweeper stays dry-run indefinitely as the observing backstop (an `on-dry-run` row is a
  recognised state, not a gap). If any host shows post-release survivors, that host is
  investigated and the decision — arm live there, or fix the host — is recorded on CMT-1016
  with the numbers; never left dark silently.

## Tracked carriers

Every `<!-- tracked: CMT-1016 -->` marker in this spec resolves to this commitment
(ledger: `docs/specs/carriers/codex-arm-session-leak-and-sweeper.json`):

> **CMT-1016** — "Build the three fixes: (1) stop the instar-codex-arm session leak at source and add a sweeper backstop that reads the machine rather than instar's own session list; (2) fix SessionReaper pressure signals — cpuTier derived from loadPerCore read critical at 40% idle CPU, memTier derived from freePct read normal at 115/128GB with 35GB compressed; (3) make the process-footprint monitor actually run on the shared laptop and see all five agents, not just its own." (owner: agent, blockedOn: none, status: pending, opened 2026-10-26T03:10Z, topic 61449)

## Open questions

*(none)*
