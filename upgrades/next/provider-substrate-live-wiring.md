---
bump: minor
---

## What Changed

The provider-portability substrate (both Anthropic adapters + the cost-aware
routing policy, on main since 2026-05-18) shipped dark: server boot installed
the routing policy with a literal `readSdkCredit: () => null` stub and
registered ZERO adapters, while every internal LLM call (sentinels, gates,
extractors — measured ~1,000 real calls / ~27M input tokens per 24h on one
agent) hardcoded `claude -p`, the path that bills the Agent SDK credit pot
after 2026-06-15 and fails with no reroute when it drains. This PR wires the
substrate into production: (1) `registerAnthropicAdapters()` at server boot —
gated (codex-only agents register nothing), idempotent (incl. concurrent
single-flight), lazy (zero spawns at boot), with a TTL-cached real credit
reader replacing the null stub; (2) a new `intelligence.subscriptionPath.mode`
config — `off` (default; byte-for-byte today's behavior, argv pinned by test)
/ `auto` (drain the prepaid SDK pot while healthy, fall back to the
subscription interactive pool when unknown/at-margin, one cross-path fallback
with DegradationReporter) / `force` (interactive pool ONLY, zero `claude -p` —
the soak + June-15 emergency lever); (3) `AnthropicSubscriptionRouter` +
`InteractivePoolIntelligenceProvider` inside the existing breaker wrap, with
the pure `decideSdkVsSubscription` decision extracted and shared so the two
routing layers cannot drift; (4) `GET /providers/registry` introspection;
(5) pool production-hardening — `model` knob (intelligence pool runs haiku),
poolSize validation, idle retirement (`maxIdleMinutes` was dead config),
on-demand growth, agent-scoped session prefix + orphan recovery at start().

## What to Tell Your User

After June 15, Anthropic changes how background AI calls are billed: the
"headless" path I use for internal housekeeping (message screening, safety
checks, summaries) starts drawing from a prepaid credit pot instead of the
flat subscription. Before this change, when that pot ran dry all my background
thinking would simply FAIL — silently. Now I have a second lane: I can run
those same internal calls through a normal interactive Claude session (the
same kind you chat with me in), which stays on the subscription. There's a
switch with three positions — today's behavior (default), automatic (use the
prepaid pot while it's healthy, switch lanes when it runs low), and
subscription-only (the June-15 emergency lever). Nothing changes for you at
this release — the switch ships in the OFF position — but the lane now exists,
is tested, and can be flipped per-agent when the billing change lands.

## Summary of New Capabilities

- Boot registration of both Anthropic providers (`headless` + `interactive
  pool`) — lazy, gated, idempotent; routing policy now reads REAL SDK credit
  state (TTL-cached) instead of a hardcoded null.
- `intelligence.subscriptionPath.mode: off | auto | force` — per-agent control
  of which Anthropic lane internal LLM calls use; `off` is pinned
  byte-for-byte to today's `claude -p` argv by test.
- `GET /providers/registry` — what is ACTUALLY registered (adapter ids +
  capability flags only), the June-15 readiness diagnostic.
- Interactive-pool hardening: configurable model (haiku for internal calls),
  poolSize validation, idle-session retirement, on-demand growth, agent-scoped
  tmux prefix + orphan REPL recovery after crashes.

## Evidence

Gap measured live on echo: ~1,000 internal `claude -p` calls / ~27M input
tokens per 24h, all unrouted (boot stub `readSdkCredit: () => null`, registry
empty — confirmed via the new `/providers/registry` on a pre-fix boot in the
e2e test). 44+ new tests across all three tiers: unit (router decision
boundaries both sides, factory argv pin, bootRegistration gating/idempotency/
laziness, pool model flag + lifecycle hardening), integration
(`providers-registry-route.test.ts` full HTTP pipeline), e2e
(`provider-substrate-live-wiring.test.ts` — production-mirroring boot:
registry populated, route 200, default-off invariance, codex-only gate,
no-spawn-at-boot). 5-agent adversarial review panel: correctness/wiring
(BLOCK→fixed: registration TOCTOU single-flight), security/cost (SHIP;
poolSize validation added), ops/scale (BLOCK→fixed: idle retirement, orphan
recovery), standards/lessons (BLOCK→fixed: Agent Awareness template +
migration parity), spec-vs-reality (SHIP — truths T1–T7 all VERIFIED).
Spec: `docs/specs/provider-substrate-live-wiring.md` (+ `.eli16.md`);
side-effects: `upgrades/side-effects/provider-substrate-live-wiring.md`.
