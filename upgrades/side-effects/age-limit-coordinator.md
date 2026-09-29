# Side-Effects Review — the age limit no longer ends a session in the middle of its work

**Version / slug:** `age-limit-coordinator`
**Date:** `2026-09-29`
**Author:** `echo`
**Second-pass reviewer:** `required (session lifecycle: the age-limit kill path)`

## Summary of the change

The age gate in `SessionManager.#monitorTick` ends an over-age session as
`terminal` (reason `age-limit`) once `isAgeGateTrulyIdle` says it is idle. On
2026-09-29 09:32:49Z it ended the Instar 2.0 coordinating session
(`echo-deepseek-harness`, topic 52075, 920 minutes old) two seconds after its
last transcript write (server.log: "exceeded timeout (920m > 240m) and is
idle"; transcript event at 09:32:47.652Z). The session was mid-turn, just after
a background watch ended. All three probes missed it at that one sample:

1. `IDLE_PROMPT_PATTERNS` are status-bar strings. They are present mid-turn
   too (the stand-down drain path already documents this and pairs them with
   `paneShowsClaudeWorking`).
2. The watch shell had exited, so `hasActiveProcesses` was false.
3. `isTranscriptRecentlyActive` stats the transcript of
   `session.claudeSessionId`. A hook had rotated that at 09:29:27 to
   `fabecfc2…`, which has no transcript file anywhere. It was rotated back at
   09:32:48.906, after the tick had read the session record.

Earlier ticks (05:39, 07:46) had logged the session as over-age but working
(`procs=true`).

Two changes, both in the age gate only:

- `ageGateIsIdle` also requires that the mid-turn footer be absent
  (`paneShowsClaudeWorking` on a 30-line raw capture). The capture only runs
  when the 5-line tail already matched an idle pattern.
- `ageGateLastWorkingAt` records when the gate last saw each over-age session
  working. Within `AGE_GATE_RECENT_WORK_MS` (10 minutes) of that, the session is
  not truly idle (new optional 4th input to `isAgeGateTrulyIdle`). The entry is
  dropped when the age gate kills the session.

### Considered and dropped (Occam)

- **Make the age-limit kill of a topic-bound session a resume-queued restart
  (`midWork`).** The session was working, and the existing contract is
  already "defer the kill while working". The defect was the gate's blindness,
  not the disposition. A revival route would add a resurrection loop surface
  (bounded by the cap, but still new) for sessions that should never have been
  killed.
- **Fixing the claudeSessionId rotation itself.** That is a separate defect in
  `setClaudeSessionId`'s last-writer-wins (its comment assumes every hook
  event carries the main conversation id). Either change here covers the age
  gate without it. The rotation still affects other transcript consumers;
  noted for a follow-up, not widened into this fix.
- **A longer transcript window.** It would not help: the probe read the wrong
  file.

## Decision-point inventory

- Age gate idle decision (`isAgeGateTrulyIdle` and its inputs): modified, can
  only defer more. No other caller of `isAgeGateTrulyIdle` exists.

## 1. Over-block

- A genuinely stale over-age session is now age-killed up to 10 minutes later
  than before, measured from the last tick that saw it working. On a limit of
  240m + 48m this is negligible.
- The 30-line capture includes conversation text, not only the footer. A
  session whose last 30 lines contain the literal text "esc to interrupt" (for
  example output that quotes this diff) reads as working until that text
  scrolls away. Worst case is a deferred kill; the idle-detection block below
  the age gate is unchanged.
- A session stuck mid-turn, showing the footer with no child process, is no
  longer age-killed. Before, the footer sat outside the 5-line tail, so the
  age gate would kill it. The age gate is a lifetime recycle, not the recovery
  path for a hung turn; whether other monitors cover that case was not
  re-verified in this change.

## 2. Under-block

- A session seen working, and then actually finished, stays up to 10 more
  minutes. Accepted.
- A session that is working but where every probe is blind for more than 10
  minutes (no footer, no child process, wrong transcript id) is still killed.
  Nothing in this incident fits that shape.
- The map is not cleared for sessions that end some other way. That is one
  number per over-age session over the server's lifetime, the same lifecycle
  as the existing `overAgeButActiveLogged` set.

## 3. Level-of-abstraction fit

Both signals live in the age gate beside the probes they complement. The
footer signal is the canonical `claudeActivityIndicators` module already used
by the stand-down drain and injection paths. The ReapGuard and the terminate
authority are untouched.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface.

It only removes kill cases from an existing gate.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic at a competing-signals point. It is a safety guard on an
irreversible action: "seen working recently" resolves to keep.

## 5. Interactions

- **Shadowing:** the age-kill backoff and the KEEP-guard still run exactly as
  before when the gate says idle.
- **Idle-detection block:** unchanged; it has its own 15m / 4h (topic-bound)
  idle-prompt rules.
- **Races:** the footer capture is a separate tmux call from the 5-line tail; a
  turn starting between them reads as working (keep).
- **Cost:** one extra capture per over-age tick, and only when the prompt
  patterns matched. Over-age sessions are rare.

## 6. External surfaces

None. No routes, messages, config, or persisted schema. The "Deferring kill"
log line gains a `recentlyWorking=` field.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local: the age gate judges local panes. The new map is in-memory and
per process.

## 8. Rollback cost

Pure code change. Revert and ship a patch. No state to migrate.

## Conclusion

The age gate judged each over-age tick alone, and its idle-prompt check could
not tell a running turn from the prompt. It now reads the mid-turn footer and
remembers recent work for 10 minutes. Only keeps are added. Genuinely stale
sessions are still age-killed. Clear to ship after second-pass review.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (round 1)
**Independent read of the artifact: concur**

Concurred: the `await` inside `&&` only captures when the tail already matched
an idle pattern; `captureOutputMaybeAsync` may return null and
`paneShowsClaudeWorking(null)` is false (unreadable pane reads idle, as
before); kills are a subset of before, each delayed at most 10 minutes; the
KEEP-guard back-off is unchanged; the tests cover both sides of the memory.
Non-blocking notes, and what was done:

1. Conversation text in the 30-line capture that contains "esc to interrupt"
   reads as working. **Added to section 1.**
2. The claim that other monitors cover a session hung mid-turn was not
   verified. **Reworded in section 1** to say so plainly.

## Evidence pointers

- `tests/unit/session-manager-terminate.test.ts` → "age gate: a pane showing
  the mid-turn footer is working ⇒ not age-killed" and "age gate REPRO: seen
  working (background shell) then one quiet sample ⇒ kept; quiet past the
  grace ⇒ age-killed". Both fail on origin/main (verified by running them
  against the HEAD version of `SessionManager.ts`).
- `tests/unit/session-timeout-activity-aware.test.ts`: both sides of
  `recentlySeenWorking`; the source-shape test pins the four-input call.

## Class-Closure Declaration (display-only mirror)

Modifies a self-triggered controller (the age gate) only by removing kill
cases. Kills are a subset of before, each delayed by at most
`AGE_GATE_RECENT_WORK_MS` after the last working sample. No revive path is
added. No agent-authored-artifact defect; not applicable.
