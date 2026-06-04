# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**You can now run different internal components on different agentic frameworks** —
for example, keep the agent's conversation on Claude Code but route ALL of its
sentinels and gates to Codex, so that background LLM chatter stops spending your Claude
rate-limit budget. A new `IntelligenceRouter` sits at the single LLM funnel and resolves
each call's framework at call time from the calling component's category (with a
per-component override), reading config live so changes take effect without a restart.

Each framework gets its **own** circuit breaker, so a Claude rate-limit trip no longer
pauses Codex (the previous global-singleton breaker did). Model "size" is preserved
automatically — a `fast` check becomes Haiku on Claude or a small GPT model on Codex —
so nothing at the call sites changes. Fallback is circuit-aware: a missing CLI degrades
to the default framework and reports it, while a merely rate-limited framework lets the
component fall back to its own heuristic instead of stampeding the default.

This is **opt-in and absent by default** — with no `componentFrameworks` config, every
component stays on your default framework, byte-identical to before.

## What to Tell Your User

If you keep hitting rate limits on one provider, you can now spread the load: route your
background checks (sentinels and gates) to a second framework like Codex while your main
conversation stays where it is. Turn it on under sessions.componentFrameworks in your
config; check what's routed where at the intelligence/routing endpoint. With no config,
nothing changes.

## Summary of New Capabilities

- `sessions.componentFrameworks` config — route internal components by category
  (sentinel/gate/job/reflector/other) or per-component name to any enabled framework.
- `GET /intelligence/routing` — read-only: the resolved framework per known component,
  per-framework availability, and how many are routed off the default.
- Per-framework circuit breakers (true rate-limit isolation between frameworks).
- Framework-aware model-size passthrough (a routed component keeps its fast/balanced/
  capable size, mapped to the right concrete model for its framework).

## Evidence

- Converged spec (2-reviewer adversarial + integration pass that corrected the
  breaker-isolation and resolution-point design before any code was written):
  docs/specs/per-component-framework-routing.md.
- All three test tiers green: 11 unit (tests/unit/intelligence-router.test.ts — resolution
  precedence, per-framework provider-instance isolation, both fallback modes, live-config
  hot-reload, the read surface), 3 integration (200/503), 3 e2e (feature-alive on the real
  AgentServer init path + Bearer-auth + read-only). tsc clean.
- Unconfigured zero-change is proven by a unit test (no config ⇒ the default provider
  answers every call and no other provider is ever built).
