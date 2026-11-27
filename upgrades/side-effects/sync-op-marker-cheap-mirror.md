# Side-Effects Review — the in-flight sync-op marker is mirrored once per burst

**Version / slug:** `sync-op-marker-cheap-mirror`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (one leaf module plus one line in the server's wake handler; a revert undoes it; no stored data, no config). 2 source files, 3 test files. No spec review rounds; one commit attempt expected.

`InFlightSyncOpMarker` rewrote its cross-process mirror file on every enter and leave of a synchronous subprocess call. A CPU profile of the Studio server on 2026-11-13 put about 11% of wall time there, against about 2% in the tmux spawns it brackets. That night the lifeline supervisor killed the unresponsive server four times, each time taking a running Local Verify with it. This is one contributor to that blocking, not the whole cause (CMT-1718 tracks the rest: other synchronous spawns, a synchronous directory walk, fsync-heavy state writes, and the supervisor's cleanup of a live verify child).

Change: the file is written synchronously on a 0 to 1 depth transition unless it already says in-flight with a stamp at most TTL/4 old; nested enters write nothing; the idle state is written once from a `setImmediate` when depth is still 0 (`flushSyncOpMirror`); mkdir happens once. The server's wake handler calls `flushSyncOpMirror()` before reading the file.

## Decision-point inventory

- `ServerSupervisor.deferRestartForInflightSyncOp` (reads the file): unchanged code; its input can now read in-flight for longer after the last op (see 1).
- Wake handler marker short-circuit in `server.ts`: now flushes before reading; its decision is otherwise unchanged.
- `SleepWakeDetector` (in-memory `readSyncOpMarker`): unchanged.

## 1. Over-block

The file's meaning changes: it now says in-flight for the rest of the loop turn in which a marked op ran, not only while the op runs. The supervisor's in-flight deferral therefore applies in two cases where it did not before:

- **An unmarked hang right after an op.** The file reads in-flight until its stamp passes the TTL (18 s by default), then stale. A hung server is deferred up to about 18 s longer.
- **A turn that never yields but keeps starting marked ops.** Each re-stamp keeps the file fresh, so the supervisor defers on every check until its own hard cap (`starvationRestartThreshold`, about 5 minutes) where it used to defer only on the checks that landed inside an op (about 1 minute to a restart in practice). The turn is still starting subprocess ops (most of its time may be unmarked JS, with a marked op at least every 18 s); that is close to the class the deferral exists for, and it is accepted deliberately. The hard cap is unchanged.

The second case changes supervisor kill behaviour on a busy server independently of the CPU saving, so a before/after count of freeze kills cannot be credited to the saved writes alone.

## 2. Under-block

No issue identified for the marker's purpose: the in-flight write still happens before the op blocks the loop, so the file can never say idle during a marked op (a skipped write means it already says in-flight). An older on-disk stamp makes the reader call the marker stale sooner, which is its fail-open side. Not addressed here: the other sources of main-thread blocking listed in the summary.

## 3. Level-of-abstraction fit

The fix is inside the single funnel every synchronous call already goes through, so all callers benefit without touching 60 call sites. Making the tmux reads asynchronous or batched is the larger fix at the caller layer and stays in CMT-1718.

## 4. Signal vs authority compliance

The marker is a signal; the supervisor is the authority and its logic is untouched. The signal stays fail-open: missing, unparseable or stale reads never defer. The one widening (section 1) is bounded by the existing TTL.

## 4b. Judgment-point check

Not applicable: no judgment call is replaced by a rule.

## 5. Interactions

- TTL self-heal paths (`enter`, `readSyncOpMarker`) still call `mirror()` where they did.
- `configureSyncOpMarker({stateDir})` resets the writer's record of the file, so a new location is written on the next op.
- A failed write leaves the writer's record unchanged, so the next 0 to 1 transition tries again.
- Tests that asserted the file is idle immediately after an op now flush first; this matches the real consumers (the supervisor is another process and never observes the same tick; the in-process handler flushes).

## 6. External surfaces

Same file, same JSON shape. No route, message or config change.

## 7. Multi-machine posture

Machine-local by design: the file describes this server process's event loop to this machine's lifeline.

## 8. Rollback cost

Revert the commit. Old and new writers and readers are compatible in any mix.

## Conclusion

Removes two file writes per synchronous tmux call from the server's main thread at the cost of a bounded, fail-open-side widening of one signal. Ship, and continue CMT-1718.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, given the diff and the incident), 2026-11-13
**Independent read of the artifact: concur** (second pass, after a first pass that raised a concern)

First pass, concern raised: the stated bound ("about 18 s longer") was wrong for a turn that never yields but keeps starting marked ops; there the supervisor now defers to its 5-minute hard cap. Also: a backward clock step could leave a future-dated stamp that is never rewritten; a doc comment claimed a shutdown caller that does not exist. Sound as found: failure paths of the mirror write, the wake handler's flush (necessary and sufficient; no other in-process reader of the file), crash with the file left in-flight (process gone restarts before the marker is read).

Applied: the behaviour is now stated in the code, this artifact, the release note and the overview, and pinned by a unit test; `fresh` requires a non-negative age, with a test; the doc comment is corrected.

Second pass: **concur**. "Accepting consequence 1 is not wrong. The hard cap still bounds it, and the supervisor keeps authority." Wording caveat applied in section 1. Named as untested: a failed idle flush, reconfigure between leave and flush; the wake-handler assertion is a source regex only.

## Evidence pointers

- 60 s inspector CPU profile with caller chains, Studio server, 2026-11-13 00:20 PST (rows `writeFileUtf8`/`rename <- mirror core/InFlightSyncOpMarker.js <- tmuxSessionExists <- isSessionAlive <- checkSession monitoring/SessionMonitor.js`).
- `logs/server-freeze/freeze-*.txt` on the Studio (stack samples and profiles during stalls).
- Lifeline log lines "Server process alive but unresponsive for 6 checks (~60s) — restarting", 2026-11-12/13.
- Tests named in the release note.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a performance defect in server code; the new unit tests pin the write count per burst).
