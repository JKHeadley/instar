# API Safety Guard — Plain-English Overview

This is the plain-English companion to `API-SAFETY-GUARD-SPEC.md`. Read this first.

## What we're changing

Instar has two ways to talk to Claude. One uses your Claude subscription (no extra cost — it's the same one your sessions use). The other uses the metered Anthropic API, which charges per call. The subscription one is the default and the API one is supposed to be opt-in.

Today there's one place where instar can quietly slip from "subscription" to "metered API" without you noticing. If your Claude CLI breaks for any reason — an expired login, a corrupted install, a transient network problem — AND you happen to have `ANTHROPIC_API_KEY` set in your shell environment for some other tool, instar treats that key as "well, you have it, so let's use it" and starts spending real money on every internal LLM call. Sentinel checks, tone-gate reviews, stall-triage, input-guard: all of it billed.

You'd find out from the Anthropic billing dashboard, not from instar.

This change removes that silent path. From now on:

- **Subscription only**, unless you explicitly say otherwise. Even if your CLI is broken and a key is sitting in your environment, instar will degrade to its non-LLM heuristics rather than spend money behind your back.
- **API mode requires two flags in your config**, not one. You have to set both `intelligenceProvider: "anthropic-api"` and `intelligenceProviderConfirmed: true`. A single typo or stale copy-pasted config field can't engage API mode on its own.
- **When API mode IS active, you see a billing banner** in the server startup log every time. Yellow, boxed, hard to miss. The line literally reads "BILLING: Anthropic API mode is ACTIVE — per-call charges apply."

## What you'll see day to day

Nothing changes for the vast majority of users — you were already on subscription, you'll stay on subscription. The only people who see new behavior are:

1. **Anyone whose CLI breaks AND has an `ANTHROPIC_API_KEY` in their environment.** Before: instar silently switched to billed API. Now: instar degrades to heuristic-only mode (tone-gate, sentinel, input-guard run with their non-LLM fallbacks), prints a yellow log line saying "ANTHROPIC_API_KEY detected but not in use because subscription-by-default," and routes a degradation alert through the normal channels. Fix the CLI to restore full intelligence.

2. **Anyone who deliberately wants API mode.** Before: one config field was enough. Now: you need two fields, and you'll see a billing banner on every server start. Set `intelligenceProvider: "anthropic-api"` and `intelligenceProviderConfirmed: true` in `.instar/config.json` and have `ANTHROPIC_API_KEY` in your environment.

3. **Anyone who copy-pasted a config template that happened to include `intelligenceProvider: "anthropic-api"`.** Before: that single field engaged API mode silently. Now: instar prints a warning at startup ("API mode requested but intelligenceProviderConfirmed is missing — using Claude CLI subscription") and uses subscription regardless. Two-flag rule means the typo or template artefact can't accidentally cost you money.

## What's under the hood

A small new file `src/core/selectIntelligenceProvider.ts` is the only place in instar that decides which LLM provider to use. The decision is a pure function — no side effects, easy to unit-test. The startup logic in `src/commands/server.ts` just calls this function and renders the result.

Fourteen unit tests assert every cell of the decision table — including the critical one: "CLI broken, API key present, no opt-in → provider is null, no silent API use." If anyone ever tries to re-add the silent fallback, the test fails.

## What's NOT changing

- The `AnthropicIntelligenceProvider` class still exists. People who actually want API mode can still use it.
- No other LLM call sites change. The shared-intelligence chokepoint is the only one affected.
- No new permissions, no new state files, no new endpoints. The change is purely how the existing provider is selected.

## How to push back

If you ever want the old silent-fallback behavior back, you'd be reversing the principle "by default Instar should only run on subscription." That's a values change, not a code rollback. The technical rollback is one revert commit, but I'd push back hard before doing it — the original behavior was a hidden spend path and removing it is a security win.

If you find the two-flag opt-in too clunky for your real API-mode use, we can revisit. The current design is deliberately a tiny bit annoying for opt-in users so it's structurally impossible for accidental users.

## Reference

- Full spec: `API-SAFETY-GUARD-SPEC.md`
- Side-effects review: `upgrades/side-effects/api-safety-guard.md`
- Approval: Telegram topic 9003, Justin, 2026-05-13
