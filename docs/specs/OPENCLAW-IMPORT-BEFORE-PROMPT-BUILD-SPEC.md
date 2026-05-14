---
slug: openclaw-import-before-prompt-build
title: Pre-Prompt Memory Recall (`before_prompt_build` analog)
review-convergence: true
approved: true
approved-by: justin
approved-at: 2026-05-13
approval-channel: telegram/9003
---

# OpenClaw Import — Pre-Prompt Memory Recall

**Project**: openclaw-imports
**Item**: T2.2 (Round 2 / Tier 2)
**Source**: OpenClaw audit §3 (active-memory plugin); `extensions/active-memory/index.ts`
**Architecture**: UserPromptSubmit hook calling a bounded server-side recall primitive.

## TL;DR

Adopt OpenClaw's `before_prompt_build` recall pattern as an instar primitive: when the user submits a prompt, instar runs a bounded memory-recall pass and injects the result as additional context before the agent's reply. Implementation rides Claude Code's `UserPromptSubmit` hook, which is the closest available hook surface.

## Problem

Today instar's grounding is patchworky. Some skills explicitly check memory before replying (e.g., relationship-grounding); others don't. Each skill that wants to ground runs its own search logic with its own settings. There's no single, consistent "before this reply, what does memory say?" pass.

User-visible symptom: response quality varies. The agent will sometimes reference earlier context perfectly and sometimes reply as if it has none. The user can't predict which.

## Reference: OpenClaw's design

OpenClaw's `extensions/active-memory/index.ts` (3042 lines) implements a `before_prompt_build` hook that runs a bounded recall sub-agent before each eligible prompt. Key properties:

- Tool allowlist: `[memory_recall, memory_search, memory_get]`. Recall is read-only.
- Bounded budget: cap on tokens, on number of results, on time spent.
- Circuit breaker: consecutive timeouts open the breaker for a cooldown window.
- Cache TTL: identical recent queries dedupe.
- Injected as a system-prompt prefix wrapped in `<active_memory_plugin>…</active_memory_plugin>`.
- Six prompt styles (`balanced`, `strict`, `contextual`, `recall-heavy`, `precision-heavy`, `preference-only`) — recall bias is named, not a single threshold knob.

For instar we adopt the bounded-recall + cache + circuit-breaker pattern. Prompt styles are deferred; v1 uses a single `minConfidence`-gated search against `SemanticMemory`.

## Design

### Three pieces

1. **`PromptBuildRecall` class** (`src/core/PromptBuildRecall.ts`) — pure primitive with synchronous `recall(opts)` returning `{contextText, source, elapsedMs, resultsCount, cacheKey}`. Owns the cache, the circuit breaker, the result formatter. Testable in isolation.

2. **HTTP endpoint** `POST /internal/prompt-recall` (`src/server/routes.ts`) — body `{userMessage, sessionId?}`, returns the recall result. Reads the singleton instance from `globalThis.__instarPromptBuildRecall`. If the singleton isn't wired (server config has `promptBuildRecall.enabled: false`), returns `source: 'no-recall'` with empty contextText.

3. **`UserPromptSubmit` hook script** (`.claude/hooks/instar/before-prompt-recall.js`) — reads the user's prompt from stdin, POSTs to the endpoint, echoes the returned `contextText` to stdout. Claude Code injects the stdout as additional context before the upcoming turn.

### Config knob

```jsonc
{
  "promptBuildRecall": {
    "enabled": false,                  // default off — opt-in
    "maxRecallChars": 1200,            // cap on injected context size
    "maxRecallResults": 5,             // cap on number of memory entries
    "cacheTtlMs": 15000,               // dedupe window for identical queries
    "circuitBreakerMaxFailures": 3,
    "circuitBreakerCooldownMs": 60000,
    "recallTimeoutMs": 2000,           // per-call timeout (hot path)
    "minConfidence": 0.5               // SemanticMemory filter
  }
}
```

Default `enabled: false`. Operators opt in after watching audit (well — this primitive itself doesn't audit per-call; observability is via Claude Code's standard hook event recording).

### Injected block shape

The `contextText` block emitted by the hook:

```
<active_memory_recall>
- entity-name-1: short description first line
- entity-name-2: short description first line
…
</active_memory_recall>
```

Capped at `maxRecallChars`. Later entries are dropped (not truncated) if they'd exceed the cap. The header/footer remain so consumers can deterministically extract the block.

### Wiring

`src/commands/server.ts` constructs the `PromptBuildRecall` instance after `semanticMemory` is wired. Behind a config gate, dynamic-imports the class, instantiates it with `{semanticMemory}`, stashes it on `globalThis.__instarPromptBuildRecall` so the route can read it without changing the AgentServer ctx interface.

### Failure modes

All recall outcomes return a typed `source` so the caller can observe:

| Source | When |
|--------|------|
| `disabled` | `config.enabled: false`. Returns immediately. |
| `no-memory` | `SemanticMemory` not wired. |
| `cached` | Identical user-message within `cacheTtlMs`. |
| `fresh` | Search succeeded with ≥1 result. |
| `empty` | Search returned 0 results. Caches the empty result to avoid re-searching. |
| `timeout` | Search took longer than `recallTimeoutMs`. |
| `circuit-open` | Breaker is open; recall short-circuits to empty. |
| `error` | Search threw. Increments circuit counter. |

## What is NOT in this spec

- **Six prompt styles** (`balanced`, `strict`, etc.). One bias setting (`minConfidence`) is enough for v1.
- **Sub-agent invocation.** OpenClaw spawns a sub-agent for recall; instar calls `SemanticMemory.search` directly. Simpler, no nested-process surface.
- **Per-skill recall biases.** A unified pass is sufficient; per-skill tuning can come later.
- **Auto-installation in existing agents.** Hook script lives in instar's own `.claude/hooks/instar/`; operators copy or symlink it into their agent's `.claude/hooks/instar/` and add a `UserPromptSubmit` entry in their agent's `.claude/settings.json`. The instar-side primitive is shipped as part of this PR; the agent-side hook install is documented in the ELI16 companion.
- **Audit log.** Hook-side: relies on Claude Code's standard hook-event logging. Server-side: each call is recorded by the existing HookEventReceiver if PostToolUse fires (it doesn't fire for hook scripts per se; this is a known limitation). A dedicated audit log can be added if observability gaps surface.

## Files touched

| File | Change |
|------|--------|
| `src/core/PromptBuildRecall.ts` | NEW — class + types + default config |
| `src/server/routes.ts` | NEW `POST /internal/prompt-recall` route |
| `src/commands/server.ts` | wire singleton behind config gate (~14 lines) |
| `tests/unit/PromptBuildRecall.test.ts` | NEW — 15 assertions over gates, cache, breaker, caps |
| `.claude/hooks/instar/before-prompt-recall.js` | NEW — UserPromptSubmit hook script |
| `upgrades/NEXT.md` | append release note |
| `upgrades/side-effects/openclaw-import-before-prompt-build.md` | NEW |
| `docs/specs/OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.md` | THIS |
| `docs/specs/OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.eli16.md` | NEW |
| `package.json` + `package-lock.json` | version bump |

## Risk assessment

- **Latency**: the hook runs synchronously on the user-message hot path. `recallTimeoutMs: 2000` caps the worst case. SemanticMemory search is sqlite-backed and typically completes in ≪100 ms. Tail latency is bounded.
- **Over-injection**: capped at `maxRecallChars: 1200` and `maxRecallResults: 5`. A bad SemanticMemory state cannot flood the prompt.
- **Spend**: zero. SemanticMemory search is local sqlite; no LLM call in this path.
- **Reliability**: circuit breaker opens after 3 consecutive errors → hot path short-circuits to empty until cooldown. A misbehaving SemanticMemory can't lock up the UserPromptSubmit hook.
- **Rollback**: set `promptBuildRecall.enabled: false`. Global stash empties on next server restart. Hook script's POST returns `source: 'no-recall'` and emits nothing — Claude Code sees no injected context.

## Acceptance criteria

1. `PromptBuildRecall` is the single chokepoint for recall logic; 15 unit tests cover every `source` outcome plus cache + breaker + caps.
2. `POST /internal/prompt-recall` returns `{contextText, source, elapsedMs, resultsCount, cacheKey}` for any well-formed body; 400 on missing `userMessage`.
3. Hook script reads stdin, POSTs, writes to stdout. Best-effort: any error path exits 0 with no stdout output.
4. Server log `Pre-prompt memory recall enabled` appears at startup when config is active.
5. CI green on all shards.
6. ELI16 companion published.
