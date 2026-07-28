# Side-Effects Review — LiveTestRunner (multi-machine transfer capstone orchestrator)

**Slug:** live-test-runner
**Spec:** docs/specs/live-user-channel-proof-standard.md §6 (apply the standard to multi-machine — the first feature)
**Files:** src/core/LiveTestRunner.ts, tests/unit/LiveTestRunner.test.ts
**Posture:** ships DARK — pure orchestration over an injected harness + transfer action. NOT wired into server.ts.

## What it is
LiveTestRunner encodes the capstone flow: (1) transfer the throwaway topic to the target machine and DEMAND the honest `seatMoved` signal (throw if it didn't move — refuse a misleading PASS over the original "ok:true but moved nothing" bug); (2) run the LiveTestHarness over a matrix that sends a real message per channel and asserts the reply was served FROM the target machine (the `responderMachine` expectation = the cross-machine proof).

## Phase 1 — Principle check (signal vs authority)
Not a decision gate over agent behavior — it's a test orchestrator. The one control-flow decision (throw on `seatMoved===false`) is a FAIL-LOUD on a test premise, not a runtime authority over messages/sessions. Compliant: it produces a PASS/FAIL artifact (a signal the completion gate already consumes), holds no blocking authority.

## Phase 4 — Side-effects answers
1. **Over-block** — n/a (no runtime block). Throwing on a non-moved seat is intended: it prevents recording a PASS when the premise failed. The alternative (running anyway) would manufacture a misleading verdict.
2. **Under-block** — the runner trusts the injected `transfer`'s `seatMoved`. If a transfer LIES (reports seatMoved=true but didn't move), the harness still catches it downstream: the reply's `responderMachine` won't equal target → FAIL. So a lying transfer can't produce a false PASS — the responder assertion is the real backstop.
3. **Level-of-abstraction fit** — correct: thin orchestration over the merged harness + an injected transfer. It does NOT reimplement transfer or the harness; it sequences them. The server.ts route injects the real `/pool/transfer` + RealChannelDriver.
4. **Signal vs authority** — compliant (produces an artifact; no authority).
5. **Interactions** — none yet (dark, unwired). When wired, it CALLS `/pool/transfer` (a real seat move on a THROWAWAY topic) then sends real messages — those surfaces are the server.ts route's review. The runner itself only sequences injected actions.
6. **External surfaces** — none in this increment (unwired). When wired, the real transfer + sends are external — but scoped to a throwaway topic/demo channel by the caller (the §5.3 isolation in DemoChannelRegistry + the throwaway-topic choice).
7. **Multi-machine posture** — this IS the multi-machine capstone: it proves a seat moves between machines and the reply is served from the destination. The `responderMachine` assertion (via the driver's placement reader, which reads the authoritative `/pool/placement`) is the cross-machine proof. No single-machine assumption — the whole point is cross-machine.
8. **Rollback cost** — trivial: dark, unwired. Revert the commit.

## No-deferrals
The server.ts route (`POST /live-test/run`) that wires the real driver + transfer, and the demo-channel sender-credential provisioning, are the NEXT tracked steps (CMT-1568, `.instar/plans/live-test-harness-drivers-BUILD.md` GATE 1/2), not deferrals of this orchestrator. This module is complete + unit-tested (5 tests: non-move throws, moved+reply-from-target PASS, wrong-machine FAIL, slack-parity scenario, empty-reply FAIL).

## Phase 5 — Second-pass review
Borderline (it has a control-flow throw), but it adds no runtime authority over messages/sessions/lifecycle — it orchestrates a test and records an artifact. The genuine cross-machine safety (no false PASS) rests on the harness's responder assertion (reviewed in #1195/#1196), which this can't bypass. Not required; noted.
