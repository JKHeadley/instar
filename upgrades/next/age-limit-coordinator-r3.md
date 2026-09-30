# A session that worked past its age limit is revived after the age kill

## What Changed

On 2026-09-30 at 18:14:11Z the age gate ended the Instar 2.0 coordinating
session (topic 52075) as `terminal`, `midWork:true`,
`workEvidence:["uncommitted-worktree-work"]`. The resume queue refused it with
`resurrection-cap` (resurrections 2): idle reaps at 10:57Z and 12:51Z had both
been revived inside the same 24-hour window. The revived session had then
worked for five hours. The age-limit and idle paths were already consistent
on eligibility; the cap was the only difference.

The age gate's #2092 exemption was correct here. The session's transcript
ends its last turn at 18:02:09Z, with nothing running in its own pane (its
builds run in other tmux sessions). The ten-minute recent-work memory and the
two-minute transcript window both expired before 18:14:11Z.

- `SessionManager` passes `seenWorkingPastAgeLimit` on the `sessionReaped`
  event of an age-limit kill when the age gate saw the session working after
  it passed its age limit (`ageGateLastWorkingAt` holds it).
- `server.ts` forwards it to `ResumeQueue.considerEnqueue`.
- `ResumeQueue` treats such a re-reap as proof there is no kill loop: the
  topic's resurrection ledger restarts at zero (audited as
  `resurrection-ledger-reset`) and the candidate is queued. Every other gate
  (evidence, operator veto, dedupe, drain-time checks, dry-run) is unchanged,
  and later quick re-reaps are counted and capped as before.

## Evidence

- `tests/unit/resume-queue.test.ts`: the incident replay (two idle-reap
  revivals, then an age kill seen working past its limit) is queued and
  resets the ledger; the same age kill without the flag is capped; after a
  reset, quick re-reaps are capped again; an age kill with no work evidence
  is never queued. The replay and the reset test fail without the fix.
- `tests/unit/session-manager-terminate.test.ts`: through the real monitor
  tick, an age kill of a session seen working past its limit carries
  `seenWorkingPastAgeLimit:true`; a stale session's kill does not. Fails
  without the fix.
- `tests/integration/resume-idle-autonomous-wiring.test.ts`: the real queue
  and drainer revive the third, flagged age kill with no cap notice; the
  server forwards the flag.

## What to Tell Your User

If one of my long-running sessions is restarted, keeps working for hours,
and is then ended for age with work still unfinished, it now comes back on
its own instead of waiting for you to message it.

## Summary of New Capabilities

- The restart queue's repeat-restart brake no longer counts a session that
  lived and worked through its whole age limit as one that keeps dying.
