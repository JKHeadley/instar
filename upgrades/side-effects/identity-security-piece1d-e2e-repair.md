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

## Release1989 readiness refresh, 2026-11-23

Tier2 maintenance under the existing approved private-PIN spec. Merge current canonical main ec9401e5bdf28ed5ab1ff13f88e0032cc7895fc6 into PR3414d944a69c0ddb41566246534018ab51cf74337ffe in the existing clean isolated maintenance checkout. Five runtime files auto-merge without conflicts: server.ts,PostUpdateMigrator,TelegramAdapter,AgentServer,routes. No manual runtime conflict resolution or new decision authority. Trimmed one imported blank EOF line from the trust-journey account-path unit test for normal diff checking.

The prior over-block/under-block/layer/signal-versus-authority/interactions/external-surface/multi-machine/rollback assessment remains applicable. Existing private recipient selection, PIN-generation tracking, owner-secret always-deliver, owner-decision delivery controls, inbound credential masking before the metadata-only private-owner trigger and the approved fallback against locking out an owner remain intact. Prior realadapter lifecycle fixture and stopPromptGate teardown are retained. No new credential, public notification, data migration or production activation. Ordinary revert of the merge is the rollback. Native/owner-phone/recovery/PIN composition holds are unchanged.

Existing isolated maintenance branch is reused for its own readiness refresh, with canonical main merged before authored edits; no shared checkout edits, worktree guard override or runtime update. One maintenance review and one intended normal commit, no new design rounds. Focused privacy/masking/delivery units, HTTP ingress/dashboard boundaries and production lifeline lifecycle plus TypeScript are run locally; full test:all remains exclusively with throughput after Chief publishes the exact successor. Focused results do not grant full-suite credit or release any hold.

Final results and independent reviewer concurrence are recorded below on completion.

The focused HTTP allocation found another incomplete Telegram fixture in tests/integration/telegram-internal-routes-lifeline-secret.test.ts. Exact RED: the selected provenidentity case timed out3000ms and emitted TypeError ctx.telegram?.noteOwnerPrivateMessage is not a function at routes.ts32534; the unproven cases bypass that hook. Existing production E2E passes because it already uses the real adapter. Fixed the HTTP fixture in the same way: real TelegramAdapter, suppressLifelineAutoCreate, same observed dispatch callbacks and outward API replacement, and stopPromptGate on every created adapter at teardown. No assertion or production authority was weakened. Selected GREEN now completes77ms without unhandled error. Complete focused HTTP rerun and refreshed typecheck follow. This is a test-dependency correction within the current PIN-delivery readiness task; no new feature or parked-design work.

Complete HTTP rerun initially passed38of39cases and exposed one further fixture adaptation: a test assigned true to realadapter isPolling, which is getter-only. Replaced that assignment with a Vitest getter spy returning true for exactly the existing server-polling case and restored mocks during teardown. It does not start polling or change the refusal assertion; existing case still proves immediate ingress arming when this server polls.

Final focused verification passed69unit,39HTTP and14production lifecycle cases (122total), plus TypeScript noEmit, with the matching native addon loadable. Existing assertions remain unchanged; selectedRED/GREEN confirms the missing-method failure is fixed. Independent reviewer /root/review_3414_main_readiness concurs with both the fixture repair and final getter-spy delta and artifact; no source concern. Release-note wording now accurately describes the existing approved no-lockout fallback rather than promising unconditional never-group delivery before a private route exists. This is disclosure accuracy, not policy change. Full successor verification and all safety holds remain required.
