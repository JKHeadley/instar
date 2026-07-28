# Side-Effects Review: Codex enforcement hooks — P1 (installCodexHooks writer + tests)

## Change
New module `src/core/installCodexHooks.ts` + `tests/unit/installCodexHooks.test.ts` (6 tests). The module writes/merges instar's safety-gate registrations into a Codex agent's per-project `<projectDir>/.codex/hooks.json`, mapping the existing gate scripts (`external-operation-gate.js`, `grounding-before-messaging.sh`, `response-review.js`, `deferral-detector.js`, `session-start.sh`, `telegram-topic-context.sh`) to Codex's verified hook events (PreToolUse, PermissionRequest, Stop, SessionStart, UserPromptSubmit), using the verified Codex hooks.json schema.

## Scope of effect (this commit)
- **Capability-only, NOT yet wired.** This commit adds the writer + tests; it is NOT yet invoked from the init/refresh path (that is P1b, with a wiring-integrity test). So there is **no runtime behavior change** until the wiring lands — the function is inert until called.
- When wired, it writes a single file: `<projectDir>/.codex/hooks.json`. Nothing else.

## Scoping (correctness-critical)
- Writes the **per-project** `.codex/hooks.json`, never the global `~/.codex/`. The global root is shared with the operator's personal desktop Codex and every other Codex project — global hooks would intercept the operator's personal sessions. Per-project scoping confines the gates to this agent's project dir. Unit-tested (asserts the path is not under `~/.codex`).

## Merge-safety
- Instar-owned entries are identified by command path containing `.instar/hooks/instar/`. On re-run, instar groups are replaced; any user-added Codex hooks are preserved verbatim. Idempotent (re-run yields identical file). Both behaviors unit-tested.

## Signal vs Authority
- The writer carries no runtime authority. The hooks it registers are low-context triggers that route to the server-side authority gates (`/operations/evaluate`, `/review/evaluate`). The writer just emits config; nothing in it decides allow/deny.

## Over/under-block, abstraction
- N/A — config writer, not a gate. The registered gates are the existing, unchanged authorities. No new decision boundary introduced here.

## Migration parity
- Not in this commit. `migrateCodexHooks()` (P3) will backfill existing Codex agents. Tracked in the spec phase plan; not deferred-and-forgotten.

## Rollback
- Trivial: delete the two files. No deployed effect (unwired). Once wired, removing the instar entries from `.codex/hooks.json` is a clean revert with no data migration.

## Tests
- 6 unit tests: per-project location (not global), all five events with the verified schema, absolute cwd-independent script paths, idempotency, user-hook preservation + instar replace, pure builder. All passing; tsc clean.

## Publish
- Feature branch `echo/codex-enforcement-hooks`. Not shipped; no separate publish.
