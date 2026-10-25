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
(`procs=true`; that line is logged once per session, so it does not show later
ticks). The session's own transcript shows the background watch it was waiting
on (task `b584xsjlb`) started at 09:17:36Z and reported done at 09:32:38Z,
eleven seconds before the kill. A Claude Code background shell is a descendant
of the pane, so `hasActiveProcesses` reads true while it runs; with 5-second
ticks the gate saw the session working until about 09:32:38Z.

One change, in the age gate only:

- `ageGateLastWorkingAt` records when the gate last saw each over-age session
  working (from the three existing probes). Within `AGE_GATE_RECENT_WORK_MS`
  (10 minutes) of that, the session is not truly idle (new optional 4th input
  to `isAgeGateTrulyIdle`). Each monitor tick drops entries for sessions that
  are no longer running, whatever ended them.

Round 1 also read Claude Code's mid-turn footer ("esc to interrupt") from a
30-line capture. Review showed that capture includes history, so quoted footer
text on an idle pane renewed the memory every tick and the session was never
age-killed. That signal is removed: the memory alone covers this incident
(last working sample about 11 seconds before the kill), and it renews only on
the existing probes.

### Considered and dropped (Occam)

- **Make the age-limit kill of a topic-bound session a resume-queued restart
  (`midWork`).** The session was working, and the existing contract is
  already "defer the kill while working". The defect was the gate's blindness,
  not the disposition. A revival route would add a resurrection loop surface
  (bounded by the cap, but still new) for sessions that should never have been
  killed.
- **Fixing the claudeSessionId rotation itself.** That is a separate defect in
  `setClaudeSessionId`'s last-writer-wins (its comment assumes every hook
  event carries the main conversation id). The recent-work memory covers the age
  gate without it. The rotation still affects other transcript consumers;
  noted for a follow-up, not widened into this fix.
- **A longer transcript window.** It would not help: the probe read the wrong
  file.

## Decision-point inventory

- Age gate idle decision (`isAgeGateTrulyIdle` and its inputs): modified, can
  only defer more. No other caller of `isAgeGateTrulyIdle` exists.

## 1. Over-block

- A genuinely stale over-age session is now age-killed up to 10 minutes later
  than before, measured from the last tick where a probe read working. On a
  limit of 240m + 48m this is negligible. The memory renews on every sample
  the pre-existing three-probe decision reads non-idle, including its
  conservative pane cases: a tail with no `IDLE_PROMPT_PATTERNS` match, or an
  empty/unreadable tail, renews it even with no child process and no
  transcript activity. Such a sample already deferred the kill before this
  change, so anything the old decision kept (a stuck child process, a pane
  that never shows the idle prompt) is kept exactly as before, no longer and
  no shorter. Ten minutes is the memory's expiry after the last non-idle
  sample; termination then happens on a later eligible tick, subject to the
  unchanged KEEP guards and backoff. It is not an unconditional bound after
  work actually stops.

## 2. Under-block

- A session seen working, and then actually finished, stays up to 10 more
  minutes. Accepted.
- A session that is working but where every probe is blind for more than 10
  minutes (no child process, idle-looking status bar, wrong transcript id) is
  still killed. A turn that thinks for over 10 minutes with no tool running,
  right after the claudeSessionId rotation, would fit; this incident did not
  (blind for about 11 seconds). The rotation is the upstream defect and is not
  repaired here.
- Map lifetime: entries are pruned every tick against the running-session
  snapshot, so the map holds at most one number per running over-age session.

## 3. Level-of-abstraction fit

The memory lives in the age gate beside the probes it smooths, and is pruned
beside the monitor's existing per-tick sweeps (permission-prompt resolver,
startup tails). The ReapGuard and the terminate authority are untouched.

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
- **Cost:** one map read/write per over-age tick and one pass over the (small)
  map per tick. No extra tmux calls.

## 6. External surfaces

None. No routes, messages, config, or persisted schema. The "Deferring kill"
log line gains a `recentlyWorking=` field.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local: the age gate judges local panes. The new map is in-memory and
per process, keyed by the session's incarnation id.

## 7b. Constitutional Rules touched (Instar 2.0 `docs/01-the-rules.md`)

- **Rule 26 (verify the state, not its symbol):** no new symbol is trusted.
  The memory renews whenever the existing three-probe decision reads
  non-idle, including its conservative pane/unknown cases (no idle-prompt
  match, empty or unreadable tail). The round-1 quoted-footer exemption,
  which added a new text signal, is removed. Inherited limitation, stated
  honestly: the pane classifier and the process probe are imperfect
  evidence, and the claudeSessionId rotation is unrepaired; the memory only
  bridges their brief blind samples.
- **Rule 60 (bounded resources):** `ageGateLastWorkingAt` is pruned every
  monitor tick to the running-session set; its size is bounded by running
  over-age sessions. A lifecycle test proves an ended session's entry is
  removed while a running session keeps its grace.
- **Rules 68 / 97 (preserve live work, continuity):** one blind sample right
  after real work can no longer terminal-kill the session; the incident replay
  test shows the keep.
- **Rules 32 / 113 (machine-local ephemeral state, authority unchanged):** the
  memory is in-process, not persisted or shared; reap authority, the
  KEEP-guard and termination routing are unchanged.
- **Rule 49 (traceability):** the incident timeline is tied to server.log
  lines and transcript events, and each test names the commit it fails on.
- **Rule 70 (bug evidence):** the incident replay test fails on origin/main
  and passes here; the reconstructed last working sample is labelled as
  reconstructed from process lifetime and tick cadence.
- **Rule 74 (side effects):** this review; its renewal description was
  corrected in round 3 after Astra's counterexample.
- **Rule 111 (the layer below):** the probes and the terminate authority are
  used as they are; their limits are recorded above, not papered over.
- **Rule 116 (simplest robust route):** one small per-session map beside the
  existing probes, pruned by the existing running-session snapshot; no new
  classifier, parser or revival route.

## 8. Rollback cost

Pure code change. Revert and ship a patch. No state to migrate.

## Conclusion

The age gate judged each over-age tick alone, so one blind sample right after
real work killed a working session. It now remembers recent work for 10
minutes, renewed whenever the existing three-probe decision reads non-idle,
and forgets sessions once they end. Only keeps are added. Sessions the
existing decision reads as idle for 10 minutes are still age-killed (subject
to the unchanged KEEP guards/backoff); the round-1 quoted-footer exemption is
gone. Clear to ship after review.

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
   reads as working. **Added to section 1 in round 1; superseded in round 2**
   (Astra showed it renews forever; the footer signal is removed).
2. The claim that other monitors cover a session hung mid-turn was not
   verified. **Moot in round 2**: without the footer signal, a hung turn with
   no child process is age-killed as before.

## Round 2 review (Astra, CHANGES REQUIRED → repaired)

1. Quoted/historical footer text renewed the exemption forever. **Footer
   signal removed**; contrasting monitor test added.
2. The map leaked ended sessions. **Pruned every tick** against the running
   snapshot; lifecycle test added.
3. Rule mapping. **Section 7b.**

## Round 3 review (Astra round 2, CHANGES REQUIRED → docs corrected)

1. The docs claimed only processes/transcript writes renew the memory and
   pane text cannot. False: renewal is the negation of the original
   three-input idle decision, so a non-idle pane tail (or an empty/unreadable
   one) renews it. **Corrected** in section 1, section 7b, the conclusion,
   the upgrade note and the ELI16. No code change.

The round-1 claims "at most ten minutes" and "either change alone would have
saved it" are corrected above: the ten minutes is the memory's expiry after
the last non-idle sample (see section 1), and the incident is covered by the
memory, backed by the transcript's watch timing.

## Evidence pointers

- `tests/unit/session-manager-terminate.test.ts`:
  - "age gate REPRO: seen working (background shell) then one quiet sample ⇒
    kept; quiet past the grace ⇒ age-killed" — fails on origin/main.
  - "age gate: quoted "esc to interrupt" left on an idle pane does not keep it
    alive ⇒ age-killed" — fails on the round-1 commit (02dcf1087).
  - "age gate: work memory is dropped for an ended session and kept for a
    running one" — fails on the round-1 commit.
- `tests/unit/session-timeout-activity-aware.test.ts`: both sides of
  `recentlySeenWorking`; the source-shape test pins the four-input call.

## Class-Closure Declaration (display-only mirror)

Modifies a self-triggered controller (the age gate) only by removing kill
cases. Kills are a subset of before; the memory expires
`AGE_GATE_RECENT_WORK_MS` after the last sample the existing three-probe
decision read as non-idle, and a later eligible tick then decides as before.
No revive path is added. No agent-authored-artifact defect; not applicable.
