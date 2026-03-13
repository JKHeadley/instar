---
title: File Structure
description: What Instar creates and where everything lives.
---

Everything is file-based. No external database, no cloud dependencies.

## Directory Layout

```
.instar/
  config.json             # Server, scheduler, messaging config
  jobs.json               # Scheduled job definitions
  users.json              # User profiles and permissions
  AGENT.md                # Agent identity (who am I?)
  USER.md                 # User context (who am I working with?)
  MEMORY.md               # Persistent learnings across sessions
  hooks/                  # Behavioral scripts
    instar/               # Instar-managed hooks
      dangerous-command-guard.py
      external-operation-gate.js
      grounding-before-messaging.sh
      session-start.sh
      compaction-recovery.sh
      deferral-detector.js
      post-action-reflection.js
      telegram-topic-context.sh
  scripts/                # Agent infrastructure scripts
    serendipity-capture.sh  # Sub-agent finding capture (HMAC, validation, atomic write)
  skills/                 # Built-in + agent-created skills
  playbook/               # Context engineering playbooks (if initialized)
  state/                  # Runtime state
    sessions/             # Active session tracking
    jobs/                 # Job execution history
    evolution/            # Evolution queue, learnings, gaps, actions (created on demand)
    serendipity/          # Pending serendipity findings (created on demand)
      processed/          # Triaged findings (promoted or dismissed)
      invalid/            # Failed HMAC verification
    journal/              # Decision journal entries (created on demand)
  relationships/          # Per-person relationship files (JSON)
  views/                  # Dashboard view state
  memory.db               # SQLite: topic memory + full-text search index
  logs/                   # Server logs
  shadow-install/         # Auto-updater shadow install directory

.claude/                  # Claude Code configuration
  settings.json           # Hook registrations
  scripts/                # Health watchdog, Telegram relay, smart-fetch
```

## Key Files

| File | Format | Purpose |
|------|--------|---------|
| `config.json` | JSON | All server and integration configuration |
| `jobs.json` | JSON | Job definitions with cron schedules |
| `users.json` | JSON | User profiles (name, Telegram ID, email) |
| `AGENT.md` | Markdown | Agent identity, loaded into every session |
| `USER.md` | Markdown | User context, loaded into every session |
| `MEMORY.md` | Markdown | Accumulated learnings, always in context |
| `memory.db` | SQLite | Derived from JSONL -- deletable and rebuildable |

## State Files

All runtime state lives in `.instar/state/` as JSON files the agent can read and modify directly. This is deliberate -- the agent has full access to its own state.

Some state subdirectories (`evolution/`, `serendipity/`, `journal/`) are created on demand by their respective modules rather than during initial setup.

## Why File-Based?

- **Transparency** -- Everything is inspectable with standard tools
- **Agent access** -- The agent can read and modify its own state
- **Portability** -- Copy the directory to move the agent
- **Simplicity** -- No database server to manage
- **Git-friendly** -- State can be version-controlled and synced
