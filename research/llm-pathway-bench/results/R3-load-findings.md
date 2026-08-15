# R3 Finding — Concurrency behavior (sweeps) + failure taxonomy

**Date:** 2026-07-01 · concurrency sweeps N=12/cell on fast pathways. Scope per R3-scope-decision.md
(no throwaway accounts → safe sweeps + observational reads; deliberate wall-hitting = operator go/no-go).

## Concurrency sweep — fast pathways (p50 latency by concurrency)
| Pathway | c=1 | c=2 | c=4 | behavior |
|---|---|---|---|---|
| pi-gpt55 | 4,607ms | 4,622ms | 4,348ms | **FLAT — best concurrency scaling**, no degradation to c=4 |
| claude-haiku | 3,544ms | 2,888ms | 6,317ms | fine to c=2, **knees at c=4** (p50 ~doubles) |
| gemini-flash | 8,538ms | 9,100ms | 9,795ms (p95 20,857ms) | p50 creeps, **tail degrades** (p95 15.7s→20.9s) |

okRate stayed 1.00 for all fast pathways through c=4 (no errors induced without hitting the wall).

## Findings
1. **pi is the most concurrency-robust pathway** — flat p50 c=1→c=4. Combined with its lowest
   single-call latency AND lowest token overhead, pi is the standout for high-frequency /
   high-concurrency internal work.
2. **claude tiers knee around c=4** (p50 doubles). Fine for low-concurrency gating; for bursty
   parallel classification, throughput degrades — a reason to spread bursty load off a single
   claude account (aligns with the subscription-pool multi-account design).
3. **gemini degrades in the TAIL under concurrency** (p95 +33% at c=4) — reinforces R4: gemini is
   latency-fragile, poor choice where a tight tail matters.
4. **The real concurrency ceiling is the HOST SPAWN CAP (8)**, a system constraint shared with the
   live agent's own LLM components — NOT a per-pathway limit. c=8 was NOT tested to avoid starving
   the live agent's outbound path (observed earlier this session: benchmark load at high concurrency
   starves the tone gate → fail-closed). Documented as the ceiling rather than induced.
5. **codex concurrency: fragile even at c=1** (1/30 timeout uncontended, R2). Codex was NOT swept at
   higher concurrency — it wedges (R4) and shares the account with the live agent's codex-routed
   sentinels; hammering it would degrade the live agent. Codex's concurrency headroom is best left
   low; its problem is latency/tail, not throughput-at-scale.

## Failure taxonomy (seeded from R2 + R4; classifyError signatures)
| Signature | Seen on | Cause |
|---|---|---|
| timeout | codex (1/30 at c=1) | wedge / cold-start > cap (R4) |
| rate-limit | (not induced — no throwaway acct; observational only) | subscription window (5h/weekly) |
| (swap-timeout) | gemini in failover tail | 5s cap < 8.5s p50 (R4) |

## R3 status: substantially COMPLETE (concurrency knee + taxonomy). Deferred: deliberate
fault-injection-to-wall (needs a throwaway account — operator go/no-go, see R3-scope-decision.md).
