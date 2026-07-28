# Side-Effects Review — Mentor live-readiness (§19.4 follow-on)

**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (converged 5 iters, approved by Justin)
**Change:** Closes the three live-promotion blockers the §19.4 Phase-5 reviewer flagged, so the
mentor can be promoted toward `live` safely: (1) **async tick** — `POST /mentor/tick` is now
fire-and-forget (202) with the result in `GET /mentor/status`.lastResult, so a slow Stage-A spawn
can't hang the request; (2) **spawn-kill-on-timeout** — `spawnStageA` kills the session and throws
on poll exhaustion (no orphaned tmux pane, no partial transcript); (3) **persist-only delivery** —
`live` mode delivers the Stage-A message by appending to a durable per-mentee outbox, never via
`threadline_send`/spawn (the structural fix for the cross-agent spawn loop).
**Files:** `src/scheduler/MentorOnboardingTick.ts`, `src/scheduler/MentorOnboardingRunner.ts`,
`src/server/routes.ts`, `src/server/AgentServer.ts`, the three mentor test files, `upgrades/NEXT.md`.

## Principle check (Phase 1)

Decision point? Same as §19.4 — signal-only loop. The new delivery path is the only outbound
action, and it is **persist-only** (queue append), gated to `live` mode, and structurally cannot
spawn a counterpart session. Still ships dormant (`mentor.enabled=false`).

## The seven questions

1. **Over-block.** Async tick returns 202 even if a tick is in-flight (`accepted:false, reason:
   in-flight`) — correct (no overlapping ticks). No legitimate action blocked.
2. **Under-block.** Spawn-kill-on-timeout closes the orphan/partial-transcript gap. Delivery is
   persist-only — it queues; whether the mentee's session ingests the outbox is the mentee's side,
   validated at the live step. The outbox write is best-effort (never throws) so a delivery failure
   can't crash a tick — a dropped message is preferable to a crashed loop while dormant/dry-run.
3. **Level-of-abstraction fit.** Async state lives on the runner (`inFlight` + `lastResult`); the
   route is a thin 202 trigger. Delivery is an injected service (pure tick stays I/O-free; the
   AgentServer impl is the only thing that touches disk). Correct layering.
4. **Signal vs authority.** Compliant. Delivery is the loop's only outbound effect, persist-only,
   live-gated. No component is gated/killed/blocked. The tick still has no authority over the user.
5. **Interactions.** `killSession` on timeout reuses the existing SessionManager kill path. The
   outbox is a new dedicated dir (`server-data/mentor-outbox/`), isolated from the ledger and other
   stores. The in-flight guard prevents the heartbeat job from stacking ticks.
6. **External surfaces.** `POST /mentor/tick` now returns 202 (was 200 with the result) for the
   enabled case; disabled still returns 200 `{ran:false,reason:disabled}`. `GET /mentor/status` gains
   `inFlight` + `lastResult`. The outbox is a local file, not an external call. Still Bearer-gated.
7. **Rollback cost.** Low. Dormant; revert restores the synchronous tick. The outbox dir is harmless
   queued data.

## Phase 5 — second-pass

The §19.4 live loop already carried a dedicated second-pass (concur, 0 blocking). This PR
*implements that reviewer's three flagged fixes verbatim* (async tick, kill-on-timeout, persist-only
delivery), so it closes their concerns rather than introducing new decision surface. Self-reviewed
against their notes; no new spawning/gating logic beyond the persist-only outbox (which is the
spawn-loop-safe shape they recommended).

## Remaining before `live`

`dailySpendCapUsd` is still a run-count cap (`maxRoundsPerDay`, a real hard spend bound) rather than
dollar accounting — tracked (<!-- tracked: topic-13435 -->). Deep Stage-B forensics + surface
assembly land in the next PR. End-to-end mentee ingestion of the outbox is validated at the live
step (test-as-self), which remains Justin's sign-off per the off→dry-run→live track.

## Testing

- Tier 1 (unit, +3 tick): delivery in live-only / not dry-run / safe-when-unwired; (+2 runner):
  startTick fire-and-forget 202 + result lands in status; disabled short-circuit.
- Tier 2 (integration): `/mentor/tick` 202-when-enabled + status.lastResult; disabled 200.
- Tier 3 (e2e): unchanged — dormant on the production path.
- route-completeness + discoverability gates pass; affected push-config suite green (745) vs main.
