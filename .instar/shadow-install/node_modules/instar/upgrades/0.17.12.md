# Upgrade Guide — v0.17.11

<!-- bump: minor -->

## What Changed

### Input Guard — Three-Layer Input Defense

A new security system that validates message provenance before input reaches the agent session. Prevents cross-topic context injection — where a message from one conversation leaks into an unrelated session and the agent acts on it as if it were legitimate.

**Background**: On 2026-03-09, a Threadline test message was injected into an unrelated session. The session treated the injected content as legitimate user input, composed a response about the wrong topic, and sent it to the wrong audience. Input Guard prevents this class of attack.

**Architecture — Three defense layers:**

- **Layer 1 (Provenance Check)**: Deterministic tag matching. Messages with valid source tags (`[telegram:N]`, `[whatsapp:JID]`, `[dashboard:SID]`, `[AGENT MESSAGE]`) matching the session's bound topic pass instantly. Mismatched tags are blocked and alerted. Untagged messages proceed to Layer 1.5.

- **Layer 1.5 (Injection Pattern Filter)**: Regex-based detection of known injection patterns — role-switching attempts, system prompt impersonation, instruction overrides, zero-width character obfuscation. Catches obvious attacks at zero cost (<1ms). Suspicious messages are injected with a system-reminder warning.

- **Layer 2 (Topic Coherence Review)**: Async LLM review (Claude Haiku) for untagged messages that pass the deterministic filter. Runs in background — message is injected immediately, warning follows ~1s later if suspicious. Fail-open on timeout or error.

**Key design decisions:**
- Fail-open everywhere. Messages are never silently dropped. Degradation is always surfaced via attention queue.
- Dashboard input bypasses the guard entirely (uses `sendInput()` path, not `injectMessage()`).
- Unbound sessions (no topic) accept all input — the guard only activates for topic-bound sessions.
- System-reminder warnings are structurally privileged in Claude's context, making them harder for injected content to override.

**No-silent-failure guarantees:** Every fallback path logs loudly. Haiku timeouts, API key issues, config errors — all fail-open with logging. Three or more failures in 10 minutes triggers an attention queue alert.

### Input Guard End-to-End Test Suite

36 e2e tests covering all layers, action modes, realistic attack scenarios, and integration with the message injection pipeline. Validates provenance checks, injection pattern detection, security logging, and guard-disabled behavior.

## What to Tell Your User

- **"Your agent now has input protection."** A new security layer validates where messages come from before acting on them. If something gets injected from the wrong conversation, your agent will recognize it and flag it rather than blindly acting on it. This is on by default for new installs — existing agents can ask their agent to turn it on.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Input Guard (provenance + injection + coherence) | Enabled via `inputGuard.enabled` in config. Agents can configure action modes: warn (default), block, or log. |
| Security audit logging | Automatic — events written to `.instar/security.jsonl` |
| Input Guard e2e tests | `npm run test:e2e` — 36 tests covering all layers and attack scenarios |
