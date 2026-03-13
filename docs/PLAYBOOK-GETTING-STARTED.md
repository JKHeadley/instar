# Playbook: Context Engineering for AI Agents

> Your agent's memory system. Zero external dependencies. Full lifecycle.

Playbook gives your Instar agent a structured context memory that grows, decays, and evolves across sessions. Instead of losing everything at session boundaries, your agent accumulates strategies, lessons, and patterns — and learns which ones actually work.

## Quick Tour (< 5 minutes)

### Step 1: Initialize

```bash
# In your Instar project directory
instar playbook init
```

This detects Python 3.10+, creates a virtual environment, and sets up the playbook directory structure at `.instar/playbook/`.

### Step 2: Add context items

```bash
instar playbook add --content "Always check error returns before proceeding" \
  --tags "practice,errors" --type strategy

instar playbook add --content "Use structured logging, not print statements" \
  --tags "practice,debugging" --type strategy

instar playbook add --content "Prisma createMany silently skips duplicates on SQLite" \
  --tags "lesson,database,prisma" --type lesson
```

### Step 3: List your context

```bash
instar playbook list
```

Output:
```
Context Manifest (3 items)

  /context/strategy/always-check-error-returns
    Tags: practice, errors | Type: strategy | Score: 0
    Always check error returns before proceeding

  /context/strategy/use-structured-logging
    Tags: practice, debugging | Type: strategy | Score: 0
    Use structured logging, not print statements

  /context/lesson/prisma-createmany-sqlite
    Tags: lesson, database, prisma | Type: lesson | Score: 0
    Prisma createMany silently skips duplicates on SQLite
```

### Step 4: Assemble context for a session

```bash
instar playbook assemble --tags "practice"
```

This selects items matching your tags within the token budget and produces context ready for injection into an agent's system prompt.

For machine-readable output:

```bash
instar playbook assemble --tags "practice" --json
```

The `assembled_text` field in JSON output is what gets injected into the session.

### Step 5: Check health

```bash
instar playbook status
```

Shows manifest item counts, chain integrity, and health metrics.

### Step 6: Validate

```bash
instar playbook validate
```

Runs schema validation and chain integrity checks.

## After Your First Session

Once your agent has run a real session with Playbook active:

### Step 7: Evaluate context usage

```bash
# Try the built-in demo first
instar playbook evaluate --demo

# Then evaluate a real session
instar playbook evaluate .instar/sessions/latest/eval-log.jsonl
```

This shows which context items your agent actually used, which were helpful, and which were ignored.

### Step 8: Run the lifecycle

```bash
# Preview what would change
instar playbook lifecycle --dry-run

# Run for real
instar playbook lifecycle
```

The lifecycle manager handles:
- **Decay**: Items that haven't been used lose relevance over time
- **Dedup**: Near-duplicate items are merged
- **Retirement**: Items below the confidence threshold are archived
- **Scoring**: Usage outcomes feed back into item usefulness scores

## How It Works

### Architecture

```
Session Start
    |
    v
[playbook assemble] --> Selects items by tags + budget --> System prompt injection
    |
    v
Agent Session (items available in context)
    |
    v
[playbook evaluate] --> Tracks which items were used + outcomes
    |
    v
[playbook lifecycle] --> Decay, score, dedup, retire --> Updated manifest
    |
    v
Next Session (better context)
```

### Key Concepts

| Concept | What It Is |
|---------|-----------|
| **Manifest** | The source of truth — all context items with metadata |
| **Assembly** | Tag-based selection within a token budget for a specific session |
| **Lifecycle** | Autonomous maintenance — decay, scoring, dedup, retirement |
| **Delta Validator** | Every change goes through deterministic validation rules |
| **Scratchpad** | Per-session working memory that survives compaction |
| **Mount** | Read-only overlay from an external manifest (team sharing) |

### Static vs Dynamic Injection

**Phase 4 (current as of v0.13.0)**: Static injection. Context is assembled at session start and injected into the system prompt. Simple, predictable, zero mid-session complexity.

**Future**: Dynamic injection. Context refreshed mid-session based on task signals. More powerful, more complex. Requires hook integration.

### Data Storage

All data lives on the local filesystem by default:
- `.instar/playbook/context-manifest.json` — The manifest
- `.instar/playbook/context-governance.json` — Policy rules
- `.instar/playbook/playbook-history.jsonl` — Append-only history
- `.instar/playbook/sessions/` — Per-session scratchpads

**Nothing leaves the machine** unless you explicitly configure LLM features (reflector, eval-log) that call external APIs.

## Advanced Features

### Sharing context between agents (Mounts)

```bash
# Mount a shared team manifest
instar playbook mount /shared/team-manifest.json --name team-playbook

# List mounts
instar playbook mount list

# Verify mount integrity
instar playbook mount verify

# Remove a mount
instar playbook unmount team-playbook
```

Mounts are verified snapshots — not live links. The source hash is checked at mount time, and only `access_scope: "global"` items are accepted.

### Data subject rights (GDPR/CCPA)

```bash
# Export all data for a user
instar playbook user-export USER_ID --json > user-data.json

# Audit trail
instar playbook user-audit USER_ID

# Delete all user data (irreversible)
instar playbook user-delete USER_ID --confirm
```

### Customizing scripts (Eject)

```bash
# Eject a specific script for customization
instar playbook eject playbook-lifecycle.py

# Eject all scripts
instar playbook eject --all
```

Ejected scripts live in `.instar/playbook/scripts/` and take priority over bundled versions.

### Machine-readable output

Every command supports `--json` for integration with other tools:

```bash
instar playbook list --json | jq '.items | length'
instar playbook assemble --json | jq '.assembled_text'
instar playbook status --json | jq '.health'
```

## CLI Reference

| Command | Description |
|---------|-----------|
| `init` | Initialize playbook (Python, venv, config) |
| `doctor` | Diagnose setup issues |
| `status` | Dashboard view |
| `list [--tag TAG]` | List items with filtering |
| `read ITEM_ID` | Display single item |
| `add --content "..." --tags "..."` | Add new item |
| `search QUERY` | Search items |
| `assemble [--tags "..." --budget N]` | Assemble session context |
| `evaluate [SESSION_LOG \| --demo]` | Evaluate context usage |
| `lifecycle [--dry-run]` | Run maintenance cycle |
| `validate` | Schema + integrity check |
| `mount PATH --name NAME` | Mount external manifest |
| `unmount NAME` | Remove mount |
| `export [--format json\|md]` | Export manifest |
| `import FILE` | Import items (validated) |
| `eject [SCRIPT \| --all]` | Copy scripts for customization |
| `user-export USER_ID` | DSAR: export user data |
| `user-delete USER_ID --confirm` | DSAR: delete user data |
| `user-audit USER_ID` | DSAR: audit trail |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Validation failure |
| 3 | Missing dependency (Python, venv) |
| 4 | Configuration error |

## Related

- [Contextual Dispatch Integration Spec](../docs/specs/PROP-contextual-dispatch-integration.md)
- ACE Paper: "Agentic Context Engineering" (Zhang et al., Stanford/SambaNova, ICLR 2026)
