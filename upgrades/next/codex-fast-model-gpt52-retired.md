# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Re-points the Codex `fast` model tier off the now-retired `gpt-5.2`.

**The bug (live, fleet-wide).** As of 2026-06-03 OpenAI retired `gpt-5.2` from the
ChatGPT-account Codex surface — `codex exec --model gpt-5.2` now returns HTTP 400
*"The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account."*
Both Codex model-tier maps hardcoded the `fast`/`haiku` tier to `gpt-5.2`:

- `src/providers/adapters/openai-codex/models.ts` (`TIER_TO_MODEL.fast`) — the intel /
  one-shot path (reviewers, sentinels, CommitmentSentinel, tone-gate, classification).
- `src/core/frameworkSessionLaunch.ts` (`resolveModelForFramework`, codex-cli) — the
  session-launch path.

So **every cheap Codex call on every Codex agent was silently failing** — observed live as
`[CommitmentSentinel] LLM detection failed: … --model gpt-5.2 …` on codey, repeating.

**The fix.** Both maps now resolve `fast`/`haiku` to `gpt-5.4-mini` — the cheapest model
still accepted on the ChatGPT account (empirically re-probed 2026-06-03: `gpt-5.2` rejected,
`gpt-5.4`/`gpt-5.4-mini` accepted). `gpt-5.4-mini` is already the `balanced` choice, so the
`fast` and `balanced` tiers now coincide.

**Trade-off (intentional, documented).** `gpt-5.2` was the only *non-reasoning* model; with it
retired there is no cheaper option, so cheap Codex calls now run on a reasoning model (higher
token burn per call). A working model beats a 400-ing one, but this raises cheap-call quota
pressure on Codex agents until the structural follow-up lands.

**Follow-up (not in this patch).** Drift-resilience: validate the resolved model against a
known-good set and auto-fall-back on a "not supported" 400, so the *next* model retirement
self-heals instead of breaking the fleet (the second such break after the 2026-04-14 `-codex`
retirement). Tracked as a follow-up in `models.ts`.

## What to Tell Your User

Nothing required — this is an internal Codex reliability fix (agent-only). Codex agents'
cheap internal calls (commitment detection, tone gating, classification) were failing because
a model name they used got retired; they now use a supported model again.

## Summary of New Capabilities

None — bug fix only. No new routes, config, or surfaces.

## Evidence

- Live failure: codey `logs/server.log` — `[CommitmentSentinel] LLM detection failed: Codex CLI
  error: … codex exec --model gpt-5.2 …` + the codex 400 `invalid_request_error`.
- Empirical re-probe (2026-06-03, Justin's ChatGPT subscription): `gpt-5.2` → 400 rejected;
  `gpt-5.4` and `gpt-5.4-mini` → accepted.
- Tests: `tests/unit/codex-model-tier-resolution.test.ts` (new — pins both resolvers + a
  retired-`gpt-5.2` regression guard across all tiers); updated `session-manager-behavioral`
  and `StallTriageNurse` assertions (haiku/fast → `gpt-5.4-mini`).
