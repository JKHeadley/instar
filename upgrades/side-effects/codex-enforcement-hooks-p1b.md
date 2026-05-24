# Side-Effects Review: Codex enforcement hooks — P1b (wire installCodexHooks into init/refresh)

## Change
`src/commands/init.ts`: `refreshHooksAndSettings()` now calls `installCodexHooks(projectDir)` gated on `enabledFrameworks.includes('codex-cli')`, mirroring the existing `claudeEnabled → installClaudeSettings` block. Plus a wiring-integrity test (`tests/unit/codex-hooks-wiring.test.ts`).

`refreshHooksAndSettings` is the single path that both `instar init` (line ~1097) and the update path invoke — so this one call site covers BOTH new and existing codex agents.

## Runtime behavior change
- Codex-cli agents now get `<projectDir>/.codex/hooks.json` written on init AND on every update/refresh. Claude-only agents are unaffected (gated). Both verified by the wiring-integrity test (codex → file created with instar gates; claude-only → no file; both → file created).

## Sequencing risk (IMPORTANT — captured, not deferred-and-forgotten)
- The wiring registers the existing gate scripts (`external-operation-gate.js`, `response-review.js`, etc.) into Codex's hook events. Those scripts currently parse **Claude's** hook stdin payload; the **Codex-payload shim is P2**. So on a *live* Codex session, the scripts could misbehave (parse errors → potentially an erroneous exit-2 block) until P2 lands.
- **Why this is safe now:** this is a feature branch, NOT deployed. codey runs the released v1.2.53, which does not carry this wiring. No live codex agent has these hooks yet.
- **Hard sequencing constraint for the build:** **P2 (gate-script Codex-payload shim) MUST land before the P6 deploy.** The phase plan already orders P2 → P6; this review makes the constraint explicit. Do not deploy P1 wiring without P2.

## Signal vs Authority
- Unchanged from P1: the hooks route to the server-side authority gates; the wiring just ensures they're registered for codex agents. No new authority.

## Migration parity
- `instar init` + update both flow through `refreshHooksAndSettings`, so existing codex agents get the wiring on their next update. (A dedicated `migrateCodexHooks` / always-overwrite-instar-owned hardening is P3.)

## Rollback
- Remove the `codexEnabled` block in `refreshHooksAndSettings` + the import. No deployed effect (branch-only).

## Tests
- Wiring-integrity: 3 tests (codex → wired, claude-only → not wired, both → wired). Plus the P1a unit suite (6). tsc + lint clean.

## Publish
- Feature branch. Not shipped.
