# Side-Effects Review — WorktreeMonitor single-flight scans

**Version / slug:** `worktree-monitor-single-flight`
**Date:** `2026-11-17`
**Author:** `echo (machine stewardship, topic 144503)`
**Second-pass reviewer:** `not required (Tier 1: no block/allow surface, no deletion, revert-only rollback)`

## Summary of the change

`src/monitoring/WorktreeMonitor.ts`: `scanWorktrees()` becomes single-flight. While a scan is running, further calls (the 5-minute periodic timer, `onSessionComplete`) receive the in-flight scan's promise instead of starting a second scan; the slot is cleared in `finally`, so the next call after settle (success or failure) scans fresh. The scan body moves unchanged into a private `runScan()`. Tests: two new cases in `tests/unit/worktree-monitor.test.ts` (overlapping callers share one report; a failed scan does not block the next). Measured motivation: on the Mac Studio (345 worktrees, load 40+ on 16 cores) about three scans overlapped per server, and git `rev-list`/`diff main...branch` bursts used about 146% CPU (2026-11-18 00:43-00:49Z). Tier 1. Size: 2 files, about 40 lines. Effort: one review round, first commit attempt.

## Decision-point inventory

- `WorktreeMonitor.scanWorktrees` — modify — whether to start a scan or join the running one. Not a block/allow decision.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The only thing "refused" is a duplicate scan; its caller still gets a complete report.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Residual cost: a single scan is still O(worktrees) git calls; this change stops the pile-up, not the per-scan cost. The large-home cost (worktree count) is handled by the worktree reaper and the stewardship work, not here.

---

## 3. Level-of-abstraction fit

Right layer: the de-duplication sits on the one method every trigger calls, so no caller needs to know about concurrency. A lower-level primitive (a generic single-flight helper) would be equally fine; the inline form is 8 lines and keeps the change local.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The monitor reports worktree state; this only changes how often it computes it.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Join the running scan" is an invariant (two concurrent identical read-only scans give no more information than one).

---

## 5. Interactions

- **Shadowing:** none; the post-session alert and periodic alert both still receive a full report.
- **Double-fire:** reduced. Before, a session end during a periodic scan produced two scans and could produce two alert evaluations from near-identical reports; now both callers evaluate the same report. Alert de-duplication (`isAnnounceDue`) already prevents repeated announcements, so no message changes.
- **Races:** the slot is per-instance; `finally` only clears it when it still holds the same promise.
- **Feedback loops:** none.

---

## 6. External surfaces

- Other agents on the same machine: less git CPU on shared machines.
- Install base: same reports and alerts, fewer git processes.
- External systems: none. Persistent state: unchanged (`last-report.json` written by the same callers).
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no dashboard, approval page or form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — each machine scans its own checkouts; worktrees are per-machine files. No user-facing notices change, no durable state is added, no URLs. Status surfaces: none new or changed.

---

## 7b. Found in Local Verify: callers sharing a scan all announced

Local Verify (Studio, 05:18Z) failed `tests/e2e/worktree-monitor-announce-lifecycle.test.ts`. The cause: with single-flight, ten overlapping `onSessionComplete` callers resumed from the same scan in one tick. Each checked `isAnnounceDue` before any of them reached `markAnnounced` (which runs after `await sendAlert`), so ten notices went out instead of one. Fixed in `onSessionComplete`:
- each caller gets its own copy of the shared report, so actions do not mix;
- the announce decision runs one caller at a time (`announceChain`), so later callers see the earlier `markAnnounced`.

New unit test: ten concurrent session ends give exactly one alert. It fails on the previous head (10 alerts) and passes now.

## 8. Rollback cost

- **Hot-fix release:** revert the commit; nothing else to undo.
- **Data migration:** none.
- **Agent state repair:** none.
- **User visibility during rollback:** none.

## Conclusion

Safe Tier-1 load fix: no authority, no persistence, no external surface; measured overlap on a real machine motivates it, and tests cover both the shared and the post-failure paths.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `ps -Ao ppid,command | grep 'git (diff --name-only|rev-list --count)'` on the Studio at 2026-11-18 00:43Z: 3 concurrent per server (pids 94872 and 29165).
- `tests/unit/worktree-monitor.test.ts`: 33 passed locally (incl. the concurrent-burst case, which fails on 92115afdb with 10 alerts).
