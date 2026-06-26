# Latency-Sensitive Gate Framework Default

**Slug:** `latency-sensitive-gate-framework` · **Maturity:** 🧪 Preview (default-policy refinement) · **Audience:** agent-only

## What Changed

The provider-fallback default policy routed every internal off-Claude category
(`sentinel`, `gate`, `reflector`) onto the same codex-first primary. But the
`gate` category includes the **user-facing tone gate** — a synchronous check a
human is waiting on — and `codex-cli` is the slowest off-Claude framework (~30s),
which exceeds the 20s outbound-review budget and times the gate out (a cause of
the 2026-06-25 silent-outbound incident). The `gate` category now resolves its
default primary from a separate speed-ranked order (`pi → gemini → codex →
claude`) — the fastest *active* off-Claude framework — while `sentinel`/`reflector`
keep the codex-first load-spreading order. `failureSwap`, the gate's verdict
logic, and the F4 degrade floor are all unchanged.

## What to Tell Your User

Your replies' safety check now runs on the fastest available engine instead of
the slowest, so it stops timing out under load — one fewer cause of slow or
missing replies. Background checks are unchanged. If only one non-Claude engine is
installed, nothing changes.

## Summary of New Capabilities

- The latency-sensitive `gate` category defaults to the fastest active off-Claude
  framework (`LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE`), not the codex-first order.
- `sentinel`/`reflector`/`job`/`other` routing and `failureSwap` are unchanged.
- An explicit `categories.gate` in config always overrides the computed default.
- Single-off-Claude-framework agents and claude-only agents: byte-identical no-op.

## Evidence

- `internalFrameworkDefault.test.ts`: gate prefers fastest (pi) while sentinel
  stays codex; pi-down→gemini (the gemini-serves-when-pi-down case); both-down→codex
  (never worse than today); single-framework→no divergence. 17 unit tests pass.
- `provider-fallback-default-routing.test.ts` (integration): the gate component on
  `GET /intelligence/routing` reports the fastest active framework. 3 pass.
- `provider-fallback-default-policy-lifecycle.test.ts` (e2e): route alive, policy
  live. `tsc --noEmit` clean. 24 affected tests green.
- Side-effects review: `upgrades/side-effects/latency-sensitive-gate-framework.md`.
- Spec amendment: `docs/specs/provider-fallback-default-policy.md` §4.1.
