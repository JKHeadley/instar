# Side-Effects Review — Live-Test Capstone Runner Route

**Change:** Make the (already-built, dark) multi-machine transfer CAPSTONE harness RUNNABLE.
Adds `POST /live-test/multi-machine-capstone` + `GET /live-test/artifacts`, the
`liveTestRunnerCtx` wiring (a `LiveTestRunnerWiring` factory on `AgentServer`), the
`multiMachineCapstoneMatrix` builder, and registers `liveTestRunner` in the dev-gated
feature registry. DEV-GATED + DARK (`monitoring.liveTestRunner.enabled` omitted from
ConfigDefaults → `resolveDevAgentGate`: live on a dev agent, dark on the fleet → routes
503). Driven by the converged + approved `docs/specs/live-user-channel-proof-standard.md`
(§6 / §7.5).

**Files:** `src/commands/server.ts` (ctx factory), `src/server/AgentServer.ts`
(`LiveTestRunnerWiring` type + ctor wiring), `src/server/routes.ts` (the two routes),
`src/core/multiMachineCapstoneMatrix.ts` (the §7.5 matrix builder),
`src/core/devGatedFeatures.ts` (registration). Tests: unit (matrix + runner-capstone),
integration (route 200/503/400/aborted/auth), e2e (feature-alive on the real AgentServer
init path).

## 1. Over-block — legitimate inputs wrongly rejected?
The route rejects only missing `targetMachine`/`telegramTopicId` (400). A surface whose
demo credential is absent is **not** rejected — it is recorded in `blockedSurfaces` and
its scenarios surface as a loud driver-error FAIL via `RealChannelDriver`'s "no real
sender configured" throw. No legitimate run is silently dropped: a non-moving seat is a
recorded `200 capstone:'aborted'` (the honesty contract), never a 400/500.

## 2. Under-block — failure modes still missed?
- A demo SENDER that is mis-configured (wrong token) fails at send time → the scenario
  records a driver-error FAIL (honest), not a fabricated PASS. Acceptable.
- The Slack production path uses `SlackApiClient(demoSlackUserToken)` (a Bearer xoxp
  token). Reality: the available SageMind-Live-Test creds are an `xoxc` web-client token
  + `d` cookie, not xoxp — so with today's creds the Slack surface reports
  `credential-unavailable` (blocked, HONEST) rather than running. The Telegram surface is
  the capstone's reply-from-target channel. **Tracked follow-up (CMT-1568):** an
  xoxc+cookie Slack drive variant to actually run the Slack channel-parity scenario.
  `<!-- tracked: CMT-1568 -->`
- The responder-machine resolver keys every surface on `telegramTopicId` (there is no
  live Slack-channel→topic resolver) — documented inline as a GUESS; only affects the
  optional Slack scenario. `<!-- tracked: CMT-1568 -->`

## 3. Level-of-abstraction fit
Correct layer: the route composes existing, separately-tested primitives
(`RealChannelDriver`, `TelegramLiveSender`/`SlackLiveSender`, `LiveTestHarness`,
`LiveTestRunner`, `PlacementResponderReader`, `DemoChannelRegistry`) and the shared
`LiveTestArtifactStore` (the SAME store `LiveTestGate` reads, so a run's artifact is
exactly the artifact the gate later verifies). No business logic is re-implemented in the
route — it is composition + request validation + the seat-move-first orchestration the
standard mandates.

## 4. Signal vs authority compliance
The route holds **no blocking authority over agent behavior**. It runs a test harness and
records a signed artifact. The only authority-adjacent component (`LiveTestGate`, which
computes a completion veto) is unchanged by this PR and remains dry-run. The route is a
pure producer of an observable artifact — Signal, not Authority. (`docs/signal-vs-authority.md`.)

## 5. Interactions
- Shares the `LiveTestArtifactStore` instance with `LiveTestGate` by construction (server.ts
  threads the SAME store into both) — verified by the e2e wiring-integrity test (d).
- The seat-move calls the LOCAL `/pool/transfer` (production) — same route the operator
  uses; it is read through the honest `seatMoved` signal (the #1188 fix), never assumed.
- `transferForRequest` / `driverForRequest` are TEST-ONLY injection seams (undefined in
  production); they let the e2e exercise the real AgentServer route with no live pool/network.
- No double-fire / no shadowing: the routes are new prefixes; CapabilityIndex +
  feature-delivery-completeness ratchets pass.

## 6. External surfaces
When RUN on a dev agent it posts a real demo message into a real (throwaway) channel and
moves a real seat — but it is DEV-GATED + DARK, requires explicit demo creds, and every
scenario is `safe`-volatility. On the fleet the routes 503 (no external effect). The run
is operator-gated in practice (demo-sender provisioning + a live destination machine).

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN.** The artifact store + the route are per-machine: the capstone
is RUN from one machine (the test driver) and asserts the reply was served FROM the target
machine via `PlacementResponderReader` (GET /pool/placement). The cross-machine fact being
PROVEN is the responder identity; the runner itself does not replicate state. Recorded
artifacts are local observability (like the live-test gate's). No generated URLs; no
user-facing notice (dark infra) → no one-voice concern.

## 8. Rollback cost
Trivial. Dark by default (503 on fleet). Back-out = omit/disable
`monitoring.liveTestRunner.enabled` (already the fleet default) or revert the PR — no data
migration, no agent-state repair. The shared store is additive (read-only to the gate).

## Second-pass review
**Not required.** The change adds a test-harness RUN route with no block/allow authority
over agent behavior, no session-lifecycle mutation, and no gate/sentinel/watchdog decision
logic. It interacts with `LiveTestGate` only by sharing an artifact store (read path
unchanged). The seat-move uses the existing honest `/pool/transfer` contract. Risk is
bounded by the dev-gate + dark default + safe-only scenarios.
