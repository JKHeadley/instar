# Architecture Review — Input Relay

**Review ID**: 20260327-230839 | **Round**: 1
**Reviewer**: Systems Architect
**Score**: 8/10
**Approval Status**: APPROVED WITH RECOMMENDATIONS

---

## Research Findings

Key discovery: much of the spec describes functionality that already exists in the codebase. `TelegramAdapter.relayPrompt()`, `formatPromptMessage()`, `processCallbackQuery()`, `handlePromptTextReply()`, and `pruneExpiredRelayPrompts()` are already implemented. The spec is primarily about completing the wiring from PromptGate's relay events through PresenceProxy into these existing handlers.

---

## Critical Issues

### 1. No pre-injection prompt presence verification (HIGH)
Before calling `sendKey`, the system should confirm the original prompt fingerprint is still in tmux output. If the session unstuck itself, injecting a keystroke goes into live agent context.

**Fix**: Re-fingerprint tmux state immediately before every injection.

### 2. Concurrent tap race on callback buttons (MEDIUM-HIGH)
`responded: boolean` is set after async operations. Two simultaneous button taps can both arrive before the first sets the flag. The `CallbackRegistry` one-use token is the correct atomicity gate — confirm tokens are consumed synchronously.

### 3. LLM context generation on the critical path (MEDIUM)
Relay message isn't sent until Haiku generates context (500ms–3s delay). Session is blocked the entire time.

**Fix**: Send relay immediately, edit message in-place when context arrives. Better UX, no data model changes.

### 4. PendingRelay state is in-memory only (MEDIUM)
Server restart silently drops all pending relays.

**Fix**: Write-through persistence to `pending-relays.json`.

---

## Recommendations

1. Make InputRelay a sibling module rather than embedding in PresenceProxy. Pause Tier 1-3 timers while a relay lease is active.
2. Resolve timeout value conflict — spec says 10min/30min, existing code uses 5min/10min via `relayTimeoutSeconds`.
3. The `last20Lines` must be a fresh `captureSessionOutput()` call, not `prompt.raw` (only 5 lines from quiescence gating).
4. Natural language mapping (Haiku for "go ahead" → yes) must fail closed: if Haiku fails, ask user to clarify, never inject.
5. `Map<topicId, PendingRelay>` only holds one relay per topic — multi-session sharing will drop relays. Either queue or document constraint.

---

## Scalability Assessment

Not a concern at this scale. One relay per topic, negligible LLM/API costs, trivial tmux capture overhead. Design is correct for single-agent personal use.
