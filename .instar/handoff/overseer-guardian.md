[HANDOFF] Guardian Category Overseer — 2026-05-16T07:10Z

## Executive Summary

Guardian cluster **healthy overall** — 96.7% avg success rate, 0 consecutive failures, 0 skips, all 5 jobs enabled. One new issue: state-integrity-check 01:00 UTC run is stuck as a pending zombie (machine sleep likely). sqlite3 is still Day 33+ unresolved with 9 active degradations. Gate failures from last cycle are fully resolved.

---

## Current Job Health (24h ending 2026-05-16T07:10Z)

| Job | Runs | Success Rate | Avg Duration | Status |
|-----|------|-------------|--------------|--------|
| health-check | 90 | 100% | 30s | ✅ Fully healthy |
| degradation-digest | 6 | 83.3% | 245s | ⚠️ 1 timeout (machine sleep) |
| state-integrity-check | 2 | 100% (of completed) | 46s | 🟡 1 zombie pending run at 01:00 UTC |
| guardian-pulse | 3 | 100% | 42s | ✅ Healthy |
| session-continuity-check | 6 | 100% | 56s | ✅ Healthy |

---

## Issue #1: sqlite3/better-sqlite3 Rebuild — 🔴 HIGH (Day 33+, STILL UNRESOLVED)

9 active degradations, unchanged from last 3 cycles:
- iMessage unavailable
- Session summaries disabled (context limited to last 20 raw messages)
- Knowledge graph offline (semantic search, entity-relationship queries disabled)
- Feature discovery state not persisted
- Layer 2 durable queue disabled
- Conflict auto-resolution degraded
- StuckInputSentinel: 2 auto-recovered instances (server up 3h 45m — accumulating at expected rate)

Fix: `npm rebuild better-sqlite3` in instar source dir. Unchanged across every overseer cycle.

---

## Issue #2: state-integrity-check Zombie Run — 🟡 NEW

The 01:00:00 UTC run (runId: `state-integrity-check-mp7n2y0a-7`) has been stuck as "pending" for 6+ hours with no completedAt in the ledger. Most likely cause: machine went to sleep shortly after launch (consistent with the degradation-digest sleep-reap at 23:02 UTC the prior night), but this run was not reaped — only logged as pending with no outcome.

The following run at 07:02 UTC succeeded in 107s, so the job is not blocked. The zombie run just pollutes the run history.

Next overseer: check if this entry was eventually resolved or is still hanging as "pending."

---

## Issue #3: health-check Blind to Server Degradations — 🟡 MEDIUM (PERSISTENT, 3+ CYCLES)

health-check runs every 15 minutes at 100% success rate, yet the server is degraded with 9 active issues. health-check validates HTTP liveness only — it does not read `/health` degradation count. No guardian job surfaces degradation state to the user.

Cross-job contradiction: health-check says "healthy," but server is degraded. This has been flagged for 3+ cycles with no fix.

---

## Issue #4: degradation-digest Machine Sleep Timeout — 🟡 LOW (Isolated)

Run at 2026-05-15T23:02 UTC timed out with "Reaped on wake — sleep gap of 649s exceeded 2min × 2 threshold." Machine sleep event. Not recurring — next 3 runs succeeded. No action needed unless pattern continues.

---

## Issue Resolved: Gate Failures ✅

Last cycle reported 40+ gate failures for ci-monitor, evolution-proposal-evaluate, insight-harvest, and others. Current cycle: **0 gate failures** in last 200 ledger entries. Fully resolved.

---

## state-integrity-check Duration Trend

Recent successful runs (from ledger):
```
2026-05-13 19:01  73s
2026-05-14 01:00  115s
2026-05-14 07:00  17s   <- outlier low
2026-05-14 13:00  148s
2026-05-15 00:58  20s   <- outlier low
2026-05-15 01:00  18s
2026-05-15 07:02  54s
2026-05-15 13:00  53s
2026-05-15 19:01  39s
2026-05-16 07:02  107s  <- latest
```

Duration is volatile but not monotonically increasing. The 174s peak from two cycles ago (May 12) has not recurred. The current range (17s-148s excluding that peak) suggests variable workload rather than structural growth. Monitor for another spike above 150s.

---

## Cross-Job Coherence

| Claim | Source | Cross-check | Verdict |
|-------|--------|-------------|---------|
| "System healthy" | health-check (100% success) | Server degraded (9 issues) | ❌ Persistent contradiction |
| "No failures" | guardian-pulse, session-continuity | Both 100% success | ✅ Consistent |
| "1 degradation-digest failure" | category API (83.3%) | Ledger: 1 sleep-reap timeout | ✅ Consistent |
| "Gate failures resolved" | 0 gate failures in ledger | Was 40+ last cycle | ✅ Resolved |
| "StuckInputSentinel accumulating" | health endpoint (2 auto-recovered) | Server up 3h45m, rate normal | ✅ Expected |

---

## API Handoff Disconnect (PERSISTENT, KNOWN)

`lastHandoff: null` for all 5 guardian jobs via the API. Actual handoffs stored at `.instar/handoff/overseer-guardian.md`. The `/jobs/<slug>/handoff` endpoint 404s — this is a known API gap, not a real issue.

---

## Model Allocation

All 5 jobs on haiku — appropriate for monitoring workload. No over-allocation.

---

## What Next Overseer Should Check

1. **sqlite3 rebuild**: Day 34+ unless applied. If degradation count drops below 6, it was finally fixed.
2. **state-integrity-check zombie**: Did `mp7n2y0a-7` resolve or is it still showing "pending"? If still pending after 24h, it may need manual cleanup.
3. **state-integrity-check duration**: Did the next run after 07:02 return to <60s, or is the 107s climb a new trend?
4. **StuckInputSentinel count**: If count exceeds 5 with server age <24h, accumulation is accelerating.
5. **Gate failures**: Confirm still 0 (was resolved this cycle after 40+ last cycle).
6. **health-check degradation awareness**: Still blind to server degradations — has anything changed?

---

<!-- Prior cycle: 2026-05-14T13:07Z -->
