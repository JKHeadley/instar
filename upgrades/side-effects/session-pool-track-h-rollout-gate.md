# Side effects — Track H part 1: rollout gate (StageAdvancer + E2E result store) (§Rollout)

## What this adds
The mechanical rollout gate for the staged dark→shadow→live-transfer→rebalance ladder. Pure components, shipped DARK (constructed in boot when the pool is enabled; the stage stays 'dark' until a green prior-stage E2E exists).

- `src/core/SessionPoolE2EResultStore.ts` — signed, append-only log of each stage's Tier-3 E2E outcome (`StageE2EResult`). recordResult (the E2E harness is the only writer) signs each row; getLatestForStage returns the most recent (a later red supersedes an earlier green); verify() is tamper-evidence; append-only history preserved.
- `src/core/StageAdvancer.ts` — the SOLE stage-config writer + the gate. advanceTo(stage) REFUSES (e2e-gate-not-passed) unless the prior stage's E2E is green for the CURRENT commit (missing/red/stale-commit/tampered → refused). reconcile() mechanically REVERTS to the prior stage when a live stage records red. 'dark' is the floor.

## Risk / blast radius
None — pure components, not yet wired into boot (the Config.ts stage-write guard + boot construction + GET /session-pool/e2e-results route land in part 2). No runtime behavior change.

## Tests
- `tests/unit/SessionPoolE2EResultStore.test.ts` — 5: signed record/read, latest-per-stage (red supersedes green), stage independence, tamper-evidence, missing-file/torn-line tolerance.
- `tests/unit/StageAdvancer.test.ts` — 9: refuse-no-result / advance-on-green / refuse stale-commit / refuse red / refuse bad-signature / refuse already-at-or-past; reconcile reverts-on-red / stays-on-green / dark-floor-noop.

## Follow-ups (Track H)
Part 2: Config.ts stage-write guard (stage-write-not-permitted for non-StageAdvancer writes) + boot wiring + GET /session-pool/e2e-results + the CI release-boundary check. The real-hardware + test-as-self proof (nickname-driven mid-conversation swap) is the culmination, which also needs the live-ingress interception + outbound mesh client (D11 activation).
