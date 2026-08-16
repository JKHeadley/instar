# Scalability Review — docs-code-sync
**Review ID:** 20260328-114147 | **Round:** 1 | **Date:** 2026-03-28

## Approval Status

**CONDITIONAL APPROVE** — The core tiered pipeline is sound for single-repo, single-agent scope. Several assumptions embedded in the cost model and Phase 2 batching logic will cause pain as the system grows. Not blocking for v1, but need attention before multi-repo or multi-agent extension.

---

## Research Findings

### Claude API Token Pricing (March 2026, verified)

| Model | Input/1M | Output/1M |
|-------|----------|-----------|
| Haiku 4.5 | $1.00 | $5.00 |
| Sonnet 4.6 | $3.00 | $15.00 |
| Opus 4.6 | $5.00 | $25.00 |

The spec's cost estimates appear to use older pricing. Sonnet output is $15/M — the spec implies ~$1.50/M. This is a 10x undercount on the dominant cost driver. Prompt caching (90% savings) and Batch API (50% savings) are both applicable and unmentioned.

### Git Diff Performance

- `git diff --name-only` is fast and not a bottleneck at any plausible instar scale.
- Rename detection (`--find-renames`) is O(n²) with a hard default ceiling of 400 files. Refactors above this silently skip rename detection — the job would not know.
- Not a risk until the source repo is 10x–100x larger than today.

### LLM Doc-Sync Patterns

- Primary production failure mode: false positive rate climbs as doc corpus grows.
- Batching (grouping changes into single LLM calls) is the correct established pattern. Per-file calls at scale consistently cause rate limit hits and cost explosions.
- Claude Code concurrent subagent degradation is a documented issue: after 2–3 hours of concurrent subagent operation, agents slow dramatically and lose state coherence. Parallel Phase 3 execution carries real risk.

---

## Critical Issues

### 1. Cost Model Is 3–10x Understated

Working the math at actual current Sonnet output pricing ($15/M):

- Phase 3 for 2 docs: ~120k input ($0.36) + ~80k output ($1.20) = **$1.56**
- Phase 2 Haiku for 30–50k tokens: ~**$0.11**
- **Realistic per-run cost with 2 stale docs: ~$1.67**, not the spec's $0.20–0.50

At 6 runs/day worst case: **~$10/day**, not $3–9. The spec's worst-case estimate is based on ~$1.50/M Sonnet output. The real price is $15/M. **Breaks at: first billing statement after any active development sprint.**

### 2. Phase 2 Batching Is Undefined — A Scale Trap

The spec says "group related changes into single Haiku calls where possible" but provides no algorithm, no token ceiling per batch, and no definition of "related." As `docCodeMap` fills in over months, the number of (doc-section, code-change) pairs per run grows monotonically. Without explicit batch size caps, batches grow silently until they hit Haiku's context window limit. **Breaks at: approximately 60+ doc entries in `docCodeMap`.**

---

## Key Recommendations

**R1. Use Batch API for Phase 2** — Haiku triage calls are async by nature. Batch API gives 50% savings and removes rate limit pressure. Store pending batch IDs in state file; collect results on next cycle.

**R2. Add Hard Token Budget Caps** — Add `budgetCaps.phase2HaikuTokensPerRun` and `phase3SonnetTokensPerRun` with `abortOnBudgetExceeded: true` to the job config. One large refactor run can otherwise consume a day's budget silently.

**R3. Process Phase 3 Sequentially, Not in Parallel** — 5 concurrent Sonnet subagents will hit rate limits. Doc updates have no urgency within a 4-hour window. Sequential execution also prevents partial-commit states.

**R4. Instrument `docCodeMap` Hit Rate** — Track `docCodeMapSize` and `docCodeMapHitRate` in runHistory. When hit rate drops below 0.6, the map needs pruning or the codebase has diverged.

**R5. Add Map Entry Freshness Decay** — Entries not verified in >30 days should fall back to grep rather than being trusted blindly. Stale entries pointing to deleted docs cause silent false negatives.

**R6. Add UNCERTAIN Item Drain** — UNCERTAIN triage results accumulate indefinitely in handoff notes with no aging mechanism. Add max-age; re-triage old UNCERTAIN items rather than carrying them forward forever.

---

## Scalability Assessment by Phase

**Current scale (today):** Healthy. All phases within margins. Realistic monthly cost $20–60.

**10x scale (~2,000 source files, 80 docs, 3–5 agents):** Needs R1, R2, R3 before reaching this. Phase 2 pairs per run hit 200+; concurrent Phase 3 subagents hit rate limits; monthly cost reaches $200–400 without Batch API.

**100x scale (~20,000 source files, 300+ docs):** Requires architectural rethink. Grep fallback becomes the bottleneck (15,000 grep operations per run); needs FTS5 inverted index over doc corpus. JSON state file needs migration to SQLite. Rename detection hits the 400-file ceiling frequently.

---

## Score: 7 / 10

The tiered architecture is well-designed. Gate mechanism, Haiku triage layer, and dependency map concept are all correct instincts. Deductions: pricing assumptions already stale (-1), undefined batching algorithm that is the primary cost control lever (-1), no budget caps on a system making 6 paid API calls/day (-0.5), no UNCERTAIN drain mechanism (-0.5). Safe to deploy at v1 scope. Needs R1 and R2 before multi-agent/multi-repo extension.
