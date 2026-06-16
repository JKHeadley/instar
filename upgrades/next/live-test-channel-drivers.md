# Live-test real-channel driver core (DemoChannelRegistry + RealChannelDriver)

## What Changed
Added the two pure core modules behind the `LiveTestHarness`'s `ChannelDriver` seam (spec: live-user-channel-proof-standard §5.3/§5.4):
- `DemoChannelRegistry` — verifies a signed demo-channel bindings doc; fail-closed `isDemoChannel(surface, channelId)` (absent or signature-invalid → zero demo channels). Canonical payload is an ordered JSON tuple so a signature can never be reused on a different binding set (closes a delimiter-collision bypass caught in second-pass review).
- `RealChannelDriver` — the production `ChannelDriver`: composes per-surface `SurfaceSender`s, dispatches send/awaitReply, and stamps `responderMachineId` on each reply via an injected placement reader (the deterministic cross-machine proof). Degrades-not-throws on a placement-read error; throws loudly on a missing surface sender (never a silent skip).

Ships DARK — not wired into server.ts. The real Telegram/Slack surface senders + the runner route are the next increment.

## Evidence
- `tests/unit/DemoChannelRegistry.test.ts` — 9 tests: valid signed bindings resolve, absent → 0, tampered/forged/throwing-verify all fail-closed, cross-boundary signature-collision rejection, absent-vs-empty distinguishability, canonical order-independence + field-sensitivity.
- `tests/unit/RealChannelDriver.test.ts` — 7 tests: send dispatch, responderMachineId stamping, null-reply short-circuit, placement-error degrade, missing-sender loud throw, isDemoChannel delegation, null-responder.
- `tsc --noEmit` clean. instar-dev gate green (converged+approved spec, side-effects + second-pass review).

## What to Tell Your User
Nothing yet — this is internal infrastructure for the gold-standard live-testing harness and ships dark (no runtime surface, no behavior change). The user-visible payoff lands when the harness runs end-to-end and proves a feature through the real Telegram/Slack channels before they ever test it.

## Summary of New Capabilities
None user-facing in this increment. Internally: the building blocks that let the live-test harness drive real user channels and assert WHICH machine served a reply (the cross-machine seat-move proof). No new routes, no config, no flags flipped.
