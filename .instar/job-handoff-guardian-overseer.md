[HANDOFF] Guardian Category Overseer — 2026-05-15T19:05Z

## Executive Summary

Guardian monitoring is at its best-ever operational health: all 5 jobs running at 100% success rate (114/114 runs), zero failures, zero skips. Key improvements since May 11: **health-check fully recovered to 100%** (from 95.8%), **version advanced to 0.28.103** (from 0.28.86). Persistent unresolved issues: **better-sqlite3 still broken (19+ days)**, **Telegram polling not active (25+ days)**, **zero handoff notes from any guardian job (11th+ consecutive flag)**. New concerns this run: **sessions at max (10/10)**, **degradation-digest duration spike (94s vs 15-31s typical)**, **state-integrity-check double-run anomaly (00:58 and 01:00, 2 min apart)**.

---

## Current Job Health — 2026-05-15T19:05Z

| Job | Status | Rate | Runs | Avg Duration | Notes |
|-----|--------|------|------|--------------|-------|
| health-check | ✅ Best ever | 100% | 93 | 28s | Full recovery from 88-96% in prior cycles |
| degradation-digest | ✅ Healthy | 100% | 7 | 33s | Latest run spiked to 94s — 3x above normal |
| state-integrity-check | ✅ Healthy | 100% | 5 | 37s | Double-run anomaly at 00:58/01:00 |
| guardian-pulse | ✅ Healthy | 100% | 3 | 45s | Last run 4h ago; next ~23:00 UTC |
| session-continuity-check | ✅ Healthy | 100% (6/6 completed) | 6+1 pending | 45s | Currently running |

---

## Issue #1: better-sqlite3 — 19+ Days 🔴 (PERSISTENT)

Still causing 6 degradations: SemanticMemory, TopicMemory, iMessage, FeatureRegistry, Layer 2 durable queue, conflict resolution. 51 cumulative degradation events in the digest. Fix remains: `cd .instar/shadow-install && npm rebuild better-sqlite3`

## Issue #2: Telegram Polling Not Active — 25+ Days 🔴 (PERSISTENT)

systemReview probe `instar.messaging.connected` still failing. State: "Adapter exists but polling is not active." Was framed as "Lifeline stopped" in prior handoffs. Remediation: check bot token validity, check network to api.telegram.org, check server logs. This is the longest-running unresolved issue.

## Issue #3: Zero Handoff Notes — 11th+ Consecutive Flag 🟡 (CHRONIC)

All 5 guardian jobs still show `lastHandoff: null`. The handoff file infrastructure exists (`.instar/job-handoff-*.md` files exist) but individual jobs aren't writing to it. Each run starts blind with no cross-run trend detection.

## Issue #4: Sessions at Max (10/10) — NEW ⚠️

`/health` shows `sessions: {current: 10, max: 10}`. All session slots occupied. 16 external Claude processes + 10 tracked. If any guardian job needs a session when the pool is saturated, it will fail or queue. Health-check's current 100% rate may be masking pressure if it doesn't require sessions. Worth monitoring.

## Issue #5: Degradation-Digest Duration Spike — NEW ⚠️

Latest run (19:01 UTC) took 94 seconds vs prior runs of 31, 15, 27, 23 seconds. 3x spike. The digest processed 1,001 events and found 8 patterns — a heavier analysis load than typical. Could indicate growing event backlog. If next run is also >60s, investigate event accumulation.

## Issue #6: State-Integrity-Check Double-Run — NEW ⚠️

Two consecutive runs at 00:58:52 and 01:00:00 UTC (only 68 seconds apart). Both completed. This looks like a scheduler retry or trigger collision. The 6h interval schedule doesn't explain runs 68 seconds apart. Could cause duplicate state writes or false-positive integrity findings.

## Issue #7: Health-Check Orphaned Pending — MINOR

Run `mp78m3vx-b` started at 18:15 UTC shows "pending" state while subsequent run at 18:30 completed normally. Stale ledger entry, same pattern observed May 11. Not causing failures but represents stale state in the ledger.

---

## Cross-Job Coherence

**Health-check vs /health status**: Health-check reports 100% success but server is `"degraded"` with 9 active impairments. This is expected — health-check is a liveness probe, not a depth probe. The monitoring blind spot persists: the guardian stack shows all-green while iMessage, Telegram, semantic search, knowledge graph, and durable queue are offline.

**Degradation-digest vs guardian-pulse**: The digest found 8 patterns and submitted feedback. No guardian-pulse handoff to cross-check against. Cannot verify whether pulse is silently passing on the same known degradations or doing independent analysis.

**Coherence verdict**: Jobs tell parallel stories (all healthy by their own metrics) but don't cross-validate each other. Zero handoff notes means no triangulation possible.

---

## Trend Table

| Issue | May 7 | May 9 | May 11 | May 15 |
|-------|-------|-------|--------|--------|
| Zero handoff notes | ⚠️ 8th | ⚠️ 9th | ⚠️ 10th | ⚠️ 11th |
| better-sqlite3 | 🔴 13d | 🔴 15d | 🔴 17d | 🔴 19d |
| Telegram/Lifeline | 🔴 17d | 🔴 19d | 🔴 21d | 🔴 25d |
| Health-check success rate | 100% | 88% | 95.8% | **100%** ✅ |
| Degradation count | 8 | 8 | 7 | 9 |
| Server version | 0.28.85 | 0.28.85 | 0.28.85 | **0.28.103** ✅ |
| Session saturation | — | — | — | 🔴 10/10 NEW |
| Digest duration spike | — | — | — | ⚠️ 94s NEW |
| State-check double-run | — | — | — | ⚠️ NEW |

---

## Next Overseer: Watch For

1. **Sessions (10/10)** — Has pool cleared? If still saturated, this is the next failure source.
2. **Degradation-digest duration** — Was 94s a one-off or trend? If next run >60s, event backlog is growing.
3. **State-integrity-check** — Did the double-run at 00:58/01:00 recur? Check for any near-simultaneous runs.
4. **Telegram** — 25+ days; `systemReview.failedProbes` still lists it. Is remediation being attempted?
5. **better-sqlite3** — 19+ days; count steady at 6 degradations or rising?
6. **Handoff notes** — 11th consecutive flag. This is structural infrastructure debt.

---

<!-- ARCHIVED: Prior handoff 2026-05-11T19:13Z -->

[HANDOFF] Guardian Category Overseer — 2026-05-11T19:13Z

## Executive Summary

Guardian monitoring is operationally healthy (99.2% avg success). The three chronic issues from prior runs remain unresolved: **better-sqlite3 still broken (17+ days)**, **Lifeline still stopped (21+ days, now 10th+ consecutive flag)**, **zero handoff notes from any guardian job**. New items this run: version mismatch (0.28.85 running vs 0.28.86 on disk), commitment-detection causing session pressure (9 timeouts = primary collateral damage source for health-check), and two orphaned 18h-old pending ledger entries. Duplicate Lifeline entry in /health is fixed — degradation count dropped from 8 to 7.

---

## Current Job Health — 2026-05-11T19:13Z

| Job | Status | Rate | Avg Duration | Notes |
|-----|--------|------|--------------|-------|
| health-check | ⚠️ Slight degradation | 95.8% (95 runs) | 35s | 4 timeouts — regression from 0% May 7 |
| degradation-digest | ✅ Healthy | 100% (6 runs) | 30s | Clean |
| state-integrity-check | ✅ Healthy | 100% (3 runs) | 79s | 1 orphaned pending from 01:00 UTC |
| guardian-pulse | ✅ Healthy | 100% (3 runs) | 79s | Normal |
| session-continuity-check | ✅ Healthy | 100% (6 runs) | 76s | Normal |

---

## Issue #1: better-sqlite3 — 17+ Days 🔴 (PERSISTENT)
Same 6 degradations. Fix: `cd .instar/shadow-install && npm rebuild better-sqlite3`

## Issue #2: Lifeline STOPPED — 21+ Days 🔴 (10th+ FLAG)
`listener-health.json` state: "stopped". Telegram dead since ~Apr 20. Prior handoff said escalate at 9th flag.

## Issue #3: Zero Handoff Notes — 10th+ Consecutive Flag 🟡
All 5 guardian jobs lastHandoff: null.

## Issue #4: Audit Log operation='?' — UNRESOLVED 🟡
`HookEventReceiver.ts:295` still logging `operation='?'`. Not fixed since May 7.

## Issue #5: Version Mismatch — NEW 🟡
Running v0.28.85, disk has v0.28.86. Server needs restart to activate.

## Issue #6: commitment-detection Session Pressure — NEW ⚠️
9 timeouts in 24h (dashboard-link-refresh: 7). These grab/kill sessions repeatedly, causing collateral health-check timeouts. Health-check's 4 failures likely caused by this, not its own instability.

## Issue #7: Orphaned Pending Ledger Entries — NEW 🟡
state-integrity-check and overseer-guardian both show pending from 01:00 UTC (~18h old). Subsequent runs succeeded — stale orphans with no cleanup.

---

## Trend Table

| Issue | May 7 | May 9 | May 11 |
|-------|-------|-------|--------|
| Zero handoff notes | ⚠️ 8th | ⚠️ 9th | ⚠️ 10th |
| better-sqlite3 | 🔴 13d | 🔴 15d | 🔴 17d |
| Lifeline stopped | 🔴 17d | 🔴 19d | 🔴 21d |
| Health-check timeout rate | 0% ✅ | 12% | 4.2% |
| Degradation count | 8 | 8 | 7 |
| Audit log op='?' | 🟡 NEW | unresolved | unresolved |
| Duplicate Lifeline entry | — | 🟡 NEW | ✅ FIXED |
| Version mismatch | — | — | 🟡 NEW |
| commitment-detection cascade | — | — | ⚠️ NEW |

---

## Next Overseer: Watch For
1. Lifeline — 21d stopped, [ATTENTION] warranted
2. commitment-detection — 9 timeouts; if continuing, root cause of health-check regression
3. Version mismatch — did 0.28.86 activate?
4. Orphaned pending entries — accumulating or stable?

---

<!-- ARCHIVED: Prior handoff 2026-05-09T13:00Z -->

[HANDOFF] Guardian Category Overseer — 2026-05-09T13:00Z

## Executive Summary

Guardian monitoring is operationally functional but has two regressions from May 7: **health-check timeout rate jumped from 0% back to 12%** (11 timeouts in 24h) and **handoff notes are still null for all 5 jobs (9th consecutive flag)**. The three chronic structural issues (better-sqlite3, Lifeline stopped, zero handoff notes) remain completely unresolved. One improvement: duplicate Lifeline entry in /health is gone — degradation count is back to 6.

---

## Current Job Health — 2026-05-09T13:00Z

| Job | Status | Rate | Avg Duration | Notes |
|-----|--------|------|--------------|-------|
| health-check | ⚠️ Degraded | 88% (94 runs) | 61s | 11 timeouts — REGRESSION from 0% on May 7 |
| degradation-digest | ✅ Healthy | 100% (5 runs) | 23s | Clean |
| state-integrity-check | ✅ Healthy | 100% (4 runs) | 88s | 1 run pending at report time (normal) |
| guardian-pulse | ✅ Healthy | 100% (3 runs) | 65s | Normal |
| session-continuity-check | ✅ Healthy | 100% (5 runs) | 73s | Normal |

---

## Issue #1: better-sqlite3 Bindings Broken — 13+ Days 🔴 HIGH (PERSISTENT)

**Status**: Unresolved since Apr 24. Server reporting `status: "degraded"` with 8 active impairments (up from 6 on May 5 — the Lifeline entry now appears twice, see Issue #2a).

**Affected capabilities**:
- iMessage messaging unavailable
- SemanticMemory/knowledge graph disabled (semantic search, entity-relationship queries offline)
- TopicMemory disabled (sessions start without conversation summaries, context limited to last 20 raw messages)
- FeatureRegistry in-memory only (feature discovery state not persisted)
- Conflict resolution impaired (GitSync.pull fallback active)
- Layer 2 durable queue disabled (pending-relay queue offline)

**Fix**: `cd .instar/shadow-install && npm rebuild better-sqlite3`

**Root cause**: Server updates don't run `npm rebuild` on shadow install. Manual or update-flow integration required.

---

## Issue #2: Lifeline STOPPED — 17+ Days 🔴 HIGH (PERSISTENT)

**Status**: Telegram messaging dead since Apr 20. TelegramLifeline.versionSkewInfo entries accumulating — degradations.json has 21+ entries for this feature.

**Impact**: All inbound Telegram messages not being received or processed.

### Issue #2a: NEW — Duplicate Lifeline Entry in /health

The `/health` degradationSummary now returns "Lifeline hasn't restarted in a while; consider manual kick." **twice** (two identical entries). New regression since May 5 overseer. Likely a bug in how TelegramLifeline.versionSkewInfo degradations are deduplicated before surface. Low urgency but produces misleading degradation counts.

---

## Issue #3: Zero Handoff Notes — 8th Consecutive Flag 🟡 CHRONIC

All 5 guardian jobs still show `lastHandoff: null`. Skill telemetry confirms all skills are running (output_length=0) but nothing is being written to the handoff store.

**Impact**: No cross-run trend detection. Each run starts blind. Degradation patterns, duration drift, and recurrence are invisible between overseer cycles.

**Status**: This is a source-level infrastructure gap. Not fixable by job configuration alone.

---

## Issue #4: Audit Log Operation Field Missing — NEW 🟡

All recent `destructive-ops.jsonl` entries show `operation='?'` from `HookEventReceiver.ts:295`. The operation field is not being captured from hook events. Data quality issue — audit trail is recording events but losing their classification. Not urgent but degrades forensic value of the audit log.

---

## Cross-Job Health Assessment

**Health-check vs actual health**: Health-check is running at 100% success rate but the server is in a `"degraded"` state with 8 active impairments. Health-check is a liveness probe only — it confirms the server responds but doesn't surface degradation depth. The guardian system shows green while iMessage, Telegram, semantic search, knowledge graph, and durable queue are all offline. This is a persistent monitoring blind spot.

**Coherence**: No contradiction between jobs — but absence of handoff notes makes it impossible to verify whether degradation-digest or guardian-pulse are actually evaluating and silently passing on the 8 degradations, or silently passing without evaluation.

---

## Trend vs Prior Overseer Runs

| Issue | Apr 27 | May 3 | May 5 | May 7 |
|-------|--------|-------|-------|-------|
| Zero handoff notes | ⚠️ 4th flag | ⚠️ 6th flag | ⚠️ 7th flag | ⚠️ 8th flag |
| better-sqlite3 degradation | 🔴 3 days | 🔴 9 days | 🔴 11 days | 🔴 13 days |
| Lifeline stopped | — | 🔴 NEW | 🔴 15 days | 🔴 17 days |
| Health-check timeout rate | 2% | 4.2% (3 consec) | 2.1% | 0% ✅ best ever |
| Degradation count | ~6 | 6 | 6 | 8 (dup Lifeline) |
| Server status | degraded | degraded | degraded | degraded |
| Audit log operation='?' | — | — | — | 🟡 NEW |
| Duplicate Lifeline entry | — | — | — | 🟡 NEW |

---

## Next Overseer: Watch For

1. **better-sqlite3 fix** — Has `npm rebuild better-sqlite3` been run in `.instar/shadow-install/`? Degradation count should drop from 8 to ≤2.
2. **Lifeline restart** — Is listener-health.json still `"stopped"`? If 9th consecutive flag, escalate with [ATTENTION].
3. **Duplicate Lifeline entry** — Does `/health` still return it twice? If yes, file a source fix.
4. **Audit log operation field** — Is `HookEventReceiver.ts:295` still logging `operation='?'`?
5. **Health-check timeout rate** — First 0% 24h window. Monitor — is this a trend or noise?
6. **Handoff notes** — Still null = 9th flag; escalate to [ATTENTION] if still unresolved.
