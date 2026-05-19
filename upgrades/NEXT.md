# Upgrade Guide — v1.0.10 (portability hardening 2 of 6)

<!-- bump: patch -->

## What Changed

Second of the six cross-framework portability hardening patches (v1.0.9–v1.0.14).

The Telegram reply helper script (`telegram-reply.sh`) is now also installed at
the framework-neutral location `.instar/scripts/telegram-reply.sh`, not only
under `.claude/scripts/`. The agent identity file's relay instructions now
point at the neutral path (with the old Claude path documented as a fallback
for older installs).

Before this, a Codex or Gemini agent — which has no `.claude/scripts/` folder —
was instructed by its identity file to run a relay script that did not exist,
so it could not reply on Telegram.

## Evidence

Reproduction prior to this change: configure an agent to run under Codex with
Telegram enabled. Its AGENTS.md relay section instructed `cat ... |
.claude/scripts/telegram-reply.sh`, a path absent on a non-Claude install. The
SessionStart hook already preferred the neutral path, but the neutral copy was
never installed, so even that preference fell back to the missing Claude path.

Observed after this change: `migrateScripts` installs the same generated script
to `.instar/scripts/telegram-reply.sh` (install-if-missing plus the existing
SHA-migrate guard for user-customized copies). The identity relay section now
references the neutral path. The Claude-Code copy is retained unchanged, so
Claude Code behavior is identical.

Unit verification: `tests/unit/PostUpdateMigrator-neutralRelayPath.test.ts` —
four cases: both locations installed with identical content; neutral copy
executable; idempotent on re-run; no-op when Telegram is not configured. The
IdentityRenderer assertion was updated to the neutral path plus fallback note,
and four adjacent relay-path test files were regression-checked green.

## What to Tell Your User

- "Agents running on Codex or Gemini can now reply on Telegram. The reply helper is installed in a runtime-neutral location instead of a Claude-only folder. Claude Code agents are unaffected — their existing setup is unchanged and they pick up the neutral copy on their next update."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Neutral relay script location | Automatic on update. The reply helper is mirrored to `.instar/scripts/` for every runtime. |
| Framework-neutral relay instructions | Automatic. The identity file's relay section points at the neutral path with a documented fallback. |

## Deferred (Tracked Follow-ups)

- Four remaining cross-framework portability gaps ship as v1.0.11–v1.0.14:
  framework-aware connector-server registration, framework-session-store
  abstraction, post-update-migrator framework guards, and the
  migrator/identity-renderer unification.
