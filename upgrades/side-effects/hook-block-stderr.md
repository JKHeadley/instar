# Side-effects review — grounding hook block-output → STDERR

Live incident (2026-06-05): the message-quality gate (convergence check inside the
grounding-before-messaging PreToolUse hook) correctly BLOCKED several outbound
messages — but wrote the findings + block banner to STDOUT. On a PreToolUse exit-2
block, Claude Code surfaces ONLY STDERR, so every block rendered to the agent as
"hook error ... No stderr output": a malfunction instead of a verdict. The agent
(me) retried blind several times before diagnosing via direct hook invocation.

## 1. The change

Both copies of the hook source (the `src/templates/hooks/` init-time file AND the
inline `PostUpdateMigrator.getGroundingBeforeMessaging()` that migrateHooks
always-overwrites onto every agent) now route the block findings + banner to
STDERR. The pass path (GROUNDED on stdout, exit 0) is unchanged.

## 2. Migration parity

Built-in hooks in `.instar/hooks/instar/` are ALWAYS overwritten on every
migration run — the fix reaches every deployed agent automatically on the next
update; no new migration code needed.

## 3. Blast radius

Two-line behavioral change inside an existing block branch. The gate's
DECISIONS are untouched — only where the explanation lands. No config, routes,
or schema.

## 4. Test coverage

6 tests (3 × both template copies via describe.each): block → exit 2 + findings
on STDERR with stdout clean; pass → exit 0 + GROUNDED on stdout; non-messaging
input untouched. Run against the REAL hook sources with a stubbed quality check.
