# Side-Effects Review — ContextWedge recovery: disk-backed topic resolution

**Version / slug:** `context-wedge-null-topic-recovery`
**Date:** `2026-05-28`
**Author:** `echo`
**Spec:** `docs/specs/context-wedge-sentinel.md` (Follow-up section)
**Second-pass reviewer:** `not required` (see §"Phase 5 trigger check")

## Summary of the change

The ContextWedgeSentinel (shipped v1.3.62, PR #485) auto-recovers a thinking-block-400
session wedge via a fresh respawn through `SessionRefresh`. In production it
DETECTED a wedge on the long-lived Codey collaboration session (Telegram topic
13435) but failed to recover it — escalating "respawn attempt did not clear it."

Root cause: `SessionRefresh` resolves a session's topic via
`TelegramAdapter.getTopicForSession`, which reads the **in-memory** `sessionToTopic`
map. Echo's server runs `--no-telegram`, so that map is only a boot-time snapshot
of the registry, while the lifeline keeps writing new topic↔session bindings to
`topic-session-registry.json` on disk. A session bound AFTER the server booted
resolves to `null` in-memory → `refreshSession` returned `not_telegram_bound` →
the dead session stayed dead.

This change adds a disk-backed fallback to the topic resolution used by recovery:

- `TelegramAdapter.resolveTopicForSessionFromDisk(sessionName)` — a fresh read of
  the persisted registry returning the bound topic, or null. **Pure read** — does
  not mutate the in-memory maps.
- `SessionRefresh.refreshSession` — tries `getTopicForSession` (in-memory) first;
  on a `null`, falls back to `resolveTopicForSessionFromDisk` before bailing. An
  in-memory hit short-circuits, so the disk read is a fallback, never a default.
  Genuinely unbound sessions (no binding on disk either) still return
  `not_telegram_bound` exactly as before.

**Files touched:**
- `src/messaging/TelegramAdapter.ts` (+38 lines: `resolveTopicForSessionFromDisk` + doc).
- `src/core/SessionRefresh.ts` (in-memory→disk resolution; updated header + failure message).
- `tests/unit/SessionRefresh.test.ts` (+3 cases + a `diskTopicId` mock override).
- `tests/unit/telegram-registry-log.test.ts` (+4 cases for the disk-read method).
- `tests/integration/session-refresh-disk-topic-fallback.test.ts` (new — REAL SessionRefresh × REAL TelegramAdapter).
- `tests/e2e/context-wedge-sentinel-lifecycle.test.ts` (fixed a pre-existing cleanup bug — see below).
- `docs/specs/context-wedge-sentinel.md` (Follow-up section).

## Decision-point inventory

- **Topic resolution (in-memory vs disk)** — *modify*. Was in-memory-only; is now
  in-memory-then-disk-fallback. The selection is a pure presence check
  (`inMemory ?? diskFallback ?? bail`), no judgment. Both branches are exercised
  by tests; the in-memory branch is unchanged for the common case.
- **Disk read of the registry** — *read-only, additive*. Reads the existing
  `topic-session-registry.json` that `TelegramAdapter.saveRegistry` already writes.
  No new file, no new format, no write. Wrapped in try/catch → returns null on a
  missing/corrupt file (test-covered) so it can never throw into recovery.
- **Respawn (kill + fresh spawn)** — *unchanged*. Already gated by `SessionRefresh`'s
  rate guard + in-flight guard + the sentinel's confirm window + the `autoRecovery`
  opt-in flag. This change only makes the topic *resolvable*; it does not loosen any
  guard or change when a respawn fires.

## Blast radius

- **No new authority, no new gate, no new detector.** A topic-resolution fallback
  behind an existing, already-guarded recovery primitive.
- **Hot paths unchanged.** `getTopicForSession` is untouched; its many callers
  (live-tail, SessionReaper topic-binding) behave identically. Only `SessionRefresh`
  consults the disk fallback, and only on an in-memory miss.
- **No agent-installed files changed** — no `.claude/settings.json` hooks, no
  `.instar/config.json` defaults, no CLAUDE.md template, no hook scripts, no skills.
  So **no PostUpdateMigrator entry is required**: the fix is pure `src/` logic that
  reaches every agent through the normal dist update. (`autoRecovery` config already
  exists from PR #485.)
- **Idempotent / side-effect-free fallback.** Pure read; safe to call repeatedly.

## Pre-existing-bug fix (bundled)

While running the e2e (`context-wedge-sentinel-lifecycle.test.ts`) the "live"
case failed at setup with `mkdtemp ENOENT`. The test's `cleanup()` did
`fs.rmSync(path.dirname(logsDir), …)` where `logsDir = path.join(stateDir, '..', 'logs')`
— so `path.dirname(logsDir)` resolved to `os.tmpdir()` ITSELF, and cleanup rm-rf'd
the shared tmpdir base, intermittently breaking the next test's `mkdtemp`. It only
"passed" before when the OS base happened to survive (permissions / timing). Fixed
by nesting logs INSIDE the per-test `stateDir` and cleaning up exactly `stateDir`.
Fixed here (not deferred) per the Zero-Failure Standard since it sits in the same
feature I'm shipping.

## Phase 5 trigger check (second-pass reviewer)

Second pass **not required**: no new authority, no destructive operation introduced
(the only rm-rf change *removes* an over-broad delete), no external surface, no
migration. The change is an additive, read-only fallback behind an existing
rate-guarded recovery primitive, with full three-tier test coverage (114 tests
green across the related files).

## Verification

- `tests/unit/SessionRefresh.test.ts` — 20 pass (incl. 3 new disk-fallback cases).
- `tests/unit/telegram-registry-log.test.ts` — 20 pass (incl. 4 new disk-read cases).
- `tests/integration/session-refresh-disk-topic-fallback.test.ts` — 2 pass
  (disk-only binding recovers; truly-unbound still bails).
- `tests/e2e/context-wedge-sentinel-lifecycle.test.ts` — 7 pass (flake fixed).
- Full related set: 114 pass across 8 files.
