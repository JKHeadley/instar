# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**ContextWedgeSentinel recovery now resolves a session's topic from disk when
the in-memory registry misses** (spec `docs/specs/context-wedge-sentinel.md`,
Follow-up section). This closes a real gap that left a wedged long-lived dev
session un-recovered.

The thinking-block-400 wedge sentinel (shipped v1.3.62, PR #485) recovers a
dead session via a fresh respawn through `SessionRefresh`, which needs the
session's Telegram topic to route the respawn. It resolved that topic from an
**in-memory** map. On a `--no-telegram` server that map is only a boot-time
snapshot, while the lifeline keeps writing new topic↔session bindings to the
registry file on disk. So a session bound AFTER the server booted resolved to
`null`, recovery bailed with `not_telegram_bound`, and the dead session stayed
dead — exactly what happened to the Codey collaboration session (topic 13435).

What landed:

- **`TelegramAdapter.resolveTopicForSessionFromDisk(sessionName)`** — a fresh,
  read-only lookup of the persisted `topic-session-registry.json`. Returns the
  bound topic or null; never mutates in-memory state; never throws (missing or
  corrupt file → null).
- **`SessionRefresh` topic resolution is now in-memory-then-disk.** It tries the
  in-memory lookup first and, only on a miss, falls back to the disk read before
  giving up. An in-memory hit short-circuits, so the hot path is unchanged.
  Genuinely unbound sessions still return `not_telegram_bound`.
- **Bonus fix** — a pre-existing flake in the wedge e2e test whose `cleanup()`
  rm-rf'd `os.tmpdir()` itself (a `path.dirname` mistake), intermittently
  breaking the next test's `mkdtemp`. Now scoped to the per-test dir.

## What to Tell Your User

- The session self-heal for the "stuck thinking-block" failure (the one that
  made sessions silently fast-fail) now also recovers long-lived dev sessions
  that were started before the server last restarted. Previously those one class
  of sessions could be detected but not auto-restarted; now they are.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Wedge auto-recovery for sessions bound after server boot | Automatic — no config. Rides the existing `monitoring.contextWedgeSentinel.autoRecovery` flag (unchanged from PR #485). |

## Migration Notes

No migration required. This is pure `src/` logic (TelegramAdapter + SessionRefresh)
with no agent-installed files changed — no `.claude/settings.json` hooks, no
`.instar/config.json` defaults, no CLAUDE.md template, no hook scripts, no skills.
Every agent receives it through the normal dist update; the `autoRecovery` config
shape already exists from PR #485, so there is nothing for `PostUpdateMigrator` to
patch.

## Evidence

- Unit: `tests/unit/SessionRefresh.test.ts` (20 pass, +3 disk-fallback cases),
  `tests/unit/telegram-registry-log.test.ts` (20 pass, +4 disk-read cases).
- Integration: `tests/integration/session-refresh-disk-topic-fallback.test.ts`
  (2 pass) — REAL `SessionRefresh` × REAL `TelegramAdapter`, disk-only binding
  recovers end-to-end (the exact Codey shape); truly-unbound still bails.
- E2E: `tests/e2e/context-wedge-sentinel-lifecycle.test.ts` (7 pass, flake fixed).
- Full related set: 114 pass across 8 files.
