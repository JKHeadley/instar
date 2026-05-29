# Side-effects review — secret-externalization hook resolver audit

## What changed

Two related fleet-wide classes are fixed in one PR.

1. **Auth-token reads survive secret-externalization.** Every shipped shell hook, shell script, Node helper, and migrator-emitted template string that resolves the instar server's `authToken` now:
   - Prefers `INSTAR_AUTH_TOKEN` env (set by `SessionManager` per spawned session and by `JobScheduler` per scheduled job — always available inside the Claude Code session).
   - Falls back to reading `config.json` with a string-type guard. When `SecretMigrator` has externalized the token, on-disk `authToken` is the literal placeholder `{ "secret": true }`; the guard rejects it and yields empty so the placeholder cannot leak as a Bearer.
2. **Port-parse regex tolerates whitespace.** `grep -o '"port":[0-9]*'` is replaced by `grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+'` + digit-only extraction. The previous form silently produced empty PORT whenever `config.json` had `"port": 4042` (with space) — and our prettified configs all do — making every history-injection hook exit early on a healthy install. Both bugs together produced the 2026-05-29 silent-history failure.

## Why

The 2026-05-29 incident: Justin's `telegram-topic-context.sh` stopped injecting topic history after the agent compacted. The hook silently 403'd because `authToken` had been moved to the encrypted secret store and the hook was still reading the literal `{ secret: true }` placeholder out of `config.json` as a Bearer token. The agent came back with no topic context, sent an incoherent reply, and Justin had to manually trace the root cause back. This is the SECOND time a script in this class has bitten a deployed agent (the 2026-05-28 `telegram-reply.sh` 403 was the first), so the fix is structural: env-first everywhere + string-type guard + lint that catches the broken pattern + migrator that upgrades stale-on-disk copies.

## Risk surface

- **Hook scripts (always-overwritten):** `session-start.sh`, `compaction-recovery.sh`, `telegram-topic-context.sh`. Existing agents get the fix on first auto-update. The canonical content lives inside `PostUpdateMigrator.getHookContent()`; the parallel `src/templates/hooks/*.sh` files are kept in sync (the manifest tracks their SHA256). Risk: low — these are already overwritten on every migration tick.
- **Reply scripts (SHA-based migration):** `telegram-reply.sh` upgrades via `migrateReplyScriptToPortConfig` (pre-PR SHA `371d7e8f…` is already in the prior-shipped allowlist; agents get the fix on first auto-update). `slack-reply.sh` and `whatsapp-reply.sh` upgrade via `migrateReplyScriptTo408`, extended to also fire when `INSTAR_AUTH_TOKEN` is missing — previously the function skipped any script with HTTP 408 handling, which would have stranded a 408-aware-but-auth-broken copy forever. Risk: low — the marker-string check still protects custom forks.
- **Auxiliary scripts (new migration):** `imessage-reply.sh`, `serendipity-capture.sh`, `slack-channel-context.sh` get a new `migrateSecretExternalizationSurvivability` pass that upgrades shipped copies and skips custom forks (shipped-marker check). Risk: low — guarded by both the marker check and the negative `INSTAR_AUTH_TOKEN` check.
- **CLI/in-process callers:** `gate.ts` and `nuke.ts` did raw `JSON.parse(fs.readFileSync('config.json'))` then `cfg.authToken` directly. Patched to env-first + string-type-guard. The other CLI commands go through `loadConfig()` (which calls `mergeConfigWithSecrets`) and are already safe. Risk: low — the change is the same env-first/string-guard pattern.
- **Daemons:** `listener-daemon.ts` (HMAC-derives a signing key from `authToken`), `mcp-stdio-entry.ts` (uses `authToken` as the inbound Bearer). Both now env-first + string-type-guard. Risk: low — the env-first path is preferred when the daemon is launched by the spawn pipeline (which exports the var); the disk fallback still works for plaintext-config installs.
- **CI / lint:** new unit test `secret-externalization-hook-resolver-lint.test.ts` greps every shell + Node read of `authToken`. The lint MUST go green on the fixed tree (verified) and MUST fail on any re-introduction of the broken pattern (verified via destructive negative test). Risk: low — the lint is allowlisted for in-process `loadConfig` callers; future authors won't trip on the safe path.

## Bug surfaces eliminated

- Topic-history injection silently 403s after secret externalization. (Direct cause of the 2026-05-29 incident.)
- `telegram-reply.sh` 403s when invoked from a session whose env is missing — partially mitigated in the 2026-05-28 fix but the audit confirmed the disk-fallback path was still broken; this PR closes both halves.
- `session-start.sh` could not fetch working-memory or shared-state after externalization (same root cause as the topic-history bug).
- `compaction-recovery.sh` lost its post-compaction memory query after externalization.
- A standby-machine daemon whose key derivation went through `authToken` would silently derive a key from `{ secret: true }` and lose peer connectivity. (Speculative — no incident observed, but the path was broken.)

## Migration footprint

- `migrateHooks()` already always-overwrites the three canonical hooks → existing agents heal automatically on next auto-update.
- `migrateScripts()` already SHA-migrates `telegram-reply.sh` and now (with the extended INSTAR_AUTH_TOKEN check) auto-migrates `slack-reply.sh` + `whatsapp-reply.sh` when the previously-shipped marker is present.
- `migrateSecretExternalizationSurvivability()` (NEW) auto-migrates `imessage-reply.sh`, `serendipity-capture.sh`, `slack-channel-context.sh`. Idempotent on the post-fix shape.

## Testing

- Unit (lint): `tests/unit/secret-externalization-hook-resolver-lint.test.ts` — 3 tests. Greps `src/templates/`, `src/`, `scripts/` for the broken pattern; verified negative (broken pattern caught) and positive (clean pattern passes).
- Unit (migrator): `tests/unit/secret-externalization-survivability-migrator.test.ts` — 5 tests. Seeds broken state, runs `migrate()`, asserts upgrade. Custom-fork test verifies the marker check protects user-modified scripts.
- Integration-grade (in `tests/unit/`): `tests/unit/secret-externalization-hook-injection.test.ts` — 2 tests. Spins an in-process stub server (bound to all interfaces; ASYNC `spawn` is required because `execFileSync` blocks Node's event loop and freezes the stub). Seeds `config.json` with the placeholder, runs the canonical migrator-emitted hook, asserts injection works with env-first auth and never leaks the placeholder as a Bearer.
- E2E: `tests/e2e/secret-externalization-hook-lifecycle.test.ts` — 3 tests. Simulates pre-fix agent → `migrate()` → asserts every shipped script carries the env-first canary; verifies idempotency on a second pass; verifies the canonical migrator-emitted hooks always carry the canary.

## Test count

13 new tests across 3 tiers (per Testing Integrity Standard). 29 existing related tests (`PostUpdateMigrator-time-injection.test.ts`, `compaction-telegram-context.test.ts`) remain green.
