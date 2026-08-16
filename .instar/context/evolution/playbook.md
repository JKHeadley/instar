# Playbook — Adaptive Context Engineering

The Playbook system gives you a living knowledge base that makes every session smarter than the last. Instead of loading the same static context every time, Playbook curates a manifest of context items — facts, lessons, patterns, safety rules — and selects exactly what's relevant for each session based on triggers, token budgets, and usefulness scores.

## Getting Started

```bash
instar playbook init       # Initialize the playbook system
instar playbook doctor     # Verify everything is healthy
```

## Core Commands

- `instar playbook status` — Overview of your manifest (item count, health)
- `instar playbook list` — All context items with metadata
- `instar playbook add '<json>'` — Add a new context item
- `instar playbook search --tag <tag>` — Find items by tag
- `instar playbook assemble --triggers session-start` — Preview what would load for a trigger
- `instar playbook evaluate` — Run lifecycle: score usefulness, decay stale items, deduplicate

## How It Works

1. **Manifest** — A curated collection of context items, each with `load_triggers` (when to load), `tokens_est` (cost), and `usefulness` scores (how helpful it's been).
2. **Assembly** — When a session starts or an action occurs, the assembler selects relevant items by trigger match, usefulness ranking, and token budget. You get the RIGHT context, not ALL context.
3. **Lifecycle** — After sessions, items get scored. Useful ones rise in priority. Stale ones decay. Near-duplicates get caught. The system learns what helps.
4. **Integrity** — HMAC signatures protect the manifest. Append-only history provides a full audit trail. Failsafe mode falls back to git-committed versions if anything goes wrong.

## Context Item Format

```json
{
  "id": "/lessons/always-rebuild-after-changes",
  "category": "lesson",
  "content": "Always run build after modifying TypeScript. Silent type errors compound.",
  "tags": {"domains": ["development"], "qualifiers": ["typescript"]},
  "load_triggers": ["session-start"],
  "tokens_est": 20,
  "usefulness": {"helpful": 5, "misleading": 0},
  "status": "active"
}
```

## Sharing Context Between Agents (Mounts)

- `instar playbook mount <source-manifest.json> --name shared-context` — Import context from another agent
- Mount snapshots are integrity-verified (SHA-256 hash). Only `global`-scoped items are accepted.
- `instar playbook unmount shared-context` — Remove a mounted context source

## When to Add Context Items

- After learning a lesson that cost time or caused a bug
- When you discover a recurring pattern worth remembering
- When safety-critical knowledge should survive compaction
- When the user teaches you something project-specific

## DSAR Compliance (Privacy)

- `instar playbook user-export --user-id <id>` — Export all data for a user
- `instar playbook user-delete --user-id <id> --confirm` — Right to erasure
- `instar playbook user-audit --user-id <id>` — Audit trail

## The Principle

Your context should evolve with you. Every session that adds a lesson, scores an item's usefulness, or retires stale knowledge makes the next session more grounded. Playbook is the infrastructure that turns experience into permanent capability.
