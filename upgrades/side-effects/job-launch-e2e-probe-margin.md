# Side-effects review: job launch e2e probe margin

**Change:** one line in the mock `claude` script inside `tests/e2e/job-launch-lifecycle.test.ts` (`sleep 1` to `sleep 0.2`) plus its comment. No file under `src/`.

1. **Over-block:** none. No gate or decision changes.
2. **Under-block:** the test still fails if the probe takes over 2 seconds on an extremely loaded machine; the margin goes from about 1 s to about 1.8 s. It does not remove the timing dependence, it widens it. A version that never lands still fails the test, which is the test's purpose.
3. **Level-of-abstraction fit:** the fault is the fixture's delay, so the fixture is the right place. Raising the product's 2 s probe timeout would change product behaviour to suit a test.
4. **Signal vs authority:** not applicable; test fixture only.
5. **Interactions:** the first-observation assertion already accepts `unknown` or the version, so a faster answer cannot break it. The ordering claim (start row before the probe settles) is proved in the unit tier with a deferred probe, as the test's own comment states.
6. **External surfaces:** none.
7. **Multi-machine posture:** not applicable; a test file.
8. **Rollback cost:** revert the commit.

## Second-pass review

Not required: test fixture only, no decision surface.

**Reviewer:** not-required (Tier 1, test-only)
