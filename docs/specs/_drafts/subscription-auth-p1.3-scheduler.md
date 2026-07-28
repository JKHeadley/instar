---
kind: spec
id: subscription-auth-p1.3-scheduler
title: P1.3 — Quota-Aware Auto-Swap Scheduler + Session-Continuity Guarantee
status: approved
parent: subscription-auth-standard
date: 2026-06-07
author: echo
parent-principle: "Structure beats Willpower"
parent-principle-fit: "The continuity guarantee is enforced in code (the scheduler resumes a quota-walled session on another account via the existing --resume path), not by an operator remembering to swap accounts. The additive-optional configHome threading + the dark-by-default auto-trigger are structural guardrails: existing restarts are byte-for-byte unchanged, and auto-swap can't fire until explicitly enabled."
review-convergence: internal-grounded-2026-06-07
review-convergence-detail: "Internal convergence (single-agent, noted honestly — no cross-model reviewer this round). The design was grounded against the REAL codebase before writing: an Explore pass mapped the exact reuse seams (SessionRefresh.refreshSession + respawnSessionForTopic + TopicResumeMap + RateLimitSentinel events) and verified the load-bearing premise — `claude --resume <uuid>` is agnostic to CLAUDE_CONFIG_DIR, so resuming a conversation under a different account preserves continuity. The scheduler core + the configHome→CLAUDE_CONFIG_DIR spawn primitive + the Session account field are already implemented and green (70 unit tests incl. all continuity cases: swap-and-resume, no-eligible-alternate, refresh-failed). Open risk folded into the design: the live-wiring is ADDITIVE-OPTIONAL (unchanged when no configHome) and the auto-trigger ships DARK behind a config flag, so the load-bearing session-restart path is not behavior-changed for existing sessions."
approved: true
approved-by: Justin
approved-via: "Telegram topic 20905 (2026-06-07): explicit approval after I surfaced P1.3 as a tier-2 change needing his sign-off (load-bearing restart-path surgery) — Justin: 'Approved for all. Please enter a 12 hour autonomous session to finish this out.' Approval recorded per the autonomous-directive precedent."
eli16-overview: subscription-auth-p1.3-scheduler.eli16.md
---

# P1.3 — Quota-Aware Auto-Swap Scheduler

> Tier-2 (real authority): this phase restarts live sessions and changes session
> spawn environment (per-account `CLAUDE_CONFIG_DIR`). It requires operator
> review + approval before merge, unlike the dark/observe-only P1.1/P1.2.

## Goal

Pick the optimal subscription account for each session and **guarantee a
long-lived session never dies on a quota limit** — it either swaps proactively
before the wall or resumes on another account reactively after hitting it.

## The hard continuity guarantee (load-bearing)

A long-lived session that hits its account's quota MUST resume on a DIFFERENT
account and continue the SAME conversation — never die. Grounded finding:
**`claude --resume <uuid>` is agnostic to `CLAUDE_CONFIG_DIR`**, so resuming a
conversation under a different account just works. We reuse existing machinery:

- `SessionRefresh.refreshSession()` (src/core/SessionRefresh.ts) + `POST /sessions/refresh`
- `TopicResumeMap` (save on `beforeSessionKill`, get on respawn) — already persists
  the conversation UUID independent of the account.
- `RateLimitSentinel` (src/monitoring/RateLimitSentinel.ts) emits
  `rate-limit:detected` / `rate-limit:escalated` with `sessionName` — the swap trigger.

## What P1.3 adds

1. **`subscriptionAccountId?` on the Session type** (src/core/types.ts) — tracks
   which account a session is running under.
2. **`configHome?` on `InteractiveLaunchOptions`** (src/core/frameworkSessionLaunch.ts)
   → injected as `CLAUDE_CONFIG_DIR=<configHome>` into `envOverrides` (the tmux
   `-e` flags in spawnInteractiveSession). GAP today: config-home is not set
   per-session; sessions inherit the parent's. This closes it.
3. **`QuotaAwareScheduler`** (new, src/core/) —
   - `selectAccount(pool, poller)`: among `active` accounts, reset-date-optimal
     "use-before-reset" scoring = `unusedHeadroom × urgency(resetsAt)`; excludes
     rate-limited/needs-reauth/disabled.
   - `onQuotaPressure(sessionName)`: subscribed to the RateLimitSentinel events
     (and/or QuotaPoller burn ≥ soft threshold, default 90%) → pick next-best
     account → `SessionRefresh.refreshSession({ sessionName, accountSwapTo })`
     pointed at the new account's configHome, preserving the conversation via
     `--resume`.
   - **Invariant:** a session at a quota wall is never left dead while another
     eligible account exists; if none exists, raise ONE deduped Attention item
     (reuse the topic-flood-guarded path) and leave the existing sentinel
     back-off as the floor.
4. **Pre-limit proactive swap:** at a safe session boundary, when the active
   account crosses the soft threshold, the NEXT spawn/refresh targets the
   next-best account (Justin decision 2: B + the guarantee as floor).

## Tests (3 tiers)

- **Unit:** selectAccount scoring (use-before-reset ordering; exclusions);
  onQuotaPressure picks the right account; no-eligible-account → Attention path.
- **Integration:** HTTP — a route to inspect/trigger placement; configHome
  threading into the launch spec (assert `CLAUDE_CONFIG_DIR` in the built env).
- **E2E (the guarantee):** drive a session to a MOCKED quota limit → assert it
  resumes on another account (different configHome) with the conversation UUID
  preserved (same `--resume` uuid), i.e. continuity intact, session not dead.

## Rollout

Dark behind config until enabled; single-account pools are a no-op (no alternate
to swap to). CapabilityIndex: new routes classified (INTERNAL until graduation).
Migration parity: `subscriptionAccountId` is additive-optional on Session.

## Open for operator (tier-2 approval)

- Soft-threshold default (90%?) for proactive swap.
- Whether to ever interrupt a long session mid-turn vs only at boundaries
  (Justin decision 2 = B with the reactive guarantee as the floor — confirm).
