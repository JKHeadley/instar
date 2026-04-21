---
title: Lifeline Stage C — Chaos / Stress Tests
status: draft
owner: echo
related: [LIFELINE-SELF-RESTART-STAGE-B-SPEC.md]
scope: tests-only
principle-check: not-applicable
approved: true
---

# Lifeline Stage C — Chaos / Stress Tests

## What this is

Stage B shipped the version handshake + stuck-loop self-restart machinery (PR #87, merge 8b24522). It landed with 87 passing unit tests covering each module in isolation. Stage C is the **integration proof**: exercise the full Stage-B wire-up against real components (real MessageQueue, real rate-limit state file, real watchdog ticking) plus scripted stub servers so we can force each failure mode and watch the machinery react end to end.

No new runtime behavior ships in Stage C. Only tests. The deliverables are:

1. A new test file `tests/integration/lifeline/stage-c-chaos.test.ts` containing 6 scenarios.
2. A small test-only hook on `TelegramLifeline.installOrchestratorAndWatchdog()` (or its caller) that lets tests inject a fake `exitFn` so the orchestrator's exit path can be observed without calling `process.exit`. This is the minimum surgical change.

## Scope boundary

- **In scope**: Integration tests that compose real Stage-B modules, scripted stub server, fake exitFn injection point.
- **Out of scope**: Actually spawning a Node child process for the lifeline. That exists in `scripts/` as manual testing — automating it is expensive, flaky, and duplicates coverage we already get at the module boundary.
- **Out of scope**: Native-module self-heal (separate task).

## Scenarios

### S1 — Version skew 426 → self-restart
- Stub `instar` server returns 426 `{ upgradeRequired: true, serverVersion: '99.0.0' }` on forward.
- Lifeline's `forwardToServer` classifies into `ForwardVersionSkewError`, calls `handleVersionSkew`, writes a `versionSkew` rate-limit entry, asks the orchestrator to restart.
- **Assert**: fake exitFn called once with code 0, rate-limit file on disk has `bucket: 'versionSkew'`, no queued items lost.

### S2 — noForwardStuck via oldestQueueItemAge
- Enqueue a message with `timestamp` set to `Date.now() - 11 minutes` (exceeds default 10 min `noForwardStuckMs`).
- Stub server 500s every forward so the queue cannot drain.
- Manually tick the watchdog once (fake timers or direct `tick()` call).
- **Assert**: watchdog trip result includes `noForwardStuck`, orchestrator exit called, `bucket: 'watchdog'` on disk.

### S3 — conflict409Stuck trip
- Stub server returns 409 on every forward.
- Tight loop of forward attempts until `consecutive409s` grows.
- Advance fake clock past `conflict409StuckMs` (5 min default).
- Tick watchdog.
- **Assert**: trip includes `conflict409Stuck` (priority order: conflict > stuck > failures), exit called.

### S4 — Watchdog rate-limit brake
- Force one watchdog trip that succeeds (exit called, history written).
- Within the 10-minute window, force another trip.
- **Assert**: exit NOT called a second time, rate-limit reason says `within-cooldown` or similar, history still has one entry.

### S5 — Restart storm escalation (>6/hour)
- Seed `lifeline-rate-limit.json` with 5 prior restart history entries within the last hour.
- Trigger a 6th watchdog trip.
- **Assert**: `DegradationReporter.getInstance().report` called with `feature: 'TelegramLifeline.restartStorm'`. (Spy on singleton via `vi.spyOn`.)

### S6 — Queue persistence across simulated restart
- Enqueue 3 messages.
- Trigger the orchestrator's full quiesce → persist → exit sequence.
- Construct a fresh `TelegramLifeline` with the same stateDir (simulating launchd respawn).
- Peek the queue.
- **Assert**: all 3 messages present, in order, identical content.

## No production-code change

Stage C needs zero production changes. The orchestrator's `exitFn` is `(code) => process.exit(code)`; tests capture it with `vi.spyOn(process, 'exit').mockImplementation(...)`. TelegramLifeline's private methods are reached via bracket-access (`lifeline['initiateRestart']('watchdog', 'test')`) — standard vitest pattern that bypasses TypeScript's `private` modifier.

## Acceptance criteria

1. File `tests/integration/lifeline/stage-c-chaos.test.ts` exists with 6 scenarios matching S1–S6 above.
2. All 6 scenarios pass in `npm test`.
3. No existing test breaks.
4. `TelegramLifeline` production path (`NODE_ENV !== 'test'`) is unchanged in behavior: still uses `process.exit`, still installs the real orchestrator/watchdog.
5. Side-effects artifact `upgrades/side-effects/lifeline-stage-c-chaos-tests.md` filled in. Review conclusion is expected to be "test-only addition, documentation-level runtime impact."
6. Trace file in `.instar/instar-dev-traces/`.

## Risk & rollback

- Risk: surgical injection hook widens test-surface exposure. Mitigated by the `NODE_ENV === 'test'` guard.
- Rollback: revert the PR. Tests disappear; no production behavior changes.

## Review plan

- Internal review only. Stage C adds no runtime decision logic, so `/crossreview` (external models) is not invoked — the principle guard says "a test addition is a valid No answer to Phase 1."
- Side-effects review (Phase 4) will conclude test-only.
- No second-pass reviewer required (Phase 5 triggers only on guard/sentinel/lifecycle changes — Stage C is merely test harness).
