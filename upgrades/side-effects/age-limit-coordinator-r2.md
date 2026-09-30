# Side-Effects Review — an age-limit kill records uncommitted work, so the session is revived

**Version / slug:** `age-limit-coordinator-r2`
**Date:** `2026-09-29`
**Author:** `echo`
**Second-pass reviewer:** `required (session lifecycle: the age-limit kill path)`

## Summary of the change

On 2026-09-30 at 01:52:17Z the age gate ended the Instar 2.0 coordinating
session (`echo-deepseek-harness`, topic 52075, 975 minutes old) as `terminal`
with `midWork:false`. The resume queue then logged
`enqueue-skipped why:insufficient-evidence`, so the session was not revived.

What the logs and the session's own transcript show:

- 01:28:55Z: the gate deferred the kill with `procs=true`. A command had timed
  out in the foreground at 01:26:20Z and moved to the background (task
  `bwm8gw0jq`). Its shell was a live child process.
- 01:38:14Z: that task finished. No other background task was open: every
  task started since 12:00Z has a completion notification.
- 01:38–01:40Z: the session archived its own expired autonomous state file
  (`52075.local.md` → `52075-run12-expired-archive.local.md`; the run was
  from 2026-09-24 and was set for 24 hours), then cleared its native goal
  through `/autonomous/native-goal/clear`. Its last transcript write was
  01:40:16Z, at the end of a turn.
- 01:52:17Z: no child process, no transcript write for 12 minutes, no
  autonomous run, last seen working more than 10 minutes earlier. The gate
  read it as idle and killed it.

So the classification was consistent: `procs=true` at 01:28 because a shell
was running, and idle at 01:52 because nothing was. No signal flipped. Two
premises in the task brief did not match the evidence:
- The goal was not active. The session had cleared it itself at 01:40.
- The `invalidated:resume-uuid-stale` entry is `rq-mu84tcnc-0`, queued
  2026-09-19. This kill produced no resume entry at all.

The ordering the brief asked about is already right. `beforeSessionKill`
saved the resume UUID at 01:52:17.396Z, before the `sessionReaped` enqueue
hook read it at 01:52:17.417Z.

The real gap is a difference between the two killers:
- The idle reaper (`SessionReaper.#performReap`) runs the Build-Session Yield
  Safety `dirtyCheck` on the session's worktree before the kill, and records
  `uncommitted-worktree-work`, which is strong evidence. That is how this same
  session, with the same cwd, was revived on 2026-09-28 (reap-log
  `reaped-idle`, `workEvidence:["uncommitted-worktree-work"]`).
- The age-limit kill supplied no evidence. The chokepoint fallback
  (`ReapGuard.workEvidence`) has no dirty-worktree probe, so the kill was
  recorded as not mid-work.

The change:
- `SessionManager.setWorktreeDirtyCheck()` receives the same bounded, cached,
  fail-open probe the reaper gets. It is wired in `server.ts` only when the
  dev-gated `yieldSafety` feature is live, which is the same gate the reaper
  uses.
- Before an age-limit kill, `#ageKillWorkEvidence` supplies the guard's
  observe-only evidence set (exactly what the chokepoint fallback computed
  before) plus `uncommitted-worktree-work` when `session.cwd` is dirty (same
  input as the reaper; no cwd → no probe). A probe that throws omits the
  signal.

**What this means in practice (stated plainly, from second-pass review).**
Topic sessions record the agent home as their cwd. On Echo that checkout
always shows uncommitted files (config and skills churn, 335 entries on
2026-09-29), and the residue denylist does not cover them. So on a dev agent
where `yieldSafety` is live, every age-killed topic session will carry
`uncommitted-worktree-work` and be revived with its conversation. That is
the outcome the task asked for: an age-limit kill of a topic-bound session is
a restart-with-resume, not a terminal end. It is not a new behaviour class.
The idle reaper already revives these same sessions on the same evidence:
all seven `reaped-idle` resume entries on Echo carry only that signal with
that cwd. Revival stays bounded by the resume queue's resurrection cap (≤2
per 24h per topic, then a loud attention item and no further revival),
its drain-time checks, and the fleet's dry-run default. On the fleet,
`yieldSafety` is off, so nothing changes there.

Eligibility, the resurrection cap, dry-run and the drain-time checks all stay
in the resume queue, unchanged.

### Already consistent (verified, no change)

- A live background shell (`run_in_background` or a timed-out foreground
  command) is a non-baseline descendant of the pane, so `hasActiveProcesses`
  reads true. The age gate and the idle block use the same probe.
- An active autonomous run or goal: the age kill goes through the ReapGuard
  KEEP cascade. Guard L (`buildOrAutonomousActive`, which checks for a fresh
  `autonomous/<topic>.local.md`) vetoes it. A new test pins this.
- Recent transcript writes and the 10-minute work memory are unchanged
  (from round 1, PR #2092).

### Considered and dropped (Occam)

- **A separate "always revive topic-bound age kills" route (new reason tag
  or disposition).** On Echo the evidence route above already produces this
  result, bounded by the existing cap. A second route would duplicate it and
  would also fire on agents where `yieldSafety` is off, which is a spend
  decision the fleet has not made.
- **Skip the probe when the cwd is the agent home** (reviewer's alternative).
  That would make this change a no-op for the incident session and keep the
  two killers disagreeing about the same sessions. The broader question,
  whether agent-home dirt should count as work at all, applies to the reaper
  too. It belongs in a separate change to `worktreeDirtyCheck`'s residue
  denylist, not in this fix.
- **Treat the pane's "1 shell" footer as work.** No process or task was
  alive at 01:52 (task-output mtimes and completion notifications agree).
  A footer string is a symbol, not the state (Rule 26).

## Decision-point inventory

- Age-kill work-evidence stamp (`#terminateLocalAgeExpiredSession`): changed
  from the chokepoint fallback to killer-supplied evidence. The result is the
  fallback set plus an optional `uncommitted-worktree-work`.
- No keep or kill decision changes. `isAgeGateTrulyIdle`, the KEEP guard and
  the backoff are untouched.

## 1. Over-block

No new block. The kill happens exactly when it did before.

## 2. Under-block

Not a block surface. A revival still needs the resume queue's own gates:
operator-origin veto, topic or opted-in job, resurrection cap (≤2 per 24h per
topic), and drain-time reality checks. On a dev agent whose home checkout is
always dirty, every age-killed topic session becomes revivable. Each revival
costs one continuation turn, at most twice per topic per day, and then the
cap stops it loudly. This is the trade the idle reaper already makes for the
same sessions.

## 3. Level-of-abstraction fit

Evidence is collected at the killer's decision point, in the monitor loop,
never on the terminate chokepoint. That is the spec's R2.1 contract and how
the reaper does it.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface.

It only adds an evidence signal. The resume queue keeps authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic. It reuses the existing `worktreeDirtyCheck`, including its
residue denylist.

## 5. Interactions

- **Resume queue:** age-killed sessions with a dirty worktree become eligible,
  as `reaped-idle` ones already are. The resurrection cap bounds a
  kill→revive→kill loop, and it raises a loud aggregated item.
- **Reap-log and ReapNotifier:** `midWork:true` plus the evidence list on
  those kills, so the notifier's "restart is queued" copy is accurate.
- **Cost:** one cached `git status` per age kill (rare: at most once per
  session per age window). The kill is otherwise unchanged.

## 6. External surfaces

None. No routes, config keys, messages or persisted schema. Reap-log rows for
age-limit kills can now carry `uncommitted-worktree-work`.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface. Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local. The age gate and the probe read local panes and the local
worktree. The resume queue's `topic-owner-elsewhere` check is unchanged.

## 7b. Constitutional Rules touched (Instar 2.0 `docs/01-the-rules.md`)

- **Rule 26 (verify the state, not its symbol):** the evidence is the
  worktree's git state, not a pane string. The "1 shell" footer is
  deliberately not used.
- **Rules 68 / 97 (preserve live work, continuity):** an age-killed session
  whose worktree holds uncommitted work is now revived with its conversation.
- **Rule 70 (bug evidence):** the replay test fails with the evidence line
  removed and passes with it.
- **Rule 74 (side effects):** this review.
- **Rule 111 (the layer below):** the reaper's probe and the resume queue are
  reused as they are.
- **Rule 116 (simplest robust route):** one setter plus one evidence helper.
  No new revival route, disposition or state.
- **Safety floors:** spend is bounded by the unchanged resurrection cap and
  the fleet's dry-run default. No duplicate sends, because the drainer's
  `live-session-exists` check is unchanged.

## 8. Rollback cost

Pure code change. Revert and ship a patch. No state to migrate.

## Conclusion

The age limit did not flip its view of the session. It ended a session that
really was idle, but it dropped the one piece of evidence the idle reaper
uses to bring such a session back. Both killers now record it the same way.
Clear to ship after review.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the artifact: concern raised → addressed**

Confirmed: the killer-supplied set equals the old fallback (the age kill
passes neither `bypassActiveProcessKeep` nor `knownDead`, and the
critical-pressure handling is the same); the pushed array is fresh; the probe
is try/caught and runs in the monitor tick; the server wiring is in scope and
inside the `yieldSafety` gate; the tests cover both sides.

Concern: on Echo the agent-home cwd is always dirty, so the change amounts to
"always revive age-killed topic sessions", which the first draft said it had
dropped. Minor: the `?? projectDir` fallback went beyond reaper parity.
**Addressed:** the fallback is removed (`session.cwd` only, as in the
reaper). The practical effect is now stated plainly under the summary and in
sections 2 and "Considered and dropped", along with why a separate route and
a home-dir exclusion were not chosen.

## Evidence pointers

- `tests/unit/session-manager-terminate.test.ts`, "age gate R2" tests:
  - The replay (live shell kept on two samples 20 minutes apart; later
    idle-killed with `midWork:true` and `uncommitted-worktree-work`, which
    `classifyEligibility` accepts) fails with the fix line removed.
  - A clean worktree is still reaped and is `insufficient-evidence`.
  - A throwing probe omits the signal and the kill still happens.
  - An active autonomous run keeps an over-age idle session.

## Class-Closure Declaration (display-only mirror)

Adds a signal to an existing self-triggered controller's evidence stamp; no
kill or keep case changes. Revival remains governed by the resume queue's
existing cap. Not an agent-authored-artifact defect; not applicable.
