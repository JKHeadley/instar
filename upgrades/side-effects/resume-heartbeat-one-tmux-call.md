# Side-Effects Review — the resume heartbeat reads every session's pane with one tmux call

**Version / slug:** `resume-heartbeat-one-tmux-call`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (one method in one module; a revert undoes it; no stored data or config changes). 1 source file, 7 test files (fakes updated, 8 new unit cases, one real-tmux case). No spec review rounds; independent review of the code (the first read raised a real defect, fixed).

`TopicResumeMap.refreshResumeMappings()` ran one synchronous `tmux display-message` per topic session every 60 seconds (about 40 on the Studio, about 165 ms in total on a quiet machine, and the largest synchronous spawn source in a profile of the loaded server). It now runs one `tmux list-sessions` with the same pane formats (4 to 5 ms) and looks each session up by exact name.

Fourth part of CMT-1718. Still open there: the session monitor's per-session liveness spawns, and the supervisor's cleanup of a live verify child.

## Decision-point inventory

- Which sessions the heartbeat may write a resume mapping for: same rule (active pane exists and is not dead), read from one call. No other decision is touched; the writer gate, the transcript check and the pruning block are unchanged.

## 1. Over-block

- A failure of the one call makes every session read as not live for that tick, where a failed per-session call affected only that session. The consequence is the same in kind and bounded: that tick writes nothing; every existing mapping is kept (the pruning block runs only after a write, and only removes entries older than 24 hours that are not active). The next tick, a minute later, reads again.

## 2. Under-block

- The remaining call is still synchronous on the main thread.
- A session name with non-ASCII characters, on a server whose environment has neither `TMUX` nor a UTF-8 locale: tmux prints such a name with `_` in place of those characters, so it would not match and that session would read as not live. The per-session probe matched by argument and was immune. Instar's session names are ASCII slugs; if that changes, pass `-u` to tmux here.
- A session that disappears between the list and the write is treated as live for that tick, as it was between its own probe and the write before.

## 3. Level-of-abstraction fit

The read stays inside `TopicResumeMap`, next to its only user. `SessionLivenessOracle` already offers a cached list-sessions snapshot for existence, but it does not carry `pane_dead`, which this rule needs; using it here would have meant widening a shared component for one caller.

## 4. Signal vs authority compliance

Not a new decision point. The liveness read feeds the same writer with the same rule.

## 4b. Judgment-point check

Not applicable.

## 5. Interactions

- `withSyncOp` still brackets the call, so the supervisor's in-flight marker behaves as before, once per tick in place of once per session.
- Session names are matched exactly, as `-t =<name>` did.
- Sessions on another tmux socket are invisible to both forms.
- **Output shape depends on the tmux client's environment.** A tab (or any non-printable) separator is replaced with `_` by a tmux client that is not flagged UTF-8. The format therefore uses `||`, and a real-tmux test runs the read under `env -i` (keeping `PATH` and `TMUX_TMPDIR`, so it still finds the test lane's own tmux socket). The same hazard exists today in `SessionManager.sweepDeadJobPanes` (`'#{session_name}\t#{pane_dead}'`), which in such an environment would find no dead panes; filed separately, not changed here.

## 6. External surfaces

None. The resume map file and its contents are unchanged.

## 7. Multi-machine posture

Machine-local by design and unchanged: each machine's heartbeat reads its own tmux server and writes its own resume map.

## 8. Rollback cost

Revert the commit.

## Conclusion

Replaces about 40 synchronous subprocess spawns a minute with one, with the same liveness rule. Ship, and continue CMT-1718.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only, with read-only access to the live tmux server; given the code and the questions, not the conclusion).

**Round 1: Concern raised.** One real defect: the first version separated the fields with a tab. A tmux client with neither `TMUX` nor a UTF-8 locale in its environment replaces non-printable characters in its output with `_`, so on a server started outside tmux every session would have read as not live, every tick, with exit code 0 and no log line. My own 41-session comparison could not show it because it ran inside tmux. Fixed: the separator is the printable `||` the old probe used, lines are read from the right, and output that cannot be read is reported once. Also applied: a real-tmux test under a bare environment; the shared fake now requires its list of live sessions; cases for a non-zero exit with readable output, an empty dead flag and a name containing the separator; a stale test title. The reviewer confirmed the failure direction is safe (an empty answer returns before the pruning block) and found no other caller of the old probe.

**Round 2: Concern raised, one item.** The source fix verified against the real tmux in four environments (40 sessions, 0 differences) and the parse held on every edge tried. The new bare-environment test stripped `TMUX_TMPDIR` as well, so inside a test lane it would have looked for the tmux server on the wrong socket and failed; the wrapper now carries that one variable through. Wording nits in the release note corrected, and the right-to-left search no longer overlaps the two separators.

**Round 3: Concur.** The generated wrapper text verified (only `PATH` when `TMUX_TMPDIR` is unset; both when it is set, including a path with a space), the parse table re-run with no change in any live or not-live outcome, no remaining findings. The reviewer noted that its multi-window equivalence was by reasoning only, since the live server had no such session; I then checked it on a throwaway tmux server (a session with three windows, the current one with two panes, plus a dead-pane session): `list-sessions` and `display-message -t =name:` gave the same pane id and dead flag for each session, the active pane of the current window.

**Reviewer concurred:** yes (round 3).

