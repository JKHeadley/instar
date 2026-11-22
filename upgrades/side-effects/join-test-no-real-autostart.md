# Side-Effects Review — a join test no longer installs a real auto-start service

**Version / slug:** `join-test-no-real-autostart`
**Date:** `2026-11-21`
**Author:** `Echo (machine stewardship, topic 144503)`
**Second-pass reviewer:** `not required (test-only, no decision point)`

## Summary of the change

Tier 1, test-only. One test file, about 15 lines. `tests/unit/join-missing-dir.test.ts` now mocks `installAutoStart` in `src/commands/setup.ts` with `vi.mock` plus `importOriginal`, so the real join path no longer writes a LaunchAgent or a systemd user unit into the real home of the machine running the test. It adds one assertion that the stand-in was called with the test's temporary dir. Effort: no spec rounds, one commit attempt.

## Decision-point inventory

None. No product code changes, and no gate, sentinel or decision logic is touched.

## 1. Over-block

No issue identified. Nothing is blocked; one side effect of a test is removed.

## 2. Under-block

Other tests that call the real `installAutoStart` could still write into the real home. A repository scan shows the only other `joinMesh` caller (`join-persist-after-verify.test.ts`) stops with exit 1 before step 6. Tests that already mock `installAutoStart` are unaffected. A suite-wide guard that refuses writes to the real `~/Library/LaunchAgents` and systemd user directory during tests would close the class. It stays in the feedback queue (fb-2ecf9c2b-055), because this change fixes the leak that was found.

## 3. Level-of-abstraction fit

Right layer: the leak comes from the test exercising a real installer. The product behavior, where `instar join` installs auto-start for the joined home, is correct and stays.

## 4. Signal vs authority compliance

Not applicable. There is no decision point (`docs/signal-vs-authority.md`).

## 5. Interactions

No issue identified. The mock replaces only `installAutoStart`; every other export of setup.ts stays real through `importOriginal`.

## 6. External surfaces

The only external surface was the unwanted one: a service registered with launchd or systemd on the test machine. It is removed.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. This is a test file. It matters on every machine that runs the unit lane (Local Verify helpers and compute trials), and they all receive it with the repository.

## 8. Rollback cost

Revert the commit. Nothing to migrate.
