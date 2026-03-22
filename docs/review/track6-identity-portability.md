# Track 6: Identity, Portability & File Formats

## Executive Summary
Identity files (AGENT.md, USER.md, MEMORY.md, SOUL.md) are pure markdown with no Instar-specific markup — vanilla CC would understand them. Conversations are stored as JSONL (portable) with SQLite as a derived query layer. The auto-updater applies updates without confirmation by default but is fully configurable. Exit path is clean: most accumulated knowledge is in portable formats.

---

## 1. Identity File Templates

**[VERIFIED]** `src/scaffold/templates.ts`

**AGENT.md** (lines 22-87):
- Pure markdown, no special syntax
- Sections: "Who I Am", "Personality", "My Principles" (10 principles), "Who I Work With", "Intent", "Self-Observations", "Growth", "Identity History"

**USER.md** (lines 177-193):
- Simple markdown: "About", "Communication Preferences", "Notes"
- Updated by agent as it learns user's style

**MEMORY.md** (lines 199-217):
- Sections: "Project Patterns", "Tools & Scripts", "Lessons Learned"
- Agent-authored, not Instar-managed

**SOUL.md** (lines 97-171):
- Self-authored identity workspace (v1)
- Sections: "Core Values", "Convictions", "Open Questions", "Integrations", "Evolution History"
- Markdown table for conviction tracking (confidence: strong/growing/uncertain/questioning)

**All files are standard markdown** — no YAML frontmatter, no Instar directives.

---

## 2. Identity Grounding Hooks

**[VERIFIED]** Session-start hook injection:

Priority order:
1. Topic context (highest) — loaded from API
2. Agent identity — first 20 lines of AGENT.md
3. Soul.md sections (when available)
4. User.md context
5. Working memory context (topic-specific)

Format: Plain text narrative — no structured markup.

---

## 3. JSONL Conversation Schema

**[VERIFIED]** `src/messaging/shared/MessageLogger.ts`

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

- Location: `.instar/telegram-messages.jsonl`
- One JSON object per line, append-only
- Can be parsed by any JSONL reader, converted to CSV, imported elsewhere

---

## 4. SQLite Schema

**[VERIFIED]** `src/memory/TopicMemory.ts:175-243`

See Track 2 for full schema. Key tables: `messages`, `messages_fts` (FTS5), `topic_summaries`, `topic_meta`. Schema version 4. Standard SQLite — queryable by any SQLite client.

---

## 5. Portability Assessment

| File/Data | Format | Portable? |
|-----------|--------|-----------|
| `.instar/config.json` | JSON | Yes — standard settings |
| `.instar/jobs.json` | JSON | Yes — standard job definitions |
| `.instar/state/sessions/*.json` | JSON | Yes — standard session records |
| `.instar/state/jobs/*.json` | JSON | Yes — standard job state |
| `.instar/*.jsonl` | JSONL | Yes — standard text format |
| `.instar/identity/AGENT.md` | Markdown | Yes — pure markdown |
| `.instar/identity/USER.md` | Markdown | Yes — pure markdown |
| `.instar/identity/MEMORY.md` | Markdown | Yes — pure markdown |
| `.instar/identity/SOUL.md` | Markdown | Yes — pure markdown |
| `.instar/hooks/custom/*` | Shell/JS | Yes — user-written scripts |
| `.instar/topic-memory.db` | SQLite | **Instar-specific** — tied to TopicMemory class |
| `.instar/semantic-memory.db` | SQLite | **Instar-specific** — vector embeddings |
| `.instar/state/decision-journal.jsonl` | JSONL | **Instar-specific** — structured decision entries |
| `.instar/hooks/instar/*` | Generated | **Instar-specific** — generated hook code |
| `.claude/settings.json` | JSON | **Coupled** — Instar hook configurations |

**Portable with migration**: Identity files can be copied to new install. JSONL can be re-imported. Job definitions portable if cron expressions unchanged. Custom hooks portable if no path dependencies.

---

## 6. Auto-Updater

**[VERIFIED]** `src/core/AutoUpdater.ts`

**Configuration (lines 31-44):**
```typescript
interface AutoUpdaterConfig {
  checkIntervalMinutes?: 30;   // Check frequency
  autoApply?: true;            // Auto-apply updates
  autoRestart?: true;          // Restart after update
  applyDelayMinutes?: 5;       // Batch rapid-fire publishes
  preRestartDelaySecs?: 60;    // Grace period before restart
}
```

**Behavior:**
- NO user confirmation — updates apply automatically by default
- Pre-restart notification sent to Telegram
- 60-second grace period before restart
- Session-aware: won't interrupt active sessions indefinitely (max deferral via UpdateGate)
- Deferral tracking: up to 24h max deferral for active sessions

**Disable:**
- Set `autoApply: false` — updates checked but not applied
- Set `autoRestart: false` — applied but manual restart required
