# Side-effects review — Topic Operator session-start injection (Know Your Principal #898, increment 2c)

## What this change does
Adds one fetch-block to the generated `session-start` hook
(`PostUpdateMigrator.getHookContent('session-start')`) that injects the
`<topic-operator>` block at session boot — the READ side of the operator binding
shipped in #904 (store) and #906 (routes). When a topic has a verified operator,
the agent now reasons with it from message one.

## Blast radius
- **One template string edit, additive.** The block is appended after the
  existing ORG-INTENT and AUTO-LEARNED-PREFERENCES injection blocks and before the
  SESSION-BOOT-SELF-KNOWLEDGE block — modeled byte-for-byte on those two
  precedents (same `curl -sf --max-time 4` + `python3` present/block parse + echo).
- **Fail-open, three guards.** The block only runs when `$INSTAR_TELEGRAM_TOPIC`
  AND `$PORT` AND `$TOKEN` are all set. `curl -sf` emits nothing on any non-2xx
  (route 503 when the store is unavailable, or `{present:false}` for an unbound
  topic), so an unbound topic or an old server injects nothing — the session
  continues normally. A non-Telegram session (no topic env) skips entirely.
- **No new route, class, config key, or dependency.** It consumes the
  `/topic-operator/session-context` route that already shipped in #906.
- **Bearer token stays in the header** (never the URL/query), matching the other
  injection blocks.

## The security property
The injected block names the operator established ONLY from the platform-verified
sender id (the store guarantees this by construction — #904). The hook merely
surfaces that verified binding; it cannot itself seat anyone. So this read-side
change cannot introduce a Caroline-class identity bleed — it can only make the
ALREADY-verified operator visible to the agent at boot.

## Compaction parity (constitutional)
The same fetch is ALSO wired into `getCompactionRecovery()` — its compaction twin —
so the verified operator is re-injected after a context reset, not presumed to
survive in the compaction summary (the `session-context-compaction-parity` standard
from PR #811, enforced by `tests/unit/session-context-compaction-parity.test.ts`).
This is thematically load-bearing for Know Your Principal: an agent that loses its
verified-operator awareness post-compaction is exactly the identity gap this feature
closes. The twin block mirrors the SESSION-BOOT-SELF-KNOWLEDGE re-injection
precedent (own `TOPIC_OP_PORT`/`TOPIC_OP_TOKEN` resolution, same fail-open contract),
and the injector is NOT added to the parity allowlist (the allowlist only shrinks).

## Migration parity
The `session-start` hook lives in the always-overwritten `instar/` hook set:
`migrateHooks()` rewrites `hooks/instar/session-start.sh` from
`getSessionStartHook()` on EVERY update run (PostUpdateMigrator.ts:1958). So this
block reaches existing agents automatically on their next update — no dedicated
migration needed, and the migration-parity-hooks unit suite stays green.

## Agent awareness (deliberately deferred)
No CLAUDE.md template section is added in this increment. The injected
`<topic-operator>` block is self-describing (it carries its own "do not attribute
to any other name" instruction), and the governing behavior is already in the
ratified #898 "Know Your Principal" constitution standard. The operator-binding
feature's agent-awareness capability section will be added ONCE, as a coherent
whole, when the feature is end-to-end (after the Inc-2d inbound auto-bind and the
Inc-3 guard) — rather than fragmenting it across increments. The feature-delivery
and docs-coverage gates pass without it.

## Framework generality
Framework-agnostic. The block is emitted into the generic session-start hook that
every framework's session runs; the `<topic-operator>` payload is plain text any
harness injects. The topic is resolved from `$INSTAR_TELEGRAM_TOPIC`, the same env
the existing topic-context block uses — not coupled to Claude Code, Codex, or
Gemini.

## Tests
- Tier 3 (E2E): `tests/e2e/topic-operator-hook-injection-lifecycle.test.ts` (3) —
  Phase 1 asserts the generated hook SOURCE wires the fetch; Phase 2 extracts the
  exact block and runs it against a LIVE server, proving it emits the
  `<topic-operator>` block when a topic is bound and nothing when unbound.
- Tier 1/2 for the store + route shipped in #904/#906; the analog hook suites
  (PostUpdateMigrator-bootSelfKnowledge, migration-parity-hooks,
  OrgIntentManager-session-start-format) stay green.

## Rollback
Revert the single template-string block in PostUpdateMigrator.ts + delete the E2E
test. The next update rewrites the hook without the block; nothing else depends
on it.
