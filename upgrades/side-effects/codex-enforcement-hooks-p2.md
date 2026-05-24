# Side-Effects Review: Codex enforcement hooks — P2 (shell-gate works under Codex)

## Change
Closes the gap from §4.2d (as-wired-in-P1, Codex's native shell/exec/apply_patch would have passed UNGATED).
1. **stdin shim** for the two arg-reading safety scripts so they read `tool_input.command` from Codex's stdin JSON when no positional arg is present (Claude's `$1` path unchanged):
   - `dangerous-command-guard.sh` — both source copies kept consistent: `PostUpdateMigrator.getDangerousCommandGuard()` (always-overwrite/migration canonical) AND the inline duplicate in `init.ts`.
   - `grounding-before-messaging.sh` — `PostUpdateMigrator.getGroundingBeforeMessaging()` (canonical, used by migration + init).
2. **Mapping fix:** added `dangerous-command-guard.sh` to `installCodexHooks` `buildInstarCodexHookGroups()` PreToolUse group (coupled with the shim — mapping without shim would be the false-install trap).

## Why
`external-operation-gate.js` only gates `mcp__*` tools (exits 0 otherwise). Codex's destructive class is native `shell`/`exec`/`apply_patch`, which Claude gates via `dangerous-command-guard` on the Bash matcher. P1 omitted that gate from the Codex mapping, and the script couldn't read Codex's input anyway. Both fixed.

## Over/under-block
- The blocked catastrophic patterns are identical to Claude's (`rm -rf /`, `mkfs.`, `dd if=`, fork-bomb, etc.) — no Codex-specific over-block. Empty/garbage stdin → INPUT empty → no match → pass (no false-block); tested.

## Signal vs Authority
- `dangerous-command-guard` is a deterministic low-context guard on catastrophic patterns + a config safety-level gate; nuanced authority remains the server-side gate. Adding it to Codex mirrors Claude's posture — no new authority.

## Near-silence
- Blocks write the reason to **stderr** (the agent sees it), never a user message. No notification spam.

## Migration parity
- The scripts are always-overwritten on migration (getDangerousCommandGuard / getGroundingBeforeMessaging), so existing Codex agents get the shim on update; the mapping runs via refreshHooksAndSettings (P1b) on init + update.

## Rollback
- Revert the 3 shim insertions + the one mapping-line addition. No data migration.

## Tests (real, no mocks)
- Unit: 9 (incl. new assertion that dangerous-command-guard is in the Codex PreToolUse mapping).
- **Integration (the proof): 5** — generates the REAL script via refreshHooksAndSettings, then: BLOCKS `rm -rf /` via Codex stdin/no-arg (exit 2), PASSES benign via stdin, still BLOCKS via Claude arg path (regression), no false-block on garbage stdin.

## Sequencing
- Satisfies the P2 hard-constraint (shell gating works under Codex) before any P6 deploy. Remaining: PermissionRequest exit-2 confirmation (P4), the live codey E2E (P5).

## Publish
- Feature branch. Not shipped.
