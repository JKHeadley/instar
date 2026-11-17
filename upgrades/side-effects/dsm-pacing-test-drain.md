# Side-effects review: DesktopStreamManager pacing test waits for the first stream to drain

**Change:** test-only. `pacingDelays()` in `tests/unit/DesktopStreamManager.test.ts` replaces a fixed 150 ms pause after `manager.closeAll()` with a drain wait: poll every 50 ms until no setTimeout in the 5–67 ms pace range has been scheduled for 250 ms, capped at 5 s.

**Evidence:** PR 3255 (secret store, no desktop code) failed unit shard 2/4 three times on `DesktopStreamManager.test.ts:66 expected 67 to be less than or equal to 50` (run 43954572952 node 22, twice; run 43986607817 node 20 and node 22), after #3223 was already on main. The file passes locally (3 of 3 before the change, 2 of 2 after). I could not reproduce the CI load locally, so the "fails without the fix" step is the CI history, not a local run.

1. **Over-block:** none. No runtime surface.
2. **Under-block:** if the first stream never stops ticking (a real `closeAll` bug), the wait ends at 5 s and the assertion still fails, which is the correct signal.
3. **Level-of-abstraction fit:** the flake is in the test's measurement, not in product code. `closeAll` terminating sockets asynchronously is the intended behaviour.
4. **Signal vs authority:** no decision point. A test change only.
5. **Interactions:** adds up to 5 s worst case to one unit test; typically about 300 ms.
6. **External surfaces:** none.
7. **Multi-machine posture:** not applicable (test only).
8. **Rollback cost:** revert the commit.
