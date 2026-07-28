# Side-Effects Review: P0 arming realpath fix (found via live-proof)

## Change
`src/core/codexHookArm.ts` — `armCodexHooks` now `fs.realpathSync(projectDir)` before building
the hooks.json path for the trust readback (falls back to the given path if it doesn't exist).
Test aligned to the canonical path.

## Why
LIVE-PROOF discovery: Codex keys its `[hooks.state]` trust entries by the CANONICAL project path
(it realpath-resolves — e.g. macOS `/tmp` → `/private/tmp`). The readback was using the symlink
path, so it false-negatived ("partial" when the agent was actually fully armed). Found while
proving auto-arming end-to-end on a throwaway scratch agent.

## Live-proof (test-as-self, the P0 acceptance)
On a throwaway scratch Codex agent (own project + real logged-in ~/.codex, isolated + restored):
reset to dark (allArmed:false) → armCodexHooks drove Codex's trust flow with ZERO human clicks
(two-prompt state machine, no bypass flags) → `armed` (all 10 hooks trusted) → `codex exec`
`rm -rf / --no-preserve-root` → **blocked**: "ERROR Command blocked by PreToolUse hook: BLOCKED:
Catastrophic command detected: rm -rf /". Idempotent re-run → `already-armed`, no re-spawn.
Scratch state + ~/.codex restored clean.

## Scope / blast radius
- One-line realpath canonicalization in the readback path; behavior-preserving on systems where
  the path is already canonical. Fixes a false-negative that would have made arming look like it
  failed (and triggered needless re-spawns). No migration impact (runtime code).

## Signal vs Authority / Over-block / Rollback
- N/A (readback path correctness). Rollback: drop the realpath call.

## Tests
- `tests/unit/codexHookArm.test.ts`: 7 green (aligned writeTrust to the canonical path). tsc clean.
- Live-proof above is the authoritative validation of the driver + arming.

## Publish
- Feature branch `echo/codex-parity-audit`. P0 bundle (ships atomic with P1).
