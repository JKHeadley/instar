# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Topic-spam, locked down structurally.** A second Telegram topic-flood (after
the 2026-05-22 sentinel flood) hit a live agent: a housekeeping feature raised one
attention item per failed peer-resolution every sweep, and because
`createAttentionItem` spawns a brand-new forum topic per item, that became a wall
of topics. PR #495 already fixed *that feature* (a per-peer escalation cooldown).
This change adds the **structural backstop** so the *class* of bug can't recur no
matter which feature misbehaves next.

**`AttentionTopicGuard` — a per-source + global circuit breaker** at the one
chokepoint, `TelegramAdapter.createAttentionItem`. If a single attention
`sourceContext` exceeds its topic budget within a rolling window (default 3 / 10
min) — or, via a **global ceiling**, all sources collectively exceed it — further
**non-critical** items are COALESCED into ONE reused "notices coalesced" topic and
recorded in `state/attention-suppressed.jsonl` — never a wall. Invariants:
HIGH/URGENT/CRITICAL items are **never** coalesced (critical messages always get
their own topic), and **no item is dropped** — only its per-item topic is withheld;
the item is still in the attention store. The global ceiling makes the protection
hold even when a feature varies its `sourceContext` per item to dodge a per-source
budget. Ships **enabled by default in code**, so every fleet agent is protected on
the dist update with zero config.

## What to Tell Your User

- The "wall of topics popping up out of nowhere" problem is now fixed at its root.
  If any background feature ever tries to flood the chat again, it's capped
  automatically: a few topics at most, then everything folds into one quiet
  "notices coalesced" topic, with the detail kept in the logs. Genuinely critical
  alerts (HIGH/URGENT) are never affected — they always come through on their own.
- No action or config needed; it's on by default.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Attention topic-flood circuit breaker | Automatic, on by default. Tune via `messaging[].config.attentionTopicGuard` = `{ "enabled": true, "windowMs": 600000, "maxTopicsPerSource": 3, "maxTopicsGlobal": 8 }`. |
| Suppressed-notice audit trail | When a source is coalesced, each item is logged to `state/attention-suppressed.jsonl` (size-capped). Read it to answer "why are my notices grouped / where did topic X go?" |

## Migration Notes

Pure `src/` logic, **default-ON in code** (`AttentionTopicGuard` +
`TelegramAdapter`) — no agent-installed file changed, so every agent receives the
protection through the normal dist update with nothing to patch. A
`migrateClaudeMd()` entry backfills the **Topic-Flood Guard** awareness section
into existing agents' CLAUDE.md (idempotent). The redrive-specific offender fix
shipped separately in PR #495.

## Evidence

- Unit: `tests/unit/AttentionTopicGuard.test.ts` (11) — budget / global-cap /
  critical-bypass (case-insensitive) / per-source isolation / sustained-flood
  single episode / post-silence reset / config-validation / key-eviction;
  `tests/unit/PostUpdateMigrator-topicFloodGuard.test.ts` (2) — migrator backfill
  + idempotency.
- Integration: `tests/integration/attention-topic-flood-guard.test.ts` (4) — REAL
  `TelegramAdapter`: a flooding source is capped at budget+1 topics, HIGH
  bypasses, concurrent coalesced items create ONE topic, a different source is
  unaffected, no item dropped, audit log populated.
- E2E: `tests/e2e/attention-topic-flood-guard-lifecycle.test.ts` (1) — fleet
  default (NO config) still caps a flood exactly (migration-parity guarantee).
