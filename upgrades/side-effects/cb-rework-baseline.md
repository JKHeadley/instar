# Side-Effects Review — Delta comparison reads its rework baseline from the measurement backend

**Version / slug:** `cb-rework-baseline`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** not required (read-only report field, no gate, no session lifecycle)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §16 (Phase 1 exit: "the delta comparison shows no rework rise"), §11

## Summary of the change

`GET /context-budget/delta-shadow` reported `reworkBaseline: { status: 'unknown', reason: '… the measurement backend (Phase 1 S13), which is not built yet.' }` long after S13 shipped (`GET /context-budget/metrics`, PR #3076). The Phase 1 exit criterion therefore could not be read from the route.

- `computeOverallRework(ledger)` (`contextBudgetMetrics.ts`) computes the per-session rework over the same window and session bound the metrics route uses, without that route's other work.
- `reworkBaselineOf(...)` (`promptContext.ts`) sums it into a baseline with status `ok | pending | partial-before-upgrade`, the counts, the rate (null with no tool inputs), `partial` when the bounded session list left sessions out, and its source. With no sessions it reads `unknown` with a reason, never zero.
- `AgentServer` passes a `rework` dependency to the prompt-context routes, memoised for 5 minutes (synchronous SQLite reads stay off the hot path). No token ledger ⇒ `unknown` with the reason.
- A misplaced doc comment in `contextBudgetMetrics.ts` is put back on its own function.

Size: Tier 2 (spec-driven), 4 source files, about 90 lines; tests in 2 files. One build pass. The first push skipped the local gate (the worktree lacked the husky shim), and CI's decision-audit check caught it. This re-commit runs through the gate.

## Decision-point inventory

None. The field is a report. Nothing reads it to gate, block or route.

## 1. Over-block
No block surface.

## 2. Under-block
The baseline covers only the sessions the bounded list returns (≤ 50). `partial: true` says so in-band rather than hiding it.

## 3. Level-of-abstraction fit
It reuses the measurement backend's own per-session rework function (`reworkWithFreshness`) and bounds, so the two routes cannot disagree on method.

## 4. Signal vs authority compliance
Signal only. No authority.

## 5. Interactions
- It reads the token ledger the metrics route already reads. The 5-minute memo bounds the extra SQLite reads to one pass per 5 minutes per server.
- No change to the delta hook's behaviour or to the reduction switch.

## 6. External surfaces
One field on an existing bearer-only route changes from a fixed `unknown` to a measured value. No new route or config.

## 7. Multi-machine posture
Machine-local by design: each machine's token ledger covers the sessions it hosts, the same as the metrics route it mirrors.

## 8. Rollback cost
A revert. No state or format persists.
