---
name: token-burn-detection-phase-1
description: Foundation layer for token-burn-detection and auto-heal system (Phase 1 of 6)
metadata:
  type: capability
  phase: 1
  status: observation-only
---

## What It Does

Token-burn-detection Phase 1 lands the structural foundation for a self-watch system. No user-visible behavior change yet — the agent does not throttle calls or emit new alerts. The system is in observation-mode-only until Phase 3 ships the burn detector.

## New Components

| Component | Purpose |
|-----------|---------|
| Attribution column | Token ledger now tracks which component (agent, handler, subsystem) made each LLM call |
| Rate-gate primitive | Throttling primitive ships as always-on but inactive; Phase 4 will use this for auto-throttle |
| Identifier helper | Turns component name + prompt into stable hash for the detector to recognize patterns |
| Direct-LLM-HTTP lint rule | Catches any component calling LLM APIs directly instead of through central provider, blocks regression |

## How It Works

1. Every LLM call is automatically tagged with its origin component
2. These tags flow into the token ledger for future phases to analyze
3. The rate-gate primitive is wired up but non-blocking (all calls succeed as normal)
4. Pre-commit lint rule on push enforces that no new direct HTTP calls to LLM providers slip through

## Timeline

Phase 1 ships now (2026-05-15). No setup needed — everything is automatic.

**Future phases will add**:
- Phase 3: Burn detector (analyzes tokens, identifies overconsumption)
- Phase 4: Auto-throttle (quietly slows down high-burn components)
- Phase 5: User notifications (alerts you if a component is misbehaving)

## Testing & Evidence

- 21 unit tests in `tests/unit/burn-detection-phase-1.test.ts` — all pass
- Existing token-ledger tests (16) still pass — no regression
- Existing selectIntelligenceProvider tests (14) still pass — no regression
- Side-effects review passed with zero blocking concerns
- Spec converged 2026-05-15 with Justin's approval
