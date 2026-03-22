# Track 2: Memory Pipeline

## Executive Summary
Instar implements a three-layer memory system: JSONL append-only logs (source of truth), SQLite with FTS5 full-text search (derived query layer), and a WorkingMemoryAssembler that token-budgets context from semantic knowledge, episodic digests, and relationships. Rolling summaries use Haiku ("fast" model) triggered every 20 new messages. MEMORY.md is agent-authored, not Instar-managed.

---

## 1. JSONL Write Path

**[VERIFIED]** `src/messaging/shared/MessageLogger.ts`

**LogEntry schema (lines 12-26):**
```json
{
  "messageId": number,
  "channelId": number,
  "text": string,
  "fromUser": boolean,
  "timestamp": "ISO8601",
  "sessionName": string | null,
  "senderName": string,
  "senderUsername": string,
  "platformUserId": number,
  "platform": string
}
```

- **Write** (line 86): `fs.appendFileSync(logPath, JSON.stringify(entry) + '\n')` — atomic line-based
- **Dual-write callback** (line 93-99): `onMessageLogged` fires after every append → TopicMemory gets SQLite insert
- **Location**: `.instar/telegram-messages.jsonl`

---

## 2. SQLite FTS5 Schema

**[VERIFIED]** `src/memory/TopicMemory.ts:175-243`

**Database**: `topic-memory.db` (SQLite with WAL mode)

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  topic_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  from_user INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL,
  session_name TEXT,
  sender_name TEXT,
  sender_username TEXT,
  telegram_user_id INTEGER,
  user_id TEXT,
  privacy_scope TEXT DEFAULT 'private',
  UNIQUE(message_id, topic_id)
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TABLE topic_summaries (
  topic_id INTEGER PRIMARY KEY,
  summary TEXT NOT NULL,
  purpose TEXT,
  message_count_at_summary INTEGER NOT NULL DEFAULT 0,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE topic_meta (
  topic_id INTEGER PRIMARY KEY,
  topic_name TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_activity TEXT NOT NULL
);
```

**Tokenizer**: Porter stemming + Unicode61
**Indexes**: `(topic_id, timestamp)`, `(topic_id, message_id)`, `(telegram_user_id)`, `(user_id)`, `(privacy_scope)`
**FTS sync**: Auto triggers on INSERT/DELETE/UPDATE
**Schema version**: 4

---

## 3. Rolling Summaries

**[VERIFIED]** `src/memory/TopicSummarizer.ts:140-196`

- **Trigger**: `needsSummaryUpdate(topicId, threshold)` — threshold defaults to 20 new messages (line 40)
- **Input**: Only NEW messages since last summary (not full conversation replay)
- **Model**: `'fast'` (Haiku tier) — line 164
- **Max tokens**: 1024 (line 42)
- **Provider**: `IntelligenceProvider` interface (pluggable)
- **Output fields**: `summary`, `purpose` (extracted from "PURPOSE:" prefix), `messageCount`, `lastMessageId`
- **Storage**: `topicMemory.saveTopicSummary()` (TopicMemory.ts:568)
- **Batch**: `summarizeAll()` scans all topics (line 202-216)

---

## 4. Context Re-injection (Working Memory Assembly)

**[VERIFIED]** `src/memory/WorkingMemoryAssembler.ts:115-171`

Three-layer assembly with token budgets:

| Layer | Budget | Source | Priority |
|-------|--------|--------|----------|
| Semantic knowledge | 800 tokens | FTS5 search on learned facts | Highest |
| Recent episodes | 400 tokens | Activity digests from last 24h | Medium |
| Relationships | 300 tokens | People/person entities | Lowest |
| **Total hard cap** | **2000 tokens** | | |

**Tiered rendering by relevance:**
- Top 3 entities: Full content (name + content + confidence + connections)
- Next 7: Compact (name + first sentence + confidence)
- Remainder: Name-only list ("Also related: X, Y, Z")

**Session-ready output**: `TopicMemory.formatContextForSession()` (lines 833-883) — markdown-formatted with headers, current focus/purpose, full summary, recent messages with timestamps.

---

## 5. MEMORY.md

**[VERIFIED]** `src/scaffold/templates.ts:199-217`

- **Agent-authored** — NOT Instar-managed
- Template sections: "Project Patterns", "Tools & Scripts", "Lessons Learned"
- Agent writes to it via `/reflect` or PATCH `/identity/soul`
- CLAUDE.md template describes it as agent's responsibility
- Dual memory design: MEMORY.md (structured, agent-managed) coexists with automatic episodic/semantic storage

---

## 6. Memory Search

**[VERIFIED]** `src/memory/TopicMemory.ts:502-544`

**Trace path:**
1. API: `POST /topic/search?q=query&topic=12345`
2. Query sanitization: strips FTS5 syntax to prevent injection (lines 505-506)
3. SQL (two paths — by topic or global):
   ```sql
   SELECT m.*, rank FROM messages_fts
   JOIN messages m ON m.id = messages_fts.rowid
   WHERE messages_fts MATCH ? [AND m.topic_id = ?]
   ORDER BY rank LIMIT ?
   ```
4. Results: `TopicSearchResult[]` with `text`, `topicId`, `fromUser`, `timestamp`, `messageId`, `rank`, `highlight`
5. Max 100 results

---

## 7. Storage Growth & Pruning

**[VERIFIED]** `src/messaging/shared/MessageLogger.ts:202-224`

**JSONL rotation:**
- Threshold: 20MB file size OR 100,000 lines
- Action: Keep last 75,000 lines (configurable)
- Mechanism: Atomic rewrite (tmp+rename)

**SQLite compaction** (TopicMemory.ts:719-743):
- Full FTS5 rebuild: `INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`
- `rebuildTopicMeta()` recalculates topic stats

**No long-term archival**: Relies on JSONL rotation. SemanticMemory docs mention tombstones (soft-delete) but TopicMemory has no explicit archival.
