# Side-Effects Review — session-management build-context test race fix (Tier 1)

**Version / slug:** `session-mgmt-buildctx-race`
**Date:** `2026-06-09`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier-1 lite lane; test-only change, no runtime surface)`

## Summary of the change

`tests/e2e/session-management-e2e.test.ts` ("restores a worktree build
context on respawn") gated its `monitorTick()` snapshot on
`isSessionAlive` — true as soon as the tmux session EXISTS, before the mock
claude script has executed its `cd` into the worktree. On a loaded machine
the tick deterministically recorded the spawn dir, no restore note was
generated, and the 20s waitFor timed out (the mock exits ~10s after its
read). CI never runs the file (tmux-gated `describeMaybe`). The fix waits
for the mock's PROMPT OUTPUT (printed after the cd) before backdating and
ticking. The production feature itself was verified correct during
diagnosis: with the gate fixed, the full record→kill→respawn→restore-note
chain passes 3/3 in isolation and in-file.

## Files touched

- tests/e2e/session-management-e2e.test.ts (one waitFor predicate + comment)

## 1. Over-block / 2. Under-block

Test-only. The new predicate ('bypass permissions on' in the pane) is
printed unconditionally by the mock after its cd; if the mock ever hangs the
test fails at the same 10s waitFor with a clearer signal (no output) instead
of a misleading downstream timeout. No legitimate pass becomes a fail; the
prior false-fail mode is removed.

## 3-5. Fit / signal-vs-authority / interactions

No runtime decision point; no interaction with other tests (predicate is
scoped to this spawn's pane). The sibling home-session phase keeps its
existing gate deliberately: for it, an early snapshot records spawnCwd ==
currentCwd — the same no-op outcome its assertion checks, so it is
race-immune in the asserted direction.

## 6. External surfaces

None. 7. **Rollback cost:** revert one test hunk.

## Conclusion

Tier-1 test-only timing fix; declared with `--tier 1`.
