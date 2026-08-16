# Scalability Review: PR #30 iMessage Adapter

### Approval Status: CONDITIONAL

**Score: 7/10**

---

### Critical Issues

**1. receivedMessageIds eviction does not survive restarts — replay risk**

`RECEIVED_IDS_MAX_SIZE = 1_000` is in-memory only. On server restart, `lastRowId` is rewound to `maxId - 50`, which re-emits up to 50 already-processed messages. The dedup set was cleared on shutdown, so it provides zero protection. Sessions that already answered those messages will receive re-injections. Fix: persist `lastRowId` to disk and restore it on connect. Use the 50-row lookback only when no persisted value exists.

**2. `/tmp/instar-imessage` accumulates temp files with no cleanup**

Both `buildBootstrapMessage` and `injectIMessageMessage` write to `/tmp/instar-imessage/` with randomized filenames and no TTL or rotation. Nearly every session spawn exceeds the 500-char bootstrap threshold once conversation history is prepended. On macOS, `/tmp` is RAM-backed (APFS synthetic firmlink to `/private/var/folders`), making this a memory leak disguised as a disk issue. Fix: sweep and delete files older than 24 hours on `connect()` or via a periodic timer.

**3. Session name collisions silently misroute messages**

Names are generated as `im-${sender.replace(/[^a-zA-Z0-9]/g, '').slice(-6)}`. Two senders sharing the same last 6 alphanumeric characters collide with no error — the second sender's messages inject into the first sender's session. Fix: use a hash of the full sender string for the suffix.

---

### Recommendations

- **Synchronous SQLite on the event loop**: `better-sqlite3` is sync by design. The `stmtContextHistory` join (message -> handle -> chat_message_join -> chat) on `h.id` may lack an index. Verify with `EXPLAIN QUERY PLAN`. If unindexed, a multi-year history user will cause 10-100ms event loop stalls during each session spawn. Not fatal but observable.
- **`getConnectionInfo()` returns `new Date()` on every call** instead of the actual connection time -- misleading in logs.
- **`spawningSenders` guard is process-local** -- lost on crash/restart, safe to ignore for single-machine use.
- The synthetic hash `topicId` for `pendingInjections` can collide (different senders -> same hash), causing the wrong session's injection tracker to be cleared. Low probability but worth documenting.

---

### Scalability Assessment by Phase

| Phase | Senders | Assessment |
|-------|---------|------------|
| Small (1-5) | Nominal authorized list | No issues. Polling is near-zero cost. |
| Medium (10-20) | Active deployment | Session name collision risk starts. `/tmp` leak begins. |
| Large (50-100) | Edge of single-machine scale | Temp file leak significant. Restart replay hits more active conversations. Event loop stalls possible on spawn bursts. |
| 100+ | Outside design scope | Authorized-senders whitelist is the natural limiter. |

**Polling cost is not the concern.** `SELECT ... WHERE ROWID > ?` on an indexed column is O(log n) regardless of total message history. Even with millions of stored iMessages, the poll cost is sub-millisecond. The 2-second interval is appropriate and not a bottleneck.

**Memory**: one Claude Code tmux session per active sender dominates. The adapter itself is negligible. At 100 sessions you're managing 100 concurrent Claude Code processes -- that's the real resource constraint, not the iMessage adapter.
