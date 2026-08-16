# Side-Effects Review — Pre-Prompt Memory Recall

Spec: `docs/specs/OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.md`
ELI16: `docs/specs/OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.eli16.md`
Driving approval: Telegram topic 9003, Justin, 2026-05-13.

## What's IN

1. New `src/core/PromptBuildRecall.ts` — pure class encapsulating cache, circuit breaker, result formatter, search invocation. Synchronous `recall()` method.
2. New `tests/unit/PromptBuildRecall.test.ts` — 15 unit tests covering every `source` outcome, cache TTL behavior, circuit breaker open/close lifecycle, recall caps, and reset.
3. New HTTP route `POST /internal/prompt-recall` in `src/server/routes.ts`. Body `{userMessage, sessionId?}`; returns the recall result. Returns `source: 'no-recall'` if the singleton isn't wired.
4. New singleton wiring in `src/commands/server.ts` — dynamic import behind `config.promptBuildRecall.enabled` gate; cold-path cost is zero.
5. New `.claude/hooks/instar/before-prompt-recall.js` — Claude Code UserPromptSubmit hook script. Reads stdin, POSTs, echoes contextText to stdout. Best-effort: any error path exits 0 with no output.
6. Default config: `enabled: false`, `maxRecallChars: 1200`, `maxRecallResults: 5`, `cacheTtlMs: 15000`, `circuitBreakerMaxFailures: 3`, `circuitBreakerCooldownMs: 60000`, `recallTimeoutMs: 2000`, `minConfidence: 0.5`.

## What's DEFERRED

- **Six prompt styles** (`balanced`, `strict`, `contextual`, `recall-heavy`, `precision-heavy`, `preference-only`) from OpenClaw. One `minConfidence` knob covers v1; multiple bias settings can be added if real-world recall quality demands.
- **Sub-agent invocation.** OpenClaw spawns a recall sub-agent with a tool allowlist. We call `SemanticMemory.search` directly — simpler, no nested-process surface. Implicit allowlist: read-only memory.
- **Per-call audit log.** Hook-side relies on Claude Code's standard event recording. Server-side has no dedicated audit file; the result object's `source` field is observable via the endpoint response. A dedicated jsonl can be added if observability gaps surface.
- **Auto-installation in existing agents' `.claude/settings.json`.** Hook script is shipped in the instar repo; operators copy it and add the settings entry. A migration path for existing agents is a follow-up if usage grows.
- **Six confidence/style modes per consumer.** Each skill could declare its preferred recall bias. Out of scope for v1.

## Over-block analysis

The new behavior:
- Adds one synchronous HTTP call (≤2 s) to each UserPromptSubmit hook execution.
- Injects up to 1200 chars + `<active_memory_recall>` framing tags into the prompt context per turn.
- Reads from `SemanticMemory` (FTS5/vector) — read-only; no writes.

Cap enforcement is in `formatContextBlock`:
- Entries are added one at a time; if the next entry would exceed `maxRecallChars`, it is **dropped** (not truncated). Header and footer always fit.
- `maxRecallResults` caps the search itself before formatting.

Edge: if a SemanticMemory entry has an extremely long name + description (> maxRecallChars), the first entry might be the only one rendered, and even it may be too long if formatted naively. The current implementation drops entries that don't fit but the FIRST entry is added before the size check ─ this is intentional, otherwise zero-output is a worse failure mode than a slightly-over-cap output. The cap is a soft target. Asserted in the maxRecallChars test (`length ≤ 400` for a configured `400` cap with 150-char descriptions).

## Under-block analysis

When SemanticMemory returns no results, the result is `source: 'empty'`, cached, and the hook emits nothing. This is the correct under-block — there's nothing relevant, so injecting an empty recall block would just spend tokens.

When the circuit is open, recall short-circuits to empty without searching. This is the correct under-block during fault recovery.

## Level-of-abstraction fit

- **Single class** with focused responsibility. All state (cache, circuit) is encapsulated.
- **One route, one hook script.** No new HTTP middleware, no changes to the existing hook event flow.
- **Singleton via globalThis stash** matches the existing `__instarCompactionRecover` pattern. Trade-off: keeps the ctx interface stable in this PR, but adds a second usage of the global-stash pattern. If a third usage emerges, the pattern should be promoted to a proper registry.

## Signal-vs-authority compliance

- **Cache key derivation** is deterministic (lowercase trim, sha1 truncated). Not a security boundary — only a dedupe key. Safe.
- **Circuit breaker** is local (in-memory). After cooldown, recall is willing to try again; no need for an authority module to clear it.
- **Memory write authority is unchanged.** This is a read-only consumer of SemanticMemory. No writes.

## Interactions

- **`SemanticMemory.search`**: the only external dependency. The `minConfidence` filter is passed through; existing search options are untouched.
- **`UserPromptSubmit` hook**: instar's `.claude/settings.json` doesn't currently include this hook (it has SessionStart, PreCompact, etc.). The new hook script lives in `.claude/hooks/instar/` but is NOT wired into the local settings.json by this PR — operators wire it after evaluating the behavior. This avoids changing how the instar dev repo itself behaves until the feature is validated in user agents.
- **`HookEventReceiver`**: unaffected. UserPromptSubmit events are recorded by the existing hook-event-reporter for telemetry purposes; this PR doesn't change that.
- **`PromptBuildRecall` is not the same as `WorkingMemoryAssembler`**. The latter builds the long-form working-memory context for session resumes; this is a per-prompt fast-path recall. The two don't overlap; they could compose in a future v2.

## Rollback cost

- Set `promptBuildRecall.enabled: false`. Server stops constructing the singleton on next restart. Hook returns `source: 'no-recall'` with empty contextText. Claude Code sees no injected text.
- Remove the hook entry from agents' `.claude/settings.json`. Hook never fires.
- Either alone is a complete rollback.
- No state files written, no schema migrations.

## CI surface

Touched:
- `src/core/PromptBuildRecall.ts` — new file, 15 unit tests cover the surface.
- `src/server/routes.ts` — one new route, no changes to existing routes.
- `src/commands/server.ts` — ~14 lines of conditional wiring, dynamic-import gated.
- `.claude/hooks/instar/before-prompt-recall.js` — new node script; not loaded by tests.

No CI workflow changes. No husky changes.

## Open questions

None for v1. The design is fully constrained by:
- OpenClaw audit §3.
- Justin's approval of T2.2 in the Round 2 scope (Telegram 9003).
- Claude Code's available hook surface (UserPromptSubmit is the closest match for `before_prompt_build`).
