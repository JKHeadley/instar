# Side effects: locked-proof test cleanup in local-verify clones

Change: `tests/unit/desktop-locked-proof-fixes.test.ts` gains the same `cleanupScope` helper its sibling tests use. Test-only.

1. Over-block: none. It removes a false failure.
2. Under-block: none added. The source-tree guard is unchanged; only this test's own stand-in cleanup passes the existing carve-out.
3. Level fit: right layer. The guard behaved correctly; the test omitted the scope its siblings pass.
4. Signal vs authority: no decision point touched.
5. Interactions: stops the two false failures on verify clones outside an agent's `.instar` path, which were holding PRs on the M5 Pro peer.
6. External surfaces: none.
7. Multi-machine posture: test code only; the fix applies on every verify machine.
8. Rollback: revert the commit.
