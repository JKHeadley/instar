# Security Review — Input Relay

**Review ID**: 20260327-230839 | **Round**: 1
**Reviewer**: Security
**Score**: 5/10
**Approval Status**: CONDITIONAL — DO NOT IMPLEMENT AS WRITTEN

---

## Research Findings

1. tmux `send-keys` injection is a well-documented attack vector in CI/CD systems. Universal mitigation: re-read current process state before injection.
2. Telegram Bot API 7.0+ makes `forward_origin` mandatory — reliable for detecting forwarded messages.
3. Per-relay HMAC signatures in message body would prevent crafted approval responses from unauthorized users with topic write access.
4. LLM context summarization via external API creates an outbound data channel for terminal content — should reuse existing credential scrubbing.

---

## Critical Issues

### CRIT-1: Free-text relay enables arbitrary command injection
The spec sends free-text question answers "directly as input to the session." If the session's foreground process isn't Claude Code at the moment of injection (race condition, session advance, crash recovery), arbitrary text lands in a shell. No sanitization specified for shell metacharacters.

**Fix**: Verify foreground process is Claude Code before injection. Sanitize shell metacharacters in free-text input. Add a "safe injection" mode that wraps input in quotes.

### CRIT-2: Telegram sender authentication is underspecified
Defers to "same as Standby" with no details. Critical gaps: forwarded Telegram messages retain the original `from.id` (forwarding attack). No rejection of `forward_origin` messages, topic thread validation, or `via_bot` rejection specified.

**Fix**: Explicitly reject forwarded messages (`forward_origin` present). Validate topic thread ID. Reject `via_bot` messages.

### CRIT-3: Raw terminal output sent to LLM without credential scrubbing
The 20-line tmux context sent to Haiku may contain API keys, tokens, database connection strings. PresenceProxy already has `credentialPatterns` — this spec doesn't reference it.

**Fix**: Reuse PresenceProxy's `sanitizeTmuxOutput()` for all tmux captures before LLM calls.

---

## High Severity Issues

- **TOCTOU race condition**: "yes" injected for prompt A could land on prompt B if session advances between relay creation and response injection. Must re-fingerprint session state immediately before injection.
- **NLP classification prompt injection**: Multi-line Telegram replies could contain adversarial text targeting the Haiku classifier. Classify intent from first 100 chars only; inject raw text separately.
- **In-memory state lost on restart**: `responded: true` not persisted. Telegram response after server restart gets re-processed.
- **sessionName not re-validated at injection time**: Should verify against live session list before every `sendKey()` call.

---

## Recommendations

1. Re-fingerprint tmux state immediately before every keystroke injection
2. Reject forwarded Telegram messages (`forward_origin`)
3. Reuse `sanitizeTmuxOutput()` from PresenceProxy
4. Persist PendingRelay state to disk
5. Verify foreground process before free-text injection
6. Classify NL intent from first 100 chars only
7. Consider per-relay HMAC signatures

---

## Scalability Assessment

Adequate for single-user single-machine. The injection path is the primary attack surface — hardening it is prerequisite to any scaling.
