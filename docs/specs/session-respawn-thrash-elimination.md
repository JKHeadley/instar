---
kind: "spec"
id: "session-respawn-thrash-elimination"
title: "Session-Respawn Thrash Elimination"
summary: "Root-cause and structurally eliminate the 72-swaps-per-day thrash: fix the macOS memory metric and the trailing-quota proactive-swap logic."
---

# Session-Respawn Thrash Elimination

**Status:** DRAFT
**Owner:** Echo  
**Created:** 2026-07-03  
**Goal Alignment:** M5 (operator's explicit concern), Goal B (seamless agent across machines)

## Problem

Sessions are respawning/swapping machines far too often (~72 swaps per day observed):
- Machine A starts a session
- 5 minutes later: proactive-swap moves it to Machine B "for quota balance"
- 5 minutes later: moves back to A
- Repeat all day

**Root causes (M1 findings):**
1. **macOS memory false-critical:** `os.freemem()` reports near-zero on macOS (it's not a useful signal). SessionReaper treats this as "critical" load-shed → kills sessions.
2. **Trailing-quota proactive-swap:** The swap logic looks at 24h quota burned, but it lags real usage by ~30m. It swaps onto an account it thinks has headroom, but that account is actually about to hit a limit.

**Impact:** Sessions lose context, conversation history breaks, users see constant "restarting..." messages.

## Design

### Layer 1: Fix macOS Memory Metric

**Current logic:**
```
freemem = os.freemem() // on macOS: almost always near-zero
percentFree = (freemem / totalMem) * 100  // = 0-5%
if (percentFree < 15%) → CRITICAL
```

**Fixed logic:**
Use the **actual memory used** by THIS process (Resident Set Size), not the global free heap:

```
usedByProcess = process.memoryUsage().rss  // ~500MB for server + sessions
totalMem = os.totalmem()
percentByProcess = (usedByProcess / totalMem) * 100  // ~5-10% on a 16GB Mac
if (percentByProcess > 60%) → CRITICAL
```

Also: **cross-check with CPU load.** A high memory reading + low CPU load = likely Spotlight reindex, not real load. Suppress the critical verdict.

**Metric to track:** `SessionReaper.macOSMemoryAccuracy` (compare `os.freemem()` vs. actual usage)

### Layer 2: Intelligent Quota Awareness

Instead of blindly trusting 24h token metrics:

**Read live quota BEFORE swapping:**
```
GET /subscription-pool/:accountId/quota → { usagePercent, resetsAt, consumed, limit }
GET /subscription-pool/poll → poll all accounts NOW (don't trust stale data)
```

**Swap decision:** Move session to account B only if:
- Account B has materially better headroom (>20% gap)
- Account B's quota freshness < 5 minutes old
- Account A is genuinely over-threshold (>80% of daily budget)

**Add drift detection:** If quota changes > 10% between consecutive polls, flag it + log. Don't swap into a "moving target."

### Layer 3: Anti-Thrash Brakes

Even with fixed metrics, prevent the swap loop:

1. **Minimum dwell time:** A session that was just swapped stays on its machine for >= 1 hour before being eligible for another swap.
2. **Deduplication:** Never swap the SAME session to the SAME account twice in one day.
3. **Breaker:** If 3 consecutive swaps of session X all result in high usage within 10 min, disable proactive-swap for that session for 24 hours.
4. **Swap cooldown:** After any swap, wait 15 minutes before evaluating quota again (let the new account stabilize).

### Layer 4: Instrumentation + Observability

**Every swap is logged with:**
- Session ID + reason (quota, load, etc.)
- Source account + target account
- Quota state at swap time (usage % before and after)
- Outcome (success, blocked, failed)

Audit trail: `logs/swap-instrumentation.jsonl`

**Metrics dashboard:**
- Swap count per day (target: < 5 / day vs. 72 / day)
- Swap reason breakdown (quota vs. load vs. proactive)
- Account utilization trend (are we actually balancing load?)
- Anti-thrash breaker fire rate

### Layer 5: Dry-Run + Staged Rollout

1. **Week 1:** Fix macOS memory + add instrumentation (dry-run swap decisions, log but don't execute)
2. **Week 2:** Monitor dry-run logs for sanity. If swap reasons are sensible, flip to live.
3. **Week 3:** Monitor live swap count, verify < 10 / day
4. **Week 4:** Graduated to default behavior

## Implementation Strategy

### Phase 1: Metrics Fix
- Replace `os.freemem()` with `process.memoryUsage().rss`
- Add CPU cross-check to suppress false-critical verdicts
- Add accuracy audit: log both old + new metric, measure divergence

### Phase 2: Quota Intelligence
- Wire `GET /subscription-pool/:id/quota` into the swap decision
- Add freshness gate (only act on quota data < 5 min old)
- Implement drift detection

### Phase 3: Anti-Thrash Brakes
- Dwell time tracking (when was this session last swapped?)
- Deduplication check (is this the same session → account move as before?)
- Breaker logic (watch for repeated failures)
- Cooldown after swap (defer next evaluation)

### Phase 4: Instrumentation
- Every swap logged to `logs/swap-instrumentation.jsonl`
- Metrics surface: `GET /session-respawn/metrics` or `/intelligence/swap-health`
- Dashboard widget showing daily swap count + reasons

### Phase 5: Live-Verify on Real Pair
- Monitor swap count with fixes enabled
- Verify swap count drops from 72 to < 10 / day
- Watch for legitimate swaps (when user actually hits quota) vs. false positives
- Validate that actual account balance improves (no burning one account while the other is idle)

## Test Plan

**Tier 1 (Unit):**
- Memory calculation: `process.memoryUsage().rss` correctly reflects process size
- Quota parsing: live quota API response parsed correctly
- Dwell time: session eligibility gates work
- Breaker: 3 failed swaps trigger disable

**Tier 2 (Integration):**
- SessionReaper swap decision path uses new metrics
- Quota freshness check blocks stale decisions
- Anti-thrash brakes prevent re-swaps
- Instrumentation writes audit trail

**Tier 3 (E2E):**
- Run on real pair for 1 day in dry-run
- Monitor `/session-respawn/metrics` for swap count + reasons
- Verify swaps make sense (not thrashing)
- Flip to live, monitor for 1 week
- Verify swap count drops measurably
- Spot-check account balances (is usage actually balanced?)

## Success Criteria

- [ ] Swap count drops from ~72/day to < 10/day
- [ ] macOS memory metric is accurate (matches observed pressure)
- [ ] Quota-driven swaps only happen when genuinely needed (>80% used)
- [ ] Anti-thrash brakes prevent loop swaps (dwell time enforced)
- [ ] Live-verified on real pair: session stability improves
- [ ] Account utilization is balanced (not concentrating on one account)

## Key Metrics to Watch

| Metric | Current | Target | After Fix |
|--------|---------|--------|-----------|
| Swaps per day | 72 | <10 | ✓ |
| False critical (macro) | 40% | <5% | ✓ |
| Swap success rate | 85% | >95% | ✓ |
| Session tenure (avg time before swap) | 5m | >1h | ✓ |
| Account utilization std dev | high | <20% | ✓ |

---

**Related specs:** mesh-self-heal-graduation, intelligent-working-set-lazy-sync

## Operator Notes

This is the **single highest-priority fix for user experience**. The 72 swaps/day is why users see constant "restarting" messages and lose conversation context. Once this is fixed, Goal B (seamless agent across machines) becomes credible.

Recommend: Land this spec first, live-verify it, then move to the others.
