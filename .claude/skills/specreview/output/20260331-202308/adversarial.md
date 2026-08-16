# Adversarial Review: PR #30 iMessage Adapter

### Approval Status: CONDITIONAL

**Score: 5/10**

---

## Critical Issues

**1. Prompt Injection via iMessage Content (P0)**
- **Likelihood**: HIGH | **Impact**: CRITICAL | **Priority**: P0
- Raw, unsanitized iMessage content is inlined directly into Claude session bootstrap messages and injections. An authorized sender can craft text that overrides session instructions, injects shell commands via the heredoc template, or exfiltrates data. `senderName` (from `chat.db`'s `chat_name` column) only strips brackets -- backticks and `$()` pass through.
- **Fix**: Sanitize message content before injection. At minimum, escape shell metacharacters in the bootstrap template. Consider wrapping user content in explicit delimiters that Claude can distinguish from instructions.

**2. Reply Endpoint Has No Recipient Validation (P1)**
- **Likelihood**: MEDIUM | **Impact**: HIGH | **Priority**: P1
- `POST /imessage/reply/:recipient` does not verify the recipient is in `authorizedSenders`. An authenticated API caller can poison the outbound log with fake recipients, and can clear stall state for real senders by submitting their identifier -- suppressing stall alerts when the agent is genuinely stuck. Hash collisions (32-bit djb2) can also cross-contaminate stall tracking between two real senders.
- **Fix**: Validate recipient against authorizedSenders before processing.

---

## High Issues

**3. Startup lookback re-processes 50 messages with empty dedup set**
- **Likelihood**: HIGH | **Impact**: MEDIUM
- Duplicate injections on every restart. Persist lastRowId.

**4. Chat history endpoint exposes all contacts**
- **Likelihood**: MEDIUM | **Impact**: MEDIUM
- `/imessage/chats/:chatId/history` exposes full chat history for any contact on the device to authenticated API callers -- not scoped to authorized senders.
- **Fix**: Filter chat history endpoints to only return data for authorized senders.

**5. Command injection via bootstrap template**
- **Likelihood**: LOW | **Impact**: HIGH
- Unquoted `$RECIPIENT` in shell template inside bootstrap message enables command injection if sender identifiers contain special characters.

---

## Medium Issues

- Session name collisions (6-char truncated suffix)
- Bootstrap temp files in world-readable `/tmp` with no cleanup
- Stall detection can be flooded; no rate limiting per sender
- `spawningSenders` guard uses lowercase but registration uses original casing (latent inconsistency)

---

## What's Solid

- Fully parameterized SQL (no injection risk in SQLite queries)
- `query_only` pragma on chat.db
- Fail-closed authorization
- `isFromMe` skipping
- Phone number masking in logs
