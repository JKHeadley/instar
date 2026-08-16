# Privacy Review Round 2 — Persistent Listener Daemon RFC

**Review ID**: 20260405-142000 | **Round**: 2 | **Score: 8.0/10** (was 6.5)

### Approval Status: CONDITIONAL APPROVE — no blockers

---

### Round 1 Issue Resolution

| Issue | Status | Notes |
|-------|--------|-------|
| CRITICAL-1: Behavioral telemetry in profile | **RESOLVED** | Opt-in default, coarse bands only, hard exclusion list for timestamps/counts |
| CRITICAL-2: No inbox retention policy | **RESOLVED** | 30-day max, 50MB trigger, archived files deleted past retention. Minor gap: dedup.db TTL not documented |
| CRITICAL-3: ThreadResumeMap sync privacy | **PARTIALLY RESOLVED** | Operational sync answered. Privacy analysis (personal data status) deferred to Phase 4 — acceptable |

### Recommendations Status

| Rec | Status | Notes |
|-----|--------|-------|
| REC-1: Relay presence consent | NOT ADDRESSED | No disclosure for presence visibility. Relevant if multi-tenant relay. |
| REC-2: Daemon log scoping | **RESOLVED** | Explicit logging policy, never log content, truncated fingerprints |
| REC-3: Pipe autonomy disclosure | PARTIALLY | IQS gates reduce scope. No first-run consent added. |
| REC-4: Relay operator trust model | NOT ADDRESSED | Documentation gap only |
| REC-5: Right-to-erasure / purge | **RESOLVED** | `instar listener purge` with GDPR label. Minor: temp prompt files not in scope |
| REC-6: IQS transparency | **RESOLVED** | Band table, minIqsBand config, 30-day decay |

### Pre-Phase-1 Items

1. Add auth to `/listener/metrics` and `/listener/health` endpoints
2. Add `dedup.db` retention TTL
