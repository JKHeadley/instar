---
review-convergence: "2026-05-15T00:00:00Z"
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-05-15"
---

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

## Routing default (locked 2026-05-15 by Justin)

The cost-aware routing policy in Phase 5 defaults to:

1. **SDK credit path (`claude -p`) is preferred when credits are available.** Drain the prepaid $200/month pot first — you've already paid for it as part of the subscription, so wasting it is a real loss. Routine inference work goes here by default.
2. **Subscription path (REPL pool) is the fundamental floor.** Always available, always works (subject to Max session limits). Activates automatically when SDK credits exhaust, when an option needs guarantees the SDK path can't honor, or when the safety-margin policy diverts work preemptively. Rule 1 guarantees every code path can run on this floor; the routing default is just an optimization on top.
3. **Raw API is never default.** Not in routing, not in fallback, not in emergency.

A safety margin (default 10% of monthly credit) keeps headroom in the SDK pot for high-priority work even after routine work has consumed most of it. When the pot drops below the margin, the router preemptively switches NEW work to the subscription path; in-flight SDK calls finish on their original path.

The framing matters: SDK credits are the prepaid accelerator (use them while they last); the subscription path is the bedrock (always there, always sufficient, slower but unbounded). Inverting that — preserving SDK credits and defaulting to subscription — would leave $200/month of prepaid budget unused every month. That's wasteful, not safe.

---

## Scope clarification — what "Anthropic traffic" means (locked 2026-05-15)

**Both rules govern Anthropic-API-bound traffic specifically, NOT "any model call from anywhere in the stack."**

This distinction matters because of a third architectural path that surfaced during the Phase 5a research: the **translation-proxy pattern**, where the Claude Code CLI runs unchanged but its `ANTHROPIC_BASE_URL` is pointed at a local proxy that translates the Anthropic Messages API shape to a different provider's API and dispatches the request there. The most prominent implementation is [`Alishahryar1/free-claude-code`](https://github.com/Alishahryar1/free-claude-code) (24.8k stars, MIT, 10 backends). Documented in `09-framework-fitness-catalog.md` under the Translation-proxy pattern section.

Under the proxy pattern, traffic that LOOKS like Anthropic-bound from Claude Code's perspective is actually dispatched to DeepSeek's API, Kimi's API, OpenRouter, Ollama, etc. **No Anthropic API call is made.** Rules 1 and 2 do not apply to that path — it is neither subscription-driven nor direct-Anthropic. It's a Rule-1/2-exempt third route.

The three Anthropic-stack paths Instar treats distinctly:

| Path | Subject to Rule 1 (subscription floor)? | Subject to Rule 2 (no direct API)? | Notes |
|---|---|---|---|
| **Subscription path** (REPL pool, `claude` interactive) | YES — IS the floor | n/a — not the API path | Mandatory bedrock. Always available. |
| **SDK credit path** (`claude -p` headless) | YES — every primitive must also work on the subscription path | YES — this IS the routable Anthropic API path; constrained to Agent SDK credit only | Prepaid accelerator. Drain first when available. |
| **Direct Anthropic API** (raw Messages API) | n/a | YES — explicitly forbidden | Banned. Not a routable destination. |
| **Translation-proxy** (Claude Code CLI → non-Anthropic backend via `ANTHROPIC_BASE_URL` override) | n/a — not Anthropic traffic | n/a — not Anthropic traffic | Rule-exempt third route. Instar must be FULLY COMPATIBLE with this routing (treat it like any other framework+model pairing) but does NOT bake the proxy into its core path. The proxy is user-installed and any ToS implications are the user's choice. |

**Compatibility, not endorsement.** Instar's design must accommodate users who configure `ANTHROPIC_BASE_URL` to point at a proxy — the substrate should not break, error, or treat that configuration as invalid. The catalog's framework selection layer (Phase 5b) treats "Claude Code + proxy" as a valid framework+model pairing that users may pick. But Instar itself does not ship, recommend, or default to the proxy.

---

## How this document is enforced

- **At design time:** every new substrate primitive's review checks both rules. If the interactive pool can't serve it, it's either capability-flagged or rejected.
- **At review time:** PRs touching Anthropic-adjacent code grep for `api.anthropic.com` and direct-API SDK usage. Hits are treated as critical bugs.
- **At runtime:** the cost-aware routing policy enforces the defaults. The raw API path simply does not exist in the substrate as a routable destination.

These rules are foundational. They predate any specific phase plan and override any earlier proposal that conflicts with them.
