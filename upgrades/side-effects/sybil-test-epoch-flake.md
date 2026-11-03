# Side effects: SybilProtection wrong-IP test flake

Test-only change. `rejects solution for wrong IP` solved an 8-bit challenge and checked the same nonce against another IP. The nonce search is deterministic within a 10-minute epoch, so in about 1 epoch in 256 the wrong IP also had 8 leading zero bits and every test run in that 10 minutes failed (seen 2026-11-03 05:50-06:00Z on PRs 2639 and 2640). Raising the test's difficulty to 16 bits makes that 1 in 65536 epochs; solving costs about 65k hashes (well under a second).

1. Over-block: none (test only). 2. Under-block: the chance is lowered, not removed. 3. Level: test. 4. Signal vs authority: no decision point. 5. Interactions: none. 6. External surfaces: none. 7. Multi-machine: none. 8. Rollback: revert the one test line.
