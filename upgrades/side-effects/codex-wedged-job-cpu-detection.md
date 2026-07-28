# Side-Effects Review — Codex wedged-job CPU-stall detection

**Version / slug:** `codex-wedged-job-cpu-detection`
**Date:** `2026-06-03`
**Author:** `Echo`
**Second-pass reviewer:** `Echo (self) — Tier-1; the regression analysis below is the load-bearing part`

## Summary of the change

StaleSessionBackstop's `hasForwardProgress` gains a CPU-delta progress signal for
**job sessions**, replacing the existence-based `mainProcessActive` check for them.
A wedged-but-alive codex job (0% CPU) now reads as no-progress and triggers the
existing attention escalation (never a kill). Files: `SessionManager.ts`
(`descendantCpuSeconds` + `parseProcTimeToSeconds`), `StaleSessionBackstop.ts`
(ProgressSnapshot fields `descendantCpuSeconds`/`isJobSession`, the job-scoped
`hasForwardProgress` branch, `cpuFloorSeconds` option), `server.ts` (snapshot
populates the two fields). The only decision point: *is this session making forward
progress* — and the change narrows what counts as progress for jobs.

## Decision-point inventory

- `StaleSessionBackstop.hasForwardProgress` (ii) — modify — for job sessions, require
  cpu-seconds delta > floor instead of process existence.
- No message block/allow surface. No kill/terminate surface (the backstop has none —
  asserted by an existing structural test).

## 1. Over-block

No block/allow surface. The analogue ("does it raise a false attention notice?") is
THE risk and is handled by scoping: the stricter cpu-delta test applies ONLY to job
sessions (`!!session.jobSlug`). A conversational session that's legitimately idle
with a background process keeps the existence-based check → not flagged. Verified by
the `conversational-idle-with-bg → no` test.

## 2. Under-block

A job that uses *some* CPU between two 120s snapshots (above `cpuFloorSeconds=1`) is
treated as progressing — so a job that's busy-looping (high CPU, no real output)
would not be flagged by this signal. That's acceptable: this targets the 0%-CPU
freeze; a CPU-burning runaway is a different detector's concern (and would show on
load). I/O-bound jobs at 0% CPU with no output would be flagged — but a job has no
legitimate long idle-wait state (it runs to completion), so flagging it for attention
(not killing) is correct.

## 3. Level-of-abstraction fit

Correct layer. This is a cheap, deterministic process-metric read feeding an existing
attention-raising backstop. It reuses `hasActiveProcesses`'s exact descendant
tree-walk + baseline filter, adding only the CPU-time accumulation. No LLM needed —
the signal is objective (CPU seconds), and the escalation it feeds is attention-only.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no message block/allow surface.

It refines a SIGNAL (forward-progress) consumed by an existing smart-ish gate
(the backstop's episode state machine), which only ever raises an attention item and
never kills. No new authority.

## 5. Interactions

- **Shadowing:** The change is inside `hasForwardProgress`, one branch (ii). Branches
  (i) transcript-growth and (iii) idle-token-change are unchanged and still short-
  circuit to "progress" first, so a job that IS producing output/transcript is still
  exempt before the CPU test is consulted.
- **Double-fire:** None — same single escalation path, same per-episode dedup
  (`episodeActive`), so a persistently-wedged job still raises exactly one item.
- **Races:** `descendantCpuSeconds` is a synchronous `ps` read per snapshot, same
  cadence/shape as the existing `hasActiveProcesses` call; no shared mutable state.
- **Feedback loops:** None — the output is an attention notice, which does not feed
  back into the session.

## 6. External surfaces

- **Persistent state:** none new. ProgressSnapshot lives in memory per tick.
- **External systems:** none (the attention item uses the existing poster).
- **Other agents/users:** none — per-agent backstop.
- **`ps` cost:** one extra `ps -eo pid,ppid,time,command` per session per 120s tick —
  negligible, same class as the existing `hasActiveProcesses` `ps`.
- **Cross-platform:** `parseProcTimeToSeconds` handles the `ps -o time` formats
  (`MM:SS`, `MM:SS.ss`, `HH:MM:SS`, `DD-HH:MM:SS`); a bad parse reads as 0 (no growth),
  which is safe (the delta just shows no progress; attention, never kill).

## 7. Rollback cost

Pure code change; no persistent state, no migration. Back-out is `git revert` + ship
the next patch — the backstop reverts to existence-based progress (the prior, looser
behavior). No user-visible regression during rollback (it only changes whether a
*job* gets a stale-attention notice). Worst case if the floor is mis-tuned: a busy
job flagged spuriously (attention only) or a wedged job missed — both are
attention-level, never destructive.

## Conclusion

The review's central risk — falsely flagging legitimately-idle sessions — is closed
by scoping the cpu-delta requirement to job sessions (no legitimate-idle state) and
leaving conversational sessions on the existing existence check. That scoping is the
load-bearing design decision and is directly tested. The escalation remains
attention-only (never a kill), and the change reuses the existing process-walk. Clear
to ship.

## Second-pass review (if required)

**Reviewer:** Echo (self) — Tier-1.
**Independent read of the artifact: concur**

The job-scoping is the right way to avoid the idle-with-bg false-positive; the three
behavior tests pin both the fix and the no-regression case; rollback is a revert.
No concerns.

## Evidence pointers

- `tests/unit/stale-session-backstop.test.ts` (13: incl. the 3 new behavior cases),
  `tests/unit/parseProcTimeToSeconds.test.ts` (6). `tsc` + `pnpm build` clean.
- Root-cause + design trail: `.instar/autonomous/13435.local.md` item 2 (the iterative
  diagnosis that caught the idle-with-bg / extended-think regression traps).
