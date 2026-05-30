---
review-convergence: complete
approved: true
approved-by: justin (verbal, topic 2169: "yes! then we need to do a full, robust audit to fix this whole class of issues since it keeps coming up")
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Fleet-wide fix for the silent-403 class.** Every shipped hook, script, Node
helper, and migrator-emitted template that resolves the agent's `authToken`
now survives the secret-externalization refactor. Two related bugs landed
together because both produced the same user-visible symptom (a hook that
stops emitting any output):

- **Auth-token resolution: env-first with a string-type guard.**
  `INSTAR_AUTH_TOKEN` (set by `SessionManager` per spawned session and by
  `JobScheduler` per scheduled job) is checked first. The disk fallback now
  guards `cfg.authToken` against non-string values, so the literal
  `{ "secret": true }` placeholder produced by `SecretMigrator` after
  multi-machine pairing can never leak through as a Bearer token. (Previously,
  scripts sent `[object Object]` or `{'secret': True}` as the Authorization
  header, the server 403'd, and the script's downstream Python parser
  silently exited on the error JSON — no output at all.)

- **Port-parse tolerates whitespace.** The `grep -o '"port":[0-9]*'` pattern
  used in every hook required no whitespace between the colon and the
  number, but our prettified `config.json` writes `"port": 4042` (with
  space). The pattern silently produced empty `$PORT`, the hook exited
  early, and not a single HTTP request reached the server. Replaced with
  `grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+'` + digit-only extraction.

The structural cure includes a unit-tier lint that fails any future re-
introduction of the broken pattern (positive + negative-verified) and a new
migration pass (`migrateSecretExternalizationSurvivability`) that upgrades
deployed auxiliary scripts (`imessage-reply.sh`, `serendipity-capture.sh`,
`slack-channel-context.sh`) without touching custom forks. The canonical
always-overwrite hooks (`session-start.sh`, `compaction-recovery.sh`,
`telegram-topic-context.sh`) heal on next auto-update by the existing
`migrateHooks` path.

## What to Tell Your User

If your agent recently went silent after compaction — emitting only the
wall-clock-time block and then nothing else, despite a healthy server — this
is the fix. Topic-history injection is back. No configuration needed.

After auto-update, send yourself a Telegram message in any forum topic.
The agent's response should reference what you actually said — not greet
you like it's the first message. If it doesn't, something else is wrong;
please flag.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Auth-token resolution survives secret-externalization | Automatic. Every shipped script + hook now reads `INSTAR_AUTH_TOKEN` env first, then falls back to `config.json` with a string-type guard. |
| Port-parse tolerates JSON whitespace | Automatic. Hooks no longer exit-early when `config.json` is prettified. |
| Lint blocks future regressions | `tests/unit/secret-externalization-hook-resolver-lint.test.ts` greps every shell + Node read for the broken pattern and fails on any reintroduction. |
| Auxiliary-script migration for deployed agents | Existing agents with the old `imessage-reply.sh` / `serendipity-capture.sh` / `slack-channel-context.sh` get the fix on next auto-update via `migrateSecretExternalizationSurvivability`. Custom forks (no shipped marker) are untouched. |

## Evidence

- 13 new tests across 3 tiers (unit + integration-grade + e2e). All green on a
  full `vitest` run.
- 35 PostUpdateMigrator-* unit test files (232 tests) verified clean (no
  regression from migrator extensions).
- Manual smoke test against a real externalized agent: the fixed
  `getTelegramTopicContextHook()` content correctly fetches topic history
  with INSTAR_AUTH_TOKEN env alone (config.json holds the placeholder), and
  correctly degrades to the unauth branch without leaking the placeholder
  when env is missing.
- Side-effects review:
  `upgrades/side-effects/secret-externalization-hook-resolver-audit.md`.
