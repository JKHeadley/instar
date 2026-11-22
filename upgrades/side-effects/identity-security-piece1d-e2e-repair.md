# Private PIN delivery lifecycle fixture repair

Tier 2 under the existing approved private-PIN spec: test-only reversible repair; no runtime change. One test fixture replaces a partial adapter with the real TelegramAdapter, retaining its owner-private-message hook. CI run 44939865453 showed five unhandled missing-method errors and five failures in this file. Targeted verification pending; full suites delegated to echo-increasing-throughput.

- Over-block: no runtime policy changes; existing refusal and delivery assertions retained.
- Under-block: do not hide missing production methods with optional invocation or a no-op hook. The real adapter supplies the actual method.
- Abstraction: fixture should implement the production adapter contract, rather than teach production to accept incomplete fixtures.
- Signal versus authority: docs/signal-vs-authority.md unchanged; real ingress guard remains authority.
- Interactions: adapter is not polled; apiCall is replaced to prevent external API traffic. Existing dispatch observations remain controlled.
- External surfaces: none; all files and network ingress remain inside the temporary test agent and loopback server.
- Multi-machine posture: test-local by design, temp state per test run; no replicated production state.
- Rollback: revert this test-only commit; no data migration.

Independent review identified a constructor-owned callback registry timer. Teardown now calls stopPromptGate() after server shutdown, matching its real lifecycle. No polling starts. Verification must include this teardown repair.

Review concurred after timer cleanup. Initial focused run passed all 14 tests; repeat including teardown cleanup is in progress. Full exact-head verification remains pending.

Final focused run including timer cleanup: 14/14 tests pass, no unhandled errors.

Main merge conflict resolution: preserve the owner-secret always-deliver branch and main's expanded owner-decision producer documentation. Preserve main's inbound credential masker before the private-owner trigger; the trigger reads only chat and sender metadata, never message text. No notification budget, masker policy, or PIN recipient rule is weakened. Full exact-head verification remains delegated.

Independent conflict-resolution review concurred: owner-secret rule, owner-decision budget, credential masking and private recipient rules are all retained.
