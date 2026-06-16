# Provider-Fallback Default Policy — internal components run off Claude by default

## What Changed

Instar's internal background LLM work — sentinels, gates, and reflectors — now runs **off Claude by default** when the agent has another provider CLI installed. The agent picks the first available provider in the preference order **Codex → PI → Gemini → Claude**, with the existing failure-swap engine falling down the chain and Claude as the true last resort. A new bounded per-attempt timeout (`intelligence.swapAttemptTimeoutMs`, default 5s) keeps the longer chain from stacking slow providers into the very stall it exists to prevent — a timed-out provider is abandoned and the next one is tried.

The `job` category is deliberately **excluded** (cost-bearing background jobs stay on the agent default). Operators retain full control: an explicit `sessions.componentFrameworks` block wins verbatim, and setting it to `{}` reverts to exactly the prior behavior.

## Evidence

- `src/core/internalFrameworkDefault.ts` (new) — the active-filtered policy resolver + the `INTERNAL_FRAMEWORK_PREFERENCE` constant.
- `src/core/IntelligenceRouter.ts` — `Promise.race` per-attempt swap timeout + `swap-attempt-timeout` degrade signal; fail-open, fail-closed-if-all-down preserved.
- `src/commands/server.ts` — boot active-set probe + the live-read, layered `resolveConfig` (preserves CartographerSweep's runtime override).
- 31 new tests (3 unit files 24 green + integration + e2e/wiring-integrity); tsc clean; 14 lints clean; second-pass review concurred.
- Spec `docs/specs/provider-fallback-default-policy.md` — CONVERGED over 4 review rounds (6 internal lenses + codex/gemini external + conformance gate each).

## What to Tell Your User

If your agent has Codex (or another non-Claude CLI) installed, its background safety checks now run off Claude by default — so a Claude outage or a maxed weekly quota can no longer freeze your sentinels, gates, or message delivery. You can see which provider is serving each check in the routing and metrics views, and you can override the routing or revert it entirely any time with one config setting. If you only run Claude, nothing changes — by design.

## Summary of New Capabilities

- Internal sentinels, gates, and reflectors auto-route off Claude via an active-filtered fallback chain (Codex then PI then Gemini then Claude), so no single provider's bad night can strangle the agent.
- A tunable per-attempt swap timeout keeps the fallback chain fast.
- A new degrade signal makes a slow provider being abandoned visible in the existing observability surfaces.
