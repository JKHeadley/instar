# Side-Effects Review — DNS sandbox test names its own Node

## Summary of the change

Tier 1, one test file, 3 added lines and 1 removed. `tests/integration/feedback-execute-dns-sandbox.test.ts` ran `node -e ...` inside the sandboxed shell, which needs `node` on that shell's PATH. Local Verify on the M5 Pro has none there, so the test failed every PR that machine verified (2733, 2925 and 2874 on 2026-11-07). The command now names `process.execPath`, quoted. Effort: one commit, no spec rounds.

## Decision-point inventory

None. Test-only change; no runtime decision point.

## 1. Over-block

No issue identified. The test refuses nothing new.

## 2. Under-block

No issue identified. The DNS settings assertions and the 45-second limit are unchanged, so a real DNS hang still fails. The test no longer checks that `node` is on the sandboxed PATH; it never meant to.

## 3. Level-of-abstraction fit

The fault was in the test's assumption about PATH, so the test is the right layer. The executor's own child processes are not changed.

## 4. Signal vs authority compliance

Not applicable: no gate, detector or authority. See docs/signal-vs-authority.md.

## 5. Interactions

The sandbox must be able to read the Node binary at `process.execPath`. On the M5 Pro that path is under the user's home folder, and the fixed test passes there.

## 6. External surfaces

None. No shipped file changes.

## 7. Multi-machine posture

This is the point of the fix: the test now passes the same way on every verifier, whether or not `node` is on its PATH.

## 8. Rollback cost

Revert the commit.

## Verification

On the M5 Pro, in the Local Verify run tree for PR 2874, the old file failed with `/bin/bash: node: command not found` and the new file passed (1/1). It passes on the Mac Studio too.
