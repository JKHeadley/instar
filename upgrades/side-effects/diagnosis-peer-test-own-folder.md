# Side-Effects Review — A test stops depending on one fixed folder name

**Version / slug:** `diagnosis-peer-test-own-folder`
**Tier:** 1 (one test line; a revert fully undoes it)
**Second-pass reviewer:** not required (test-only, no gate logic changed)

## Summary of the change

`tests/unit/localVerify/FailedFileDiagnosisPeerService.test.ts` used a fixed attempt id, so its temp folder under /tmp had a fixed name. A leftover owned by `_instarharness` makes `mkdir` fail for every later run. The id is now random per run.

## Decision-point inventory

None changed. The test sits behind the merge gate; the gate's logic is untouched.

## 1. Over-block

Removes one: a machine-state leftover was blocking unrelated PRs.

## 2. Under-block

The test still asserts the same behaviour. A mid-test crash can still leave a folder, but it can no longer collide with a later run. Why the 2:06 PM run left the folder was not traced; the test's own cleanup removes it on a normal finish.

## 3. Level-of-abstraction fit

Right layer: the fault is the test's fixed name, and real attempts use their own ids.

## 4. Signal vs authority compliance

Not applicable. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

The same line is in PR 2885, which will drop it on rebase. Tests that run in the same file use the id through `req`, so they all follow the new value. One test uses a second fixed id, `'2'.repeat(32)`, in a state-only path that makes no /tmp folder.

## 6. External surfaces

None. Test-only.

## 6b. Operator-surface quality

No operator surface. The effect is held PRs moving again.

## 7. Multi-machine posture

Test-only, so each machine's runs benefit once they run this version.

## 8. Rollback cost

Revert the line. No stored state.
