---
slug: api-safety-guard
title: API Safety Guard — Subscription-by-Default Enforcement
review-convergence: true
approved: true
approved-by: justin
approved-at: 2026-05-13
approval-channel: telegram/9003
---

# API Safety Guard — Subscription-by-Default Enforcement

## TL;DR

Instar must NEVER silently fall back to billed Anthropic API mode. Today there is one path in `src/commands/server.ts` that does exactly that: if the Claude CLI is unavailable and `ANTHROPIC_API_KEY` is present in the environment, the server silently uses the API "as a last resort." This spec removes that path, strengthens the opt-in (two required flags), and adds a visible billing banner when API mode is engaged. Codified by Justin in topic 9003 on 2026-05-13: "By default Instar should only run on subscription."

## Problem

`src/commands/server.ts` lines 2081–2092 (pre-fix):

```ts
if (!sharedIntelligence && explicitIntelligenceProvider !== 'anthropic-api') {
  // Last resort: if user has API key but didn't explicitly opt in, use it rather
  // than leaving the agent flying blind.
  try {
    const apiProvider = AnthropicIntelligenceProvider.fromEnv();
    if (apiProvider) {
      sharedIntelligence = apiProvider;
      intelligenceSource = 'Anthropic API (CLI unavailable — last resort)';
    }
  } catch { /* no API key available */ }
}
```

Failure mode: a user has `ANTHROPIC_API_KEY` set in their shell rc for some other tool. Their Claude CLI breaks for any reason — OAuth expired, install corruption, network hiccup. Instar silently starts spending real money on every LLM-gated feature (sentinel, input guard, tone gate, stall triage, coherence checks). The user finds out via their Anthropic billing dashboard.

The rationale comment ("degrading to heuristics is worse than using whatever LLM is available") encodes a trade-off the principal rejects: spending money silently is worse than degrading.

## Design

### Three changes, one chokepoint

The provider-selection logic moves out of inline server-startup code into a pure, testable function `selectIntelligenceProvider()` (new file `src/core/selectIntelligenceProvider.ts`). All three safety changes land in that function so the rules are unit-testable.

### Rule 1 — Remove the silent fallback

The last-resort branch is deleted. If neither (a) confirmed API opt-in nor (b) Claude CLI succeeds, the result is `{ provider: null, source: 'none' }`. Caller degrades gracefully. **Never silent API use, regardless of environment.**

When the selection returns `provider: null` AND an `ANTHROPIC_API_KEY` was detected in the environment, the function returns `apiKeyIgnored: true` and emits a warning explaining why the key was not used. The caller surfaces the warning via the existing console + DegradationReporter pipeline.

### Rule 2 — Strengthen the explicit opt-in (two flags required)

Setting `intelligenceProvider: "anthropic-api"` alone is no longer sufficient. The user must also set `intelligenceProviderConfirmed: true` in config.json. Reasoning: a single field is too easy to set accidentally (copy-pasted config, sample template, typo correction). Two fields make accidental engagement of paid mode structurally implausible — the user has to have read at least one warning explaining the second flag.

Selection table:

| `intelligenceProvider` | `intelligenceProviderConfirmed` | `ANTHROPIC_API_KEY` | Result |
|------------------------|--------------------------------|---------------------|--------|
| unset                  | any                            | any                 | CLI (or none if CLI fails) |
| `"anthropic-api"`      | unset / false                  | any                 | CLI + warning; API REFUSED |
| `"anthropic-api"`      | `true`                         | unset               | CLI + warning; API not possible |
| `"anthropic-api"`      | `true`                         | present             | **API mode active** (banner + log) |

### Rule 3 — Visible billing banner

When API mode is active, the server startup log prints a yellow boxed banner:

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │ BILLING: Anthropic API mode is ACTIVE — per-call charges apply      │
  │ To switch back to subscription, unset intelligenceProvider in config│
  └─────────────────────────────────────────────────────────────────────┘
```

The banner is impossible to miss in any terminal that respects ANSI colors, and is on stdout (not stderr) so it lands in the standard server log.

## Files touched

| File | Change |
|------|--------|
| `src/core/selectIntelligenceProvider.ts` | NEW — pure selection function with the safety rules |
| `src/commands/server.ts` | replace inline provider-selection block (lines 2050–2114) with a `selectIntelligenceProvider()` call + warning/banner rendering |
| `tests/unit/selectIntelligenceProvider.test.ts` | NEW — 14 assertions covering every cell of the selection table plus failure modes |
| `upgrades/NEXT.md` | append release note |
| `upgrades/side-effects/api-safety-guard.md` | NEW — comprehensive side-effects review |
| `package.json` + `package-lock.json` | version bump |

## What is NOT in this spec

- **Telegram alert on first API-mode startup**: deferred. The visible startup banner + every-startup yellow log already provide loud signal. Adding a Telegram alert needs a per-machine "acknowledged" state file and integration with the attention queue — orthogonal scope.
- **Removing `AnthropicIntelligenceProvider`**: out of scope. The provider remains available for explicit opt-in users; only the silent path is removed.
- **Other LLM call sites**: this spec covers the shared-intelligence chokepoint. A separate audit will sweep `StallTriageNurse`, `reflect.ts`, and `relationships.intelligence` to ensure they all read from the shared provider (most already do via the same selection layer; spot-checked above).

## Risk assessment

- **Over-block risk**: any operator who previously relied on the silent fallback (had `ANTHROPIC_API_KEY` in env, broken CLI, and was unknowingly billed) will now see degraded LLM features instead. This is the *intended* behavior change — the silent fallback was the bug.
- **Under-block risk**: if a user accidentally sets BOTH flags (e.g., copy-pasted from a doc), they could still engage API mode. The visible banner mitigates: they will see the billing warning on every server restart. Future tightening could require an interactive confirmation, but per-startup banner is sufficient for v1.
- **Latency**: no change. The selection runs once at startup.
- **Spend**: strictly downward — removes a hidden spend path.
- **Rollback**: this is a security fix, not a feature flag. Rollback = revert the commit. Operators who want the old silent-fallback behavior back are explicitly outside Justin's stated security stance ("By default Instar should only run on subscription"); they would need to fork.

## Acceptance criteria

1. `selectIntelligenceProvider()` is the sole logic location for shared-intel-provider selection.
2. Selection table above is exhaustively covered by unit tests; every cell asserted.
3. `apiKeyIgnored: true` surfaces when an env key is present but opt-in is absent.
4. Server startup with both confirmed flags + key → API mode + banner printed.
5. Server startup with only `intelligenceProvider: "anthropic-api"` and no confirmation → warning + CLI fallback; API NOT used even if key is present.
6. Server startup with CLI failing + env key present + no opt-in → `provider: null`; warning printed; **NO silent API use** (assertion in unit test).
7. CI green on all shards.
8. ELI16 companion published at `docs/specs/API-SAFETY-GUARD-SPEC.eli16.md`.
