# DX Review: PR #30 iMessage Adapter

### Approval Status: CONDITIONAL

**Score: 7/10**

Strong foundation. The architecture mirrors Telegram/WhatsApp faithfully, and the test suite is genuine. Three issues need fixes before shipping.

---

### Critical Issues

**1. Wrong default port in `imessage-reply.sh` -- silent failure**

Line 68: `PORT="${INSTAR_PORT:-4040}"` -- instar runs on **4042**. Every reply notification silently posts to the wrong port. Stall tracking and outbound logging never fire. Fix: `PORT="${INSTAR_PORT:-4042}"`.

**2. 50-message lookback replays old messages on every server restart**

`NativeBackend.ts` sets `this.lastRowId = Math.max(0, maxId - 50)` on every startup. Since `lastRowId` and the deduplication set are both in-memory, a server restart re-injects the last 50 messages into active sessions. The cursor needs to be persisted to the state directory.

---

### Recommendations (Should Fix Before Merge)

**3. Full Disk Access failure gives a cryptic `SQLITE_CANTOPEN` error** -- no mention of FDA. Add a pre-check that emits an actionable message.

**4. `imsg` stderr is suppressed (`2>/dev/null`)** -- when send fails, the operator only sees `imsg send failed (exit N)` with no reason. Remove the stderr suppression.

**5. Session name collision risk** -- `slice(-6)` of phone numbers collides easily. `+14081234567` and `+12341234567` -> `im-234567`. Use 10 chars or a short hash.

---

### Observations

- `getConnectionInfo().connectedAt` returns current time on every call, not the actual connection time
- `listChats()` returns single participant per chat (group chats show only chat identifier) -- undocumented limitation
- Conversation context timestamps use local time (`getHours()`) -- confusing if server timezone differs from user
- Config `enabled` field location (outer entry vs inner `IMessageConfig`) needs documentation

---

### Test Gaps

- No test covering the port-4040 bug (would have caught issue #1)
- No test for `lastRowId` persistence across restart
- No test for session name collision
- No test for `connectedAt` accuracy
