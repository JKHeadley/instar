# Privacy & Ethics Review — Presence Proxy

**Review ID**: 20260327-124457
**Reviewer**: Privacy & Ethics
**Score**: 6.5/10
**Approval Status**: CONDITIONAL

---

## Critical Issues

### C1 (HIGH) — Unsanitized tmux output sent to LLM
Raw tmux output (50–200 lines) is passed to LLM calls without any sanitization. Terminal output routinely contains API keys, credentials, `.env` secrets, and sensitive file contents. No pre-LLM redaction layer is specified.

**Suggested fix**: Add a pre-LLM sanitization pass that redacts API keys, tokens, `KEY=VALUE` patterns, and known secret formats before any LLM call.

### C2 (HIGH) — No retention policy for PresenceState data
`PresenceState` stores `userMessageText` with no defined retention policy or deletion lifecycle. Logs persist to `telegram-messages.jsonl` and SQLite with no access controls or expiry defined.

**Suggested fix**: Define retention period in config (default 90 days) and clear snapshot strings on cancellation. Add `logRetentionDays` to `PresenceProxyConfig`.

### C3 (MEDIUM) — Insufficient automated-nature disclosure
The proxy's "conversational stand-in" mode may not sufficiently disclose its automated nature. The `🔭 [Presence]` prefix is the sole disclosure mechanism, which may not meet EU AI Act transparency requirements.

**Suggested fix**: Send a one-time automated-system disclosure on first proxy activation per session. E.g., "This is an automated monitoring system providing status updates while [Agent] is busy."

---

## Recommendations

1. Add `sanitizeBeforeLlm` and `customRedactionPatterns` to `PresenceProxyConfig`
2. Document the single-user assumption as an explicit design constraint
3. Define clear data lifecycle for conversation history and snapshots
4. Consider opt-in/opt-out for proxy conversation mode per user

---

## Observations

- Ephemeral conversation history is a privacy win — data doesn't persist beyond PresenceState lifecycle
- Process tree analysis via `ps` is low-risk from a privacy perspective
- The `cancelled` flag / timer cleanup pattern is sound for data minimization
- The `quiet` command gives users meaningful control over the feature

---

## Scalability Assessment

- **Phase 1 (MVP)**: Single-user, single-agent — privacy risks are low and manageable
- **Phase 2 (Growth)**: Multi-user scenarios would need per-user consent and access controls
- **Phase 3 (Scale)**: Log volume and retention become material concerns
- **Viral spike**: Not applicable for this feature's scope
