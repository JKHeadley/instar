# Adversarial Review — Round 5

**Approval Status: CONDITIONAL**

**Score: 8.2/10** — Two critical issues, both cheap to fix in the spec. With those addressed, the spec reaches 9.0+ and is ready to implement.

---

### P0 Fix Verification (all 4 fixes from round 4)

- **Recovery fraud 24h time-lock**: Partially adequate — notification channel suppression during lock window is an exploitable gap; rate limit creates alert-fatigue training attack
- **PoW ceiling (10x) + fast-solver throttling**: Adequate — but 100ms threshold is too coarse for modern hardware (M3/NPU)
- **Migration window 30-day deadline**: Adequate — but enforcement is peer-side only; MoltBridge should also refuse credibility packets for overdue migrations
- **Attestation retaliation blinding**: Partially adequate — blinding is opt-in but should default ON for negative outcomes; 24h retaliation detection window is trivially evaded by waiting 25 hours

---

### Critical Issues (NEW)

**C1 — Argon2id Constant Salt**
The recovery KDF uses `"instar-recovery-v1"` as a static salt for ALL agents. Per-agent random salt should be added to `identity.json`. Cheap fix now, unmitigatable after deployment.

**C2 — Delegation Depth Not Capped**
`max_sub_agents: 3` is a count, not a depth limit. A 3-hop chain of 3 agents = 27 agents under one grant. Must specify `max_delegation_depth` before Phase 2.

---

### Recommendations

- Fast-solver threshold should be hardware-relative (percentile-based) rather than absolute 100ms
- Blinded attestations should default ON for negative outcomes
- Retaliation detection window should be randomized (24-72h) to prevent gaming
- MoltBridge should enforce migration deadline server-side, not just peer-side
- Recovery notification suppression during time-lock window needs explicit mitigation

---

### Scalability Assessment

- **Phase 1 (MVP)**: Both critical issues are spec-level fixes. No implementation blockers.
- **Phase 2 (Growth, 10x)**: Delegation depth becomes exploitable at scale. Must fix before Phase 2.
- **Phase 3 (Scale, 100x)**: PoW threshold calibration becomes critical with diverse hardware. Need auto-calibration.
