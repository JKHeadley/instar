# Privacy Review: PR #30 iMessage Adapter

### Approval Status: CONDITIONAL

**Score: 5/10**

---

### Critical Issues

**1. Mass ingestion of non-consenting third-party messages (HIGH)**

`NativeBackend._poll()` queries `WHERE m.ROWID > ?` -- a full sweep of ALL messages before any authorization check. The `authorizedSenders` filter runs in `IMessageAdapter._handleIncomingMessage()` after the data is already in memory. Every message from every contact on the device is read, deserialized, and emitted as an event before being discarded. This is a data minimization failure.

Fix: Push the filter into SQL itself -- `AND h.id IN (?, ?, ?)` for the authorized sender list.

**2. Plaintext PII in JSONL log file (HIGH)**

`MessageLogger.append()` writes the full `platformUserId` (phone number/email), `senderName`, and message text to `{stateDir}/imessage-messages.jsonl`. The `maskIdentifier` function is used only for console output, not for storage. The log rotates but never purges -- messages accumulate indefinitely up to 100k lines. This file is also synced by Instar's git-sync, meaning iMessage content could end up in a git repository.

Fix: Hash/HMAC `platformUserId` before storage; exclude the JSONL from git-sync; add configurable retention enforcement.

**3. Bootstrap temp files written world-readable to /tmp (HIGH)**

When bootstrap messages exceed 500 chars, full conversation history and message text are written to `/tmp/instar-imessage/bootstrap-*.txt` and `msg-*.txt`. macOS default umask makes these mode 644 (world-readable). No cleanup code deletes them after use.

Fix: Write with mode 0o600; delete after reading; consider writing inside `stateDir` instead of `/tmp`.

---

### Significant Recommendations

**4. API endpoints expose all chats, not just authorized-sender chats (MEDIUM)**

`GET /imessage/chats` lists ALL device chats. `GET /imessage/chats/:chatId/history` returns any thread without checking if it belongs to an authorized sender.

Fix: Filter `/imessage/chats` to authorized senders; validate `chatId` ownership before serving history.

**5. maskIdentifier is insufficient for short email addresses (MEDIUM)**

`jo@icloud.com` masks to `jo***@icloud.com` -- the full username is exposed.

**6. No consent signal or disclosure mechanism (MEDIUM)**

iMessage senders have no way to know an AI is reading their messages. No disclosure hook or `consentMessage` config option exists.

**7. No time-based log retention (MEDIUM)**

Rotation is triggered by line count, not age. Personal communications accumulate for months or years with no purge path.

---

### Observations

The adapter does several things right: `authorizedSenders` is required and fail-closed; the server process is read-only; all API endpoints require Bearer auth; `query_only = ON` prevents writes to `chat.db`; CORS is localhost-only. The privacy issues are about data minimization and retention, not authentication bypass.
