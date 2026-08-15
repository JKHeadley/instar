# R3 Scope Decision — no throwaway accounts; fault-injection-to-wall deferred to operator go/no-go

**Date:** 2026-07-01 · autonomous reversible decision (charter decision #2 requires throwaway accounts).

## Constraint
There are NO dedicated throwaway accounts. Every account is the LIVE agent's production pool:
- claude: 5 pool accounts (sagemind-justin, justin-gmail, adriana, sagemind-adriana active;
  sagemind-dawn needs-reauth) — all shared with the running agent.
- codex / gemini / pi: single production account each (~/.codex, ~/.gemini, ~/.pi).

Charter decision #2: "Use dedicated throwaway accounts for all load & fault-injection so we can
push a pathway to its rate-limit wall without burning production quota or confounding results
with live load." With none available, deliberately exhausting a pathway to its wall would:
- degrade the LIVE agent (provider-fallback routes its sentinels/gates onto these same accounts —
  esp. codex), and
- burn real subscription quota the agent needs to keep operating.

## Decision (reversible, safe)
R3 is executed in two SAFE parts, and the risky part is surfaced as an operator go/no-go:
1. **Concurrency sweeps (SAFE, will run):** for each pathway, N bounded, concurrency ∈ {1,2,4,8},
   measuring where latency/throughput knees over WITHOUT pushing to the rate-limit wall. Bounded
   total spawns (respect host cap 8). Run AFTER the R2 codex baseline completes (avoid contention).
2. **Observational rate-limit/reset characterization (SAFE, no wall):** capture real reset windows
   from live quota endpoints + any recorded breaker/ledger rate-limit events, rather than inducing
   them. Baseline snapshot captured with this doc.
3. **Deliberate fault-injection-to-wall: DEFERRED — operator go/no-go.** Requires a throwaway
   account (a spare free-tier login per provider) to avoid disrupting the live agent. NOT a blocker
   for R3's value (the concurrency knee + observational resets are the actionable parts); the exact
   request-count threshold at the wall is the only piece that needs a throwaway account. If the
   operator wants true wall-hitting, provide/authorize a throwaway login and it runs in one pass.

## Why this is the right call
The value of R3 is "where does each pathway degrade, and how does it fail" — the concurrency knee
+ failure taxonomy (already seeded by R4: codex timeout, gemini swap-timeout) deliver that safely.
Burning a shared production account to find an exact threshold is high-cost/low-marginal-value and
would harm the very agent running this study.
