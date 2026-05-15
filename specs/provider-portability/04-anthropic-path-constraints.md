# Anthropic Path Constraints — Foundational Rules

**Status:** Active, locked 2026-05-15 by Justin
**Branch:** `spec/provider-portability`
**Applies to:** Every Anthropic-touching code path in Instar, current and future. Drives every routing decision in Phase 5+. Drives every adapter design in Phase 3+.

---

## ELI16 — what this document says

Instar talks to Claude in three possible ways. Two of them are safe; one is dangerous. This document says when each one is allowed.

The three ways:
1. **Subscription path** — Instar keeps a long-lived `claude` conversation running in the background and types prompts into it. This is the way an actual human uses Claude Code, and it bills against your Max subscription (no extra cost).
2. **Agent SDK path** — Instar runs `claude -p "prompt"` as a one-shot command. After 2026-06-15 this bills against the prepaid $200/month Agent SDK credit pot. Costs the same as the API, but the money is already paid for as part of your subscription.
3. **Raw API path** — Instar talks directly to `api.anthropic.com` over HTTP. This bills against your separate Anthropic API account at full API rates with no subscription protection.

The rules:
- **Rule 1:** Every code path must be able to fall back to the subscription path. If something only works on the Agent SDK path, that's a bug.
- **Rule 2:** When the subscription path is NOT being used, prefer the Agent SDK path. The raw API path is forbidden as a routine path.

The reason: a runaway loop on the raw API can drain real money fast. A runaway loop on the subscription path tops out at your subscription limit. A runaway loop on the SDK credit pot tops out at $200/month. Subscription path is the floor that's always available; SDK is the prepaid accelerator; raw API is the danger zone we never normalize.

---

## Rule 1 — Subscription-backed fallback is mandatory

Every code path that talks to Claude MUST be able to run through a subscription-backed interactive session — the long-lived `claude` REPL maintained by the `anthropic-interactive-pool` adapter, drawing from the Max subscription.

If an option a caller passes (e.g. `maxTokens`, `temperature`, `--max-turns`, mid-stream interrupt with structured cancellation) cannot be honored on the subscription path, the option is downgraded to **advisory**. The path is not the option. Callers that need hard bounds implement them caller-side (post-hoc truncation, regex extraction, sampling-temperature workarounds).

### Practical consequences

- New substrate primitives must be implementable by the interactive pool. If they can't be, they're either optional (capability-flagged) or they don't exist.
- The primitive interface documents `maxTokens` and `temperature` as advisory hints. Adapters that can't honor them say so via capability flags; they do NOT throw.
- Tests don't assert "maxTokens was honored." They assert "the call succeeded" and let callers verify their own truncation.

### Why

The subscription path is the floor that's always available. Even when the Agent SDK credit pot drains to zero, even when raw API calls would fail for lack of funding, the REPL pool keeps working as long as the Max subscription is active. That's the property that makes Instar economically resilient to vendor pricing changes. Everything else is layered on top of that floor.

---

## Rule 2 — Direct Anthropic API is forbidden as a routine path

All code paths that aren't running through the interactive subscription session MUST go through the Claude Agent SDK credits — i.e. `claude -p` (or the published `@anthropic-ai/claude-agent-sdk` package, which delegates to the same path).

Direct calls to `api.anthropic.com` (Messages API, Completions API, Files API) are **forbidden as routine paths**. Treat any direct-API call as a critical bug to be fixed before ship.

### Practical consequences

- `OneShotCompletion` on the `anthropic-headless` adapter routes through `claude -p`, not the Messages API — even when this means dropping options the CLI can't pass.
- `StallTriageNurse`, `PipeSessionSpawner`, and any other code that today does `fetch('https://api.anthropic.com/...')` are violations to be fixed. Reroute through `claude -p` or the REPL pool.
- The substrate's `OneShotCompletion` interface does NOT have an "implementation: raw-api" mode. If a future option appears that can only be honored via raw API, the option doesn't ship — see Rule 1.
- Audit gate for new code: grep for `api.anthropic.com`, `messages.create`, `anthropic.Anthropic` in any PR touching Anthropic-adjacent code. Block if found.

### Exceptions

There is exactly one defensible exception: lifecycle operations that have no CLI equivalent and don't bill per-token (e.g. checking `/api/oauth/usage` to read quota state, which is what `UsageMeterProvider` does today). These are read-only, fixed-cost, observability-only calls. They are NOT routine inference paths.

If a future need genuinely cannot be served by either subscription path or SDK path, the resolution is to escalate the design — not to quietly add a raw-API path.

### Why

The raw API path bills against the user's separate Anthropic API account at full standard API rates. Two failure modes are catastrophic:

1. **Runaway cost.** A misbehaving loop on the raw API has no spending cap unless one is explicitly configured. The subscription path tops out at the Max subscription's session limit (work just stops). The SDK credit path tops out at $200/month (work falls back to subscription or stops). The raw API path tops out at the API account's funded balance, which is the user's bank account.

2. **No subscription protection.** Subscription / SDK calls share Anthropic's subscription-grade rate-limit policies, retry handling, and operational protections. Raw API calls don't — they're billed and rate-limited as commercial API consumers, which means a different operational envelope than Instar is designed for.

Justin runs five Max 20x subscriptions specifically to keep Instar's compute inside the subscription billing envelope. Routing around that envelope defeats the entire economic and architectural rationale of the project.

---

## Routing default (downstream of these rules)

The cost-aware routing policy in Phase 5 defaults to:

1. **Subscription path (REPL pool) is the floor.** Always available, always works (subject to Max session limits). Used when the SDK credit pot is exhausted, when an option needs guarantees the SDK path can't honor, or when explicit policy says so.
2. **SDK credit path (`claude -p`) is the prepaid accelerator.** Preferred when credits are available, because it's prepaid as part of your subscription cost. When credits drain, fall back to subscription path automatically.
3. **Raw API is never default.** Not in routing, not in fallback, not in emergency.

A safety margin (default 10% of monthly credit) keeps headroom in the SDK pot for high-priority work even after routine work has consumed most of it. When the pot drops below the margin, the router preemptively switches new work to the subscription path.

---

## Open question (2026-05-15)

Justin's framing in the originating message was: "all OTHER paths must go through the Claude Agent SDK credits, NOT the direct API." This rules raw API out, but it leaves ambiguous whether the default ordering is "drain SDK first, fall back to subscription" (my earlier proposal) or "prefer subscription, use SDK as accelerator when it has clear capacity" (the inverse).

Both are consistent with the two rules. The former gets more total work done per dollar of credit (you've already paid for the $200 either way; might as well use it). The latter inverts the default to match the "subscription is mandatory" framing more literally — SDK as a paid-for bonus rather than the primary path. Tied to whether you think of the $200 pot as "credits I should use up because I paid for them" or "an emergency accelerator I should preserve."

Waiting on Justin's call before locking the routing default. The decision shows up in `RoutingPolicy` defaults and in the cost-aware policy implementation in Phase 5.

---

## How this document is enforced

- **At design time:** every new substrate primitive's review checks both rules. If the interactive pool can't serve it, it's either capability-flagged or rejected.
- **At review time:** PRs touching Anthropic-adjacent code grep for `api.anthropic.com` and direct-API SDK usage. Hits are treated as critical bugs.
- **At runtime:** the cost-aware routing policy enforces the defaults. The raw API path simply does not exist in the substrate as a routable destination.

These rules are foundational. They predate any specific phase plan and override any earlier proposal that conflicts with them.
