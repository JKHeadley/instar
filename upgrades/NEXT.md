# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Topic-spam, locked down at the source.** A second Telegram topic-flood (after
the 2026-05-22 sentinel flood) hit a live agent: `CollaborationRedriveEngine`
raised one "can't reach `<peer>` — unknown routing" attention item per failed
peer-resolution, every sweep, forever — and because `createAttentionItem` spawns
a brand-new forum topic per item, that became a wall of topics. Two fixes landed
— a per-feature cleanup AND a structural backstop so the *class* of bug can't
recur regardless of which feature misbehaves next.

**1. Structural backstop — `AttentionTopicGuard` (the lockdown).** A per-source
circuit breaker now sits at the one chokepoint, `TelegramAdapter.createAttentionItem`.
If a single attention `sourceContext` exceeds its topic budget within a rolling
window (default: 3 topics / 10 min), further **non-critical** items from that
source are COALESCED into ONE running "notices coalesced" topic and recorded in
`state/attention-suppressed.jsonl` — never a wall of new topics. Invariants:
HIGH/URGENT items are **never** coalesced (critical messages always get their own
topic), and **no item is dropped** — only its per-item topic is withheld; the
item is still in the attention store. Ships **enabled by default in code**, so
every fleet agent is protected on the dist update with zero config.

**2. Per-feature cleanup — `CollaborationRedriveEngine`.**
- "can't reach / unknown routing" is now **log-only housekeeping** — it never
  raises an attention item (so it never spawns a topic) and never re-fires. The
  old code reset its strike counter to 0 after each escalation, which is why it
  flooded forever.
- A `relatedAgent` that is **already a 32–64-char hex routing fingerprint** now
  resolves directly instead of failing a name lookup that can never match (the
  `can't reach 8c7928aa…` entries; CMT-663).

## What to Tell Your User

- The "wall of topics popping up out of nowhere" problem is fixed at its root.
  If any background feature ever tries to flood the chat with notices again, it's
  now capped automatically: a few at most, then everything folds into one quiet
  "notices coalesced" topic, with the detail kept in the logs. Genuinely critical
  alerts (HIGH/URGENT) are never affected — they always come through on their own.
- No action or config needed; it's on by default.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Attention topic-flood circuit breaker | Automatic, on by default. Tune via `messaging[].config.attentionTopicGuard` = `{ "enabled": true, "windowMs": 600000, "maxTopicsPerSource": 3 }`. |
| Suppressed-notice audit trail | When a source is coalesced, each item is logged to `state/attention-suppressed.jsonl`. Read it to answer "why are my notices grouped / where did topic X go?" |

## Migration Notes

The guard is **pure `src/` logic, default-ON in code** (`AttentionTopicGuard` +
`TelegramAdapter`) — no agent-installed file changed, so every agent receives the
protection through the normal dist update with nothing to patch. A
`migrateClaudeMd()` entry backfills the **Topic-Flood Guard** awareness section
into existing agents' CLAUDE.md (idempotent). `collaborationRedrive` keeps its
ship-OFF default; the fix only makes it safe for agents that turn it on.

## Evidence

- Unit: `tests/unit/AttentionTopicGuard.test.ts` (8) — budget/coalesce/critical-bypass/episode-reset;
  `tests/unit/CollaborationRedriveEngine.test.ts` (+2) — unresolvable peer never raises attention; hex peer resolves directly;
  `tests/unit/PostUpdateMigrator-topicFloodGuard.test.ts` (2) — migrator backfill + idempotency.
- Integration: `tests/integration/attention-topic-flood-guard.test.ts` (3) — REAL `TelegramAdapter`: a flooding source is capped at budget+1 topics, HIGH bypasses, other sources unaffected, no item dropped.
- E2E: `tests/e2e/attention-topic-flood-guard-lifecycle.test.ts` (1) — fleet default (NO config) still caps a flood (migration-parity guarantee).
