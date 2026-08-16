# Security Review: iMessage Adapter PR

**Reviewer:** Echo (Security Specialist)
**Date:** 2026-03-31
**Scope:** Native macOS iMessage adapter for instar platform

---

### Approval Status: CONDITIONAL

The implementation is generally well-structured with several security-conscious design decisions (fail-closed authorization, prepared statements, privacy masking in logs). However, there are meaningful issues in the shell script and the API endpoint authentication model that must be addressed before production deployment.

---

## Critical Issues (must fix)

### 1. Shell Injection / Malformed JSON via `sed` fallback in imessage-reply.sh (line 78)

**Why it matters:** The primary JSON encoding path uses python3, which is correct. However the fallback on line 78 uses `sed` to manually escape the message:

```bash
JSON_MSG="\"$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')\""
```

This fallback does not handle all JSON special characters: tab (`\t`), carriage return (`\r`), null bytes, form feed, and Unicode surrogates all produce invalid JSON. A message containing these characters when python3 is unavailable will produce malformed JSON, causing the server POST to fail silently. More importantly, if a recipient-controlled message contains shell metacharacters and the sed pipeline somehow breaks quoting, there is a secondary injection surface.

**Suggested fix:** Remove the sed fallback entirely. If python3 is unavailable, skip the server notification with an explicit warning: `echo "Warning: python3 unavailable, skipping server notification" >&2`. The primary send (imsg) has already succeeded. Do not attempt JSON encoding with an incomplete tool.

---

### 2. `/imessage/reply/:recipient` does not validate that recipient is an authorized sender (routes.ts, lines 1829–1858)

**Why it matters:** The endpoint logs an outbound message and clears stall tracking for the given recipient. There is no check that `recipient` is a member of `authorizedSenders`. Any authenticated caller can:
- Log fabricated outbound messages for arbitrary phone numbers (pollutes the log with false entries)
- Clear stall tracking for any sender, suppressing legitimate stall alerts

A compromised Claude session that has access to the auth token (which sessions do, as they read `.instar/config.json`) could call this endpoint with a forged recipient to manipulate tracking state.

**Suggested fix:** Add a guard in the route handler:
```typescript
if (!ctx.imessage.isAuthorized(recipient)) {
  res.status(403).json({ error: 'recipient not in authorized senders' });
  return;
}
```

---

### 3. Bootstrap and injection temp files written to world-readable `/tmp` with no permissions restriction (server.ts line 84; SessionManager.ts lines 302–307)

**Why it matters:** Long bootstrap messages and injected messages are written to `/tmp/instar-imessage/`. The directory is created with no explicit mode (defaults to umask-controlled, typically `755` on macOS — world-readable). These files contain:
- Full conversation history including all prior messages
- The user's phone number (partially encoded in the filename slug)
- The current message content

Any local process (including sandboxed apps granted access to `/tmp`) can read these files. They are never explicitly deleted after the session consumes them.

**Suggested fix:**
1. Create the directory with restricted permissions: `fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 })`
2. Write files with restricted permissions: `fs.writeFileSync(filepath, content, { mode: 0o600 })`
3. Schedule deletion after injection: after `injectMessage()` succeeds, delete the temp file

---

## Recommendations (should fix)

### 4. Port constant mismatch: script defaults to 4040, actual server runs on 4042

**Why:** `imessage-reply.sh` line 68 has `PORT="${INSTAR_PORT:-4040}"`. The instar server runs on port 4042. Any deployment that does not set `INSTAR_PORT` will silently fail the server notification step after every sent message. The message is still delivered (imsg send succeeded), but logging and stall-clearing are silently skipped.

**How:** Change the default to 4042, matching the server's actual default port.

---

### 5. `authorizedSenders` normalization is case-insensitive but phone number formats are not normalized to E.164

**Why:** Senders are normalized to lowercase. This works for email. But phone numbers from chat.db may appear in varying formats depending on the contact record: `+14081234567`, `14081234567`, `(408) 123-4567`. If chat.db returns a number without the `+` prefix, or with spaces/dashes, the auth check silently fails and the message is rejected with no feedback to the user.

**How:** Add E.164 normalization to both stored senders and incoming sender values: strip all non-digit characters, prepend `+` if the result doesn't already start with one. Add a startup log warning if any `authorizedSenders` entry doesn't match E.164 format.

---

### 6. Session name derived from short identifier suffix creates collision risk

**Why:** Session names are `im-${sender.replace(/[^a-zA-Z0-9]/g, '').slice(-6)}`. Two senders whose sanitized identifiers share trailing 6 characters get mapped to the same session name. With phone numbers this is unlikely but possible (e.g., `+14081234567` and `+12344234567` both → `im-234567`). With email addresses it is more likely (`alice@icloud.com` and `alice@gmail.com` could collide). Collision means one user's messages are injected into the other user's session.

**How:** Use more of the identifier or use a hash. A simple `im-${crypto.createHash('sha1').update(sender).digest('hex').slice(0, 8)}` gives better uniqueness with the same character budget.

---

### 7. Conversation context in bootstrap is not sanitized for prompt injection

**Why:** `getConversationContext()` formats raw message text from chat.db directly into the bootstrap prompt without sanitizing for prompt-injection patterns. An adversary who can get a message into the conversation history of an authorized sender (e.g., via group chat, or by being added as a contact) could embed instructions like `IGNORE PREVIOUS INSTRUCTIONS` or fake `[CONTINUATION]` markers. These appear in the history window and are injected verbatim into the Claude session's bootstrap.

**How:** At minimum, document this threat model in the code. A practical mitigation is to wrap each history entry in a fixed-format delimiter that Claude is instructed to treat as data, not instructions:
```
[HISTORY-ENTRY ts=HH:MM direction=INBOUND] {text} [/HISTORY-ENTRY]
```
This makes it structurally harder to break out of the history context.

---

### 8. `imsg` CLI binary has no integrity verification and comes from a third-party Homebrew tap

**Why:** `imsg` is installed from `steipete/tap/imsg`, a personal Homebrew tap. The script discovers the binary at runtime from PATH and several hardcoded locations. There is no hash check or code signature verification. If an attacker places a malicious `imsg` binary earlier in PATH or in `$HOME/homebrew/bin/`, it will be executed with full access to the message content and recipient address.

**How:** Pin the binary path via the `cliPath` config option rather than relying on PATH discovery. Log a warning if the discovered path differs from config. Document that the imsg binary should be verified after install.

---

### 9. No upper bound on `limit` parameter in chat/history/search endpoints

**Why:** `GET /imessage/chats`, `GET /imessage/chats/:chatId/history`, and `GET /imessage/search` all accept a `limit` query parameter parsed with `parseInt()` and no maximum cap. A caller can request `limit=999999`, triggering a full table scan of chat.db, which could contain years of message history.

**How:** Cap the limit at a reasonable maximum (e.g., `Math.min(parseInt(req.query.limit) || 50, 500)`).

---

## Observations

- **SQL injection risk is negligible.** All NativeBackend queries use `better-sqlite3` prepared statements with parameterized binding. The `query_only = ON` pragma adds a second layer preventing writes. No queries dynamically concatenate user input into SQL strings.

- **The fail-closed authorization model is well-implemented.** Empty `authorizedSenders` rejects all messages, the check happens before any handler or event emission, and unauthorized sender identifiers are masked in log output.

- **The `isFromMe` filter correctly prevents reply loops.** Outbound messages detected in the polling loop are filtered before auth checks.

- **The 50-message lookback window on startup is pragmatic** but means the in-memory `receivedMessageIds` set (not persisted) allows re-processing of messages seen before the last restart. The lookback window re-emits up to 50 messages every restart. For most deployments this is acceptable, but the last processed ROWID should be persisted to state for correctness.

- **The server notification in imessage-reply.sh is correctly non-critical.** The script succeeds after `imsg send` regardless of the POST result. This is the right design — logging should not block message delivery.

- **The split read/write architecture is architecturally sound.** Using SQLite reads for inbound and delegating sends to tmux sessions cleanly works around the macOS LaunchAgent TCC restriction. This is not a security vulnerability but an appropriate platform-specific design.

- **The `_poll()` method being public** is intentional for testability but worth noting as an internal that should not be called from production code paths outside the class.

- **The `stateDir` is used for the session registry and message log**, both of which contain phone numbers and message content. Ensure the state directory has appropriate filesystem permissions (typically owned by the user running instar, not world-readable).

---

## Research Findings

### macOS chat.db Security Considerations

- `chat.db` is a TCC-protected file at `~/Library/Messages/chat.db`. Access requires Full Disk Access (FDA) granted via System Preferences > Privacy & Security. This is a significant privilege — FDA grants access to all user files, not just Messages.
- The database uses WAL mode with Messages.app holding an open write lock. The `query_only = ON` pragma (not `readonly` flag) is the correct approach for reading WAL entries that haven't been checkpointed.
- `chat.db` contains all iMessage and SMS history in plaintext SQLite. FileVault encrypts it at rest, but any process with FDA can read it. The adapter does not persist decrypted content beyond the log file in `stateDir`.
- The `attachment` table contains paths to media files on disk. The implementation exposes attachment metadata but not file contents, which is the appropriate scope.

### imsg CLI Tool Security

- `imsg` by Peter Steinberger uses JXA (JavaScript for Automation) or AppleScript to drive Messages.app. It requires Automation permission targeting Messages.app.
- It is distributed via a personal Homebrew tap (`steipete/tap/imsg`) — not an official Homebrew core formula. This means it is not subject to Homebrew's core review process.
- If the imsg implementation constructs AppleScript strings by concatenating the `--text` argument value without proper escaping, a crafted message could inject arbitrary AppleScript. This cannot be mitigated at the instar layer without auditing imsg's source.
- The binary is not notarized or signed by Apple; macOS Gatekeeper may quarantine it on first run. Homebrew typically handles this, but it is worth noting for security-conscious deployments.

### SQLite Injection with Prepared Statements

- `better-sqlite3` binds parameters via SQLite's `sqlite3_bind_*` C API family. Parameters are never string-interpolated into query text — they are handled as typed values by the SQLite engine. SQL injection through bound parameters is not possible.
- The `query_only = ON` pragma additionally blocks any DML/DDL regardless of how a query was constructed.
- All table and column names in NativeBackend.ts are hardcoded literals, not derived from user input. There is no dynamic query construction.

### AppleScript Automation Permission Security Model

- Automation permissions in macOS TCC are per-process and per-target-app. A process must be granted `kTCCServiceAppleEvents` for the specific target app (Messages.app) before it can control it.
- LaunchAgent processes do not inherit the GUI session's TCC grants. This is why the LaunchAgent-hosted instar server cannot send iMessages directly — the TCC grant for Automation belongs to the terminal/tmux process that has the user's interactive session.
- The delegation to tmux sessions is the correct workaround. However, it means any process with access to the tmux socket (or that can run as the same user) can indirectly send iMessages by invoking imessage-reply.sh. The auth token check on the server notification does not prevent the `imsg send` call itself — the script sends first, notifies second.

---

## Score: 6.5/10

**Justification:**

The core architecture reflects genuine security awareness: fail-closed authorization, parameterized SQL, read-only database pragma, message deduplication, and PII masking in logs. The split read/write architecture correctly navigates the macOS TCC model.

The score is held back by three critical issues that must be fixed:
- World-readable temp files containing full conversation history and PII
- Missing recipient validation in the reply endpoint enabling log manipulation and stall suppression
- Unreliable JSON fallback that can silently corrupt server notifications

And several medium-severity issues:
- Port constant mismatch causing silent notification failures in default deployments
- No E.164 normalization creating silent auth rejections
- Session name collision risk from short identifier slugs
- Unverified third-party binary in the critical sending path

With the three critical issues resolved and the port default corrected, this implementation would score 8/10 and be appropriate for single-user macOS production deployments. The supply-chain risk from imsg is inherent to the architecture and cannot be fully mitigated without replacing that dependency.
