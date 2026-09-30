# Side-Effects Review — an age kill of a session seen working past its limit restarts the resurrection ledger

**Version / slug:** `age-limit-coordinator-r3`
**Date:** `2026-09-30`
**Author:** `echo`
**Second-pass reviewer:** `required (session lifecycle: revival after the age-limit kill)`

## Summary of the change

On 2026-09-30 at 18:14:11Z the age gate ended the Instar 2.0 coordinating
session (`echo-deepseek-harness`, topic 52075, 322 minutes old) as
`terminal`, `midWork:true`, `workEvidence:["uncommitted-worktree-work"]`. It
was not queued for revival and stayed down 37 minutes.

What the logs show:

- `logs/resume-queue.jsonl`: `enqueued` at 10:57:27Z (reaped-idle, revived),
  `enqueued` at 12:51:28Z (reaped-idle, revived), then at 18:14:11.768Z
  `resurrection-cap` with `resurrections:2`. The tombstone in
  `state/resume-queue.json` reads `windowStartAt 10:57:27Z`,
  `lastResumeAt 12:52:02Z`, `resurrections 2`.
- So the age-limit reap and the idle reap were already treated the same on
  eligibility (both carried strong evidence). The difference was only the
  cap: the age kill was the third reap in the window.
- Between the 12:52 revival and 18:02 the session worked: server.log
  17:39:52Z "past the age limit (288m > 240m) but is actively working
  (procs=true ...)"; the transcript `c7790255-...jsonl` shows turns through
  18:02:08Z, then nothing until the 18:51 manual respawn.

**Why #2092's exemption did not keep it alive:** the exemption is correct.
The session ended its turn at 18:02:09Z and sat at its prompt with no child
process in its own pane (the builds it coordinates run in other tmux
sessions). The ten-minute recent-work memory and the two-minute transcript
window expired, and at 18:14:11Z every probe read idle. No evidence was
missing and no probe misread. Ending an idle over-age session is the age
limit's job; the defect was the revival refusal.

The change:

- The age gate, which runs only on over-age sessions, records a session in
  `ageGateConfirmedWorkPastLimit` when its transcript was written within the
  last two minutes (`isTranscriptRecentlyActive`). That is the only sample
  counted as confirmed work. `#terminateLocalAgeExpiredSession` passes
  `seenWorkingPastAgeLimit: ageGateConfirmedWorkPastLimit.has(sessionId)`, and
  the chokepoint emits the flag on `sessionReaped` only for reason
  `age-limit`. The set is pruned for ended sessions and cleared at the kill.
- Uncertain samples still defer the kill exactly as before but never earn the
  flag: an empty or missing pane capture, a failed process probe (which
  returns "active" to stay safe), and a live child process (which can be an
  idle MCP server). Round 1 used the kill-deferral memory, which includes
  those; Astra found it (see Second-pass review).
- `server.ts` forwards the flag into the resume candidate.
- `ResumeQueue.considerEnqueue`: when the flag is set and a prior resume
  exists, the ledger restarts (`resurrections 0`, `windowStartAt now`,
  audited `resurrection-ledger-reset`) instead of counting this re-reap.

### Considered and dropped (Occam)

- **Count only re-reaps within N hours of the last resume.** Pressure reaps
  of an idle revived session can come hours apart (10:57 → 12:51 here); a
  time threshold would weaken the brake for exactly that loop.
- **Exempt every age-limit reap from the cap.** A revived session that sits
  idle for four hours and is age-killed would then be revived every four
  hours forever on a dirty agent home. The seen-working flag separates the
  two using a signal the age gate already keeps.
- **A new work-evidence token.** Evidence decides eligibility; this signal
  is about the loop brake, not about mid-work, so it rides as its own field.

## Decision-point inventory

- Resume queue resurrection cap (`considerEnqueue`): one new input. A flagged
  candidate restarts the ledger instead of incrementing it. No other gate
  changes.
- Age gate keep/kill decision: unchanged. The flag is read, never written,
  at the kill.

## 1. Over-block

No new block. The change only admits candidates the cap refused.

## 2. Under-block

The brake still stops fast kill→revive→kill loops: a flagged kill needs a
session at least `maxDurationMinutes` old (240 by default) whose transcript
was written after it passed that age. Probe failures and idle children never
earn it (tested for each). At most one ledger restart per topic per
such lifetime; between restarts the ≤2 cap applies (tested). A revived
session that only runs its resume turn at spawn is never over age at that
moment, so it cannot earn the flag. A session kept busy by repeated inbound
messages can be revived after each age kill, which is the intended outcome.
`maxResurrections: 0` still refuses every re-reap inside a fresh window
(the stale-window path is unchanged). The age gate's memory is in-process: a
server restart between the working sighting and the kill loses the flag, and
the old counting applies (errs toward no revival, never toward a loop).

## 3. Level-of-abstraction fit

The signal is produced where it is observable (the age gate's own memory)
and consumed by the component that owns the loop brake (the resume queue).

## 4. Signal vs authority compliance

- [x] No new block/allow surface. The age gate supplies a fact; the resume
  queue keeps the authority and all its other checks.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic. It reuses the age gate's existing transcript probe, the
one positive observation among its three probes.

## 5. Interactions

- **AutonomousLivenessReconciler** reads `resurrectionCountForTopic` to share
  the give-up bound. A reset lowers that count, which is consistent: the
  topic has shown it is not looping.
- **Drainer:** unchanged; drain-time checks (live session, stale UUID, owner
  elsewhere, run finished) still apply to the entry.
- **Boot reconciliation** builds candidates only for keys without a tombstone,
  so it never reaches the reset branch.
- **Gap-B / active-run reason tags:** independent; the flag rides alongside
  whichever reason the handler chose.

## 6. External surfaces

None. No routes, config keys or messages. One new audit event name in
`logs/resume-queue.jsonl` (`resurrection-ledger-reset`).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface. Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, like the age gate and the resume queue (one queue
per machine, `topic-owner-elsewhere` checked at drain).

## 7b. Constitutional Rules touched (Instar 2.0 `docs/01-the-rules.md`)

- **Rule 26 (verify the state):** the flag comes from an observed transcript
  write, not from a label or a fail-safe default.
- **Rules 68 / 97 (preserve live work, continuity):** a session that worked
  through its lifetime and still holds unfinished work is revived.
- **Rule 70 (bug evidence):** the replay tests fail without the fix.
- **Rule 74 (side effects):** this review.
- **Rule 116 (simplest robust route):** one per-session set, one boolean
  passed through three existing calls, one branch in the cap.
- **Safety floors:** spend stays bounded (above) and the fleet dry-run
  default is unchanged; no duplicate sends (drainer `live-session-exists`
  unchanged); stop is unchanged (operator kills never queue).

## 8. Rollback cost

Pure code change. Revert and ship a patch. The only persisted effect is a
tombstone count reset, which the next reap overwrites.

## Conclusion

The age limit ended an idle session correctly; the restart brake then
mistook a session that had worked five hours since its last revival for a
crash loop. The age gate already knew the difference, and now tells the
queue.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Concur with the review.** Verified: `ageGateLastWorkingAt` is keyed by the
per-spawn session id, written only in the over-age branch on a working
verdict, and read before its delete; the chokepoint emits the flag only for
`age-limit`; an idle revived session never earns it. Two notes, both now
stated in section 2: the `maxResurrections: 0` wording held only for a fresh
window, and a server restart loses the in-memory flag (safe direction).

### Astra round 1 — CHANGES REQUIRED → addressed

Must-fix: the flag read `ageGateLastWorkingAt`, which records any non-idle
sample, including a missing or empty pane capture and a failed process probe.
An idle session could earn a ledger reset from a probe failure. **Addressed:**
the flag now comes only from a transcript write past the limit
(`ageGateConfirmedWorkPastLimit`). Astra's repro cases (null pane, empty pane,
process-probe error) plus an idle child process are in the tests; each fails
on the round-1 code and passes now, through the real monitor tick and the
real ResumeQueue.

## Evidence pointers

- `tests/unit/resume-queue.test.ts` — "REPRO 52075", "NOT seen working ...
  still counts", "after a ledger restart ... capped again", "stale age-limit
  kill with no work evidence".
- `tests/unit/session-manager-terminate.test.ts` — "age gate R3 REPRO": a
  transcript write past the limit flags the kill and the real queue revives
  it after two earlier revivals; "age gate R3: an uncertain sample" (null
  pane, empty pane, process-probe error, idle child process): killed later,
  no flag, `resurrection-cap`. "age gate R2 REPRO" (live child only) and the
  stale-session test assert the flag is absent.
- `tests/integration/resume-idle-autonomous-wiring.test.ts` — real queue +
  drainer revive the flagged third age kill; server forwards the flag.

## Class-Closure Declaration (display-only mirror)

Adds one input to an existing self-triggered controller's loop brake.
Not an agent-authored-artifact defect; not applicable.
