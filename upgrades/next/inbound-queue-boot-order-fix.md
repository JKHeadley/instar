## What Changed

Fixed a boot-ordering bug that meant the **Durable Inbound Message Queue** (`multiMachine.sessionPool.inboundQueue`) could NEVER construct its engine, regardless of config. In `startServer()`, the queue-engine construction gate read the module-level `_sessionPoolStage()` getter while it was still its initial stub (`() => 'dark'`) — the real liveConfig-reading implementation is only assigned ~350 lines further down the same synchronous boot flow. So the gate's `_sessionPoolStage() !== 'dark'` test was always false at construction time, the engine never built, and `GET /pool/queue` answered 503 forever even with the feature enabled and a non-dark session-pool stage. The feature ships dark/dry-run by default, so the fleet never hit this; it only bites the first agent to enable it for real.

The fix resolves the stage INLINE at the construction site, reading the same `multiMachine.sessionPool` config (liveConfig override over the static block) via a new shared pure helper `resolveSessionPoolStage(cfg)` in `src/core/inboundQueueConfig.ts`, instead of consulting the not-yet-wired ref. The live `_sessionPoolStage` getter is refactored to call the same helper, so the two stage readers can never drift apart again (that drift was the root cause). No new capability, config key, HTTP route, or authority — purely a correction to WHEN an existing decision is read.

audience: agent-only
maturity: stable

A no-deferrals audit of all five `_sessionPoolStage()` call sites confirmed exactly one genuinely-premature boot-time read (the construction gate). The three runtime-handler reads (`wireTelegramRouting` x2, the `onAccepted` forwarded-message callback) are correct as-is: they execute per-message AFTER boot and close over the ref, so they see the wired implementation when invoked.

## What to Tell Your User

Nothing to announce proactively — the inbound queue ships disabled by default, so for any agent that hasn't deliberately turned it on, nothing changes. If asked: the crash-proof holding area for messages that arrive while a conversation is mid-move between machines had a startup bug that kept it from ever turning on; it now starts correctly when enabled. For a developer agent running it live, the queue's status page now returns real data instead of "not available." Every error path still fails toward off (no queue), which is identical to the shipped default.

## Summary of New Capabilities

No new capability — a latent behavior-correctness fix restoring intended behavior.

| Change | Effect |
|--------|--------|
| Inbound-queue construction gate reads stage inline | The queue engine constructs when `inboundQueue.enabled=true` + a non-dark `sessionPool` stage (was: never) |
| `resolveSessionPoolStage(cfg)` shared helper | Single source of truth for the pool stage; boot gate + live getter can no longer drift |

## Evidence

Behavior-correctness fix; reproduced by code-read on `JKHeadley/main` and pinned by a fails-before/passes-after structural regression guard. `tests/unit/inbound-queue-boot-order.test.ts` (5) asserts the construction gate no longer calls the stub getter, resolves inline before gating, routes both readers through the shared helper, and leaves the stub declaration intact (4 of 5 assertions fail against pre-fix `server.ts`; all 5 pass against the fix). `tests/unit/resolve-session-pool-stage.test.ts` (5) covers both sides of the stage-resolution boundary (enabled+stage→stage; disabled/missing→dark). The existing `tests/integration/inbound-queue-route.test.ts` and `tests/e2e/inbound-queue-lifecycle.test.ts` already prove a constructed engine serves a real 200 on `/pool/queue`. `npx tsc --noEmit` clean; full lint + dark-gate (24/24, line-map unchanged) + no-silent-fallbacks (baseline 474 unchanged) + feature-delivery-completeness + route-completeness green.
