---
name: token_burn_detection_phase_2
description: Phase 2 — Attribution resolver identifies which internal component made each LLM call
metadata:
  type: capability
  version: vNEXT
---

## What This Is

Phase 2 of the six-phase token-burn-detection system. Still observation-only — no alerts, no auto-throttling, no changes to how Echo behaves. This phase adds the piece that figures out which component (e.g., search agent, spec reviewer, autonomous handler) produced each LLM call after the fact.

## What Shipped

- **Attribution Resolver** — A pure function that takes a token-ledger event and returns a stable component identifier. Deterministic, no I/O, no time dependency.
- **Attribution Manifest** — Static patterns matching the prompt shapes Echo's 9 known internal components produce (e.g., agent processes, skill invocations, internal reasoning).
- **22 Unit Tests** — All passing. Covers resolver correctness, manifest uniqueness, and integrity checks.

## How to Use It

Nothing yet. The resolver is infrastructure. Phase 3 will start calling it to detect which components are burning tokens. For now, it's wired into the platform but not invoked by any production code.

## Sequence

1. Phase 1 ✅ — Attribution column on ledger, rate-gate primitive, component identifier helper
2. Phase 2 ✅ — Read-side attribution resolver + static manifest (this phase)
3. Phase 3 (next) — Burn detector that calls the resolver to group calls by component
4. Phase 4 — Auto-throttle logic
5. Phase 5 — Alerts and dashboard visibility
6. Phase 6 — Multi-agent coordination

## Technical Details

- Resolver is pure; all logic is deterministic pattern matching
- Manifest covers: main agent loop, skill invocations, background handlers, search agents, spec reviewers, autonomous orchestration, memory operations, serendipity system, and diagnostic runners
- Manifest integrity tests verify: no duplicate component names, non-empty patterns, at least one matcher per entry
- Existing unit suites (token-ledger, selectIntelligenceProvider) still pass — no regression

## Evidence

See `tests/unit/burn-detection-phase-2.test.ts` (22 tests). Side-effects review in `upgrades/side-effects/token-burn-detection-phase-2.md` — reviewer identified zero blocking concerns.
