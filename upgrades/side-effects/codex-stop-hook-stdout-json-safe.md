# Side-effects — codex Stop hook stdout JSON-safe (emit())

## 1. What files/state does this change touch at runtime?
The shared `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` (a built-in skill hook).
On update, `migrateAutonomousStopHookTopicKeyed` re-writes the deployed copy for stock agents.
No config keys, no new files, no new state.

## 2. Does it change any decision (block vs approve)?
No. The hook's keep-going-vs-stop logic is untouched. Only the CHANNEL of human-facing
approve/status text changes, and only in codex mode (stdout → stderr). The block-decision JSON
is unchanged and still on stdout.

## 3. Does it affect the Claude path?
No — Claude behavior is byte-for-byte preserved (approve messages still print to stdout). A
dedicated test asserts the Claude approve-path still writes "Emergency stop detected" to stdout.

## 4. Migration parity — do existing agents get it?
Yes — that's the point. The marker is bumped `CODEX_LOOP_ENABLED` → `codex-stdout-json-safe`,
so every existing #28 install re-deploys the fixed hook on its next update (the old marker
would have skipped them since they already carry it). Customized hooks (no stock fingerprint)
are left untouched. Idempotent (re-running sees the new marker → skips). Covered by 7 migration
tests.

## 5. Could it spam / flood / burn resources?
No. The change is a stdout→stderr redirect of a few echo lines in approve paths. No loops, no
network, no new process, no message send.

## 6. Rollback / off-switch?
The #28 driver itself remains flag-gated (`autonomousSessions.codexLoopDriver`, default off) —
this fix just makes the hook safe to run when that flag IS on. Reverting this PR restores the
prior hook (and the bug); no residual state. The fix is inert for Claude agents and for codex
agents with the flag off (they hit the early `exit 0` dark-gate before any approve path).

## 7. Concurrency / ordering?
None — the hook is a short-lived per-stop process; no shared state introduced.

## Blast radius
Minimal + targeted. One built-in hook script (4 approve paths: stdout→stderr in codex mode) +
one migration-marker bump + test coverage. No runtime route, sentinel, schema, or decision
path changes. Unblocks safe enablement of the already-shipped (dark) #28 driver.
