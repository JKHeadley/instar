# Side-Effects Review — Live-Test Real Channel Driver core (DemoChannelRegistry + RealChannelDriver)

**Slug:** live-test-channel-drivers
**Spec:** docs/specs/live-user-channel-proof-standard.md §5.3 (Demo Channel Isolation) + §5.4 (Platform-Sanctioned Automation)
**Files:** src/core/DemoChannelRegistry.ts, src/core/RealChannelDriver.ts, tests/unit/DemoChannelRegistry.test.ts, tests/unit/RealChannelDriver.test.ts
**Posture:** ships DARK — two pure/injectable core modules, NOT yet wired into server.ts. No route, no runtime construction. The surface senders + runner route are the next increment (`.instar/plans/live-test-harness-drivers-BUILD.md`).

## What it is
The production-side building blocks for the `LiveTestHarness`'s `ChannelDriver`:
- **DemoChannelRegistry** — verifies a SIGNED demo-channel bindings doc and answers `isDemoChannel(surface, channelId)`. Fail-closed: an absent OR signature-invalid doc grants ZERO demo channels.
- **RealChannelDriver** — composes one `SurfaceSender` per surface, dispatches `send`/`awaitReply`, and stamps `responderMachineId` on every reply via an injected `resolveResponderMachine` reader (the cross-machine proof the harness asserts on).

## Phase 1 — Principle check (signal vs authority)
This increment touches a decision point — `isDemoChannel` gates whether a volatile/permission scenario may run on a given channel (§5.3). Analysis per `docs/signal-vs-authority.md`:
- **DemoChannelRegistry is a SIGNAL, not the authority.** It returns a boolean; the *authority* that refuses a run is the already-merged `LiveTestHarness.run` (it throws `HarnessVolatileChannelError`). The registry never blocks anything itself.
- The registry's logic is **fail-closed**, which is the safe direction for a §5.3 isolation check: a false "not a demo channel" only refuses a test; a false "is a demo channel" would let a destructive scenario touch the live operator channel. Verification failures (tampered/absent/throwing verify) all collapse to "no demo channels."
- **RealChannelDriver holds no decision authority** — pure transport composition. The one place it could mask a failure (a missing surface sender) throws LOUDLY rather than silently returning "no reply" (which the harness would misread as a clean FAIL).

Verdict: compliant. No brittle check with blocking authority added.

## Phase 4 — Side-effects answers
1. **Over-block** — `isDemoChannel` could return false for a channel that IS legitimately a demo channel if its signed bindings are absent/stale. Effect: a volatile scenario is refused (the harness throws) rather than running. That is the intended fail-closed direction — it never lets the scenario through, only ever refuses. Safe scenarios (the headline transfer-capstone) don't consult demo status, so they're unaffected.
2. **Under-block** — the registry only vouches for channels in the signed list; it can't detect that a *non-demo* channel is secretly safe. By design — the harness simply requires volatile scenarios to be on a registered demo channel. No false "allow."
3. **Level-of-abstraction fit** — correct layer: the registry is a pure data/verification helper feeding the harness gate (which already owns the §5.3 throw). The driver is the transport adapter the harness's injected-`ChannelDriver` seam was explicitly designed for (`LiveTestHarness.ts:8-11`). Neither reinvents a higher-layer gate.
4. **Signal vs authority** — see Phase 1. Compliant (registry = fail-closed signal; harness = authority; driver = transport).
5. **Interactions** — none yet: nothing constructs either class at runtime (dark). When wired, the driver composes existing senders + the `/pool/placement` reader; it does not shadow or double-fire any existing check. The registry reads a NEW state file (`state/demo-channel-bindings.json`) that no other component touches.
6. **External surfaces** — none in this increment. No route, no message send, no other-agent-visible change. (The eventual senders WILL drive real Telegram/Slack — that surface lands in the next, separately-reviewed increment.)
7. **Multi-machine posture** — `responderMachineId` is the feature's whole multi-machine point: the driver resolves WHICH machine served a reply (via the injected placement reader, which reads the authoritative `/pool/placement`, proxied to the lease-holder). The DemoChannelRegistry is **machine-local BY DESIGN** — demo-channel bindings are an operational/test-fixture fact of the machine running the harness; the harness runs on one machine at a time and asserts cross-machine behavior THROUGH the channel, not by replicating bindings. No silent single-machine assumption: the cross-machine dimension is carried explicitly by `responderMachineId`.
8. **Rollback cost** — trivial: dark, unwired code. Back-out = revert the commit (or simply never wire it). No data migration, no live state, no fleet behavior change.

## No-deferrals
The surface senders + runner are NOT a deferral of THIS increment — they are the next tracked increment (CMT-1568, `.instar/plans/live-test-harness-drivers-BUILD.md`). This increment is complete and self-contained: both modules are fully implemented (no stubs/TODOs) and fully unit-tested (16 tests, both sides of every boundary — valid/tampered/absent/throwing/collision/empty-vs-absent for the registry; dispatch/stamp/degrade/missing-sender for the driver).

## Phase 5 — Second-pass review
An independent reviewer subagent audited the modules + this artifact adversarially.

**Concern raised (and RESOLVED):** `canonicalBindingsPayload`'s per-binding encoding was a delimiter-free concatenation (`${surface}${channelId}${workspaceId}${label}`), an ambiguous field boundary that lets a tampered binding collide to the same signed bytes — e.g. `{channelId:'C1', workspaceId:'W2'}` and `{channelId:'C1W2'}` serialize identically and share one valid signature, promoting an unvouched channelId to a demo channel. That is exactly the dangerous false "is demo" the module guards against.

**Fix applied:** the per-binding encoding is now an ordered JSON tuple (`JSON.stringify([surface, channelId, workspaceId ?? null, label ?? null])`), which makes every field boundary explicit and distinguishes an absent field (`null`) from a present empty string (`''`). The lookup `key()` was hardened the same way (defense-in-depth). Two regression tests added: a cross-boundary collision test (the tampered doc fails verification → the smuggled channel is NOT a demo channel) and an absent-vs-empty distinguishability test. (Also stripped stray `\x01` control bytes that had crept into the source — invisible and git-binary-fragile.)

Re-review verdict after fix: the collision is closed; the surface↔channelId boundary was already safe (surface is a closed enum, none a prefix of another); fail-closed paths and the driver's degrade-not-throw / loud-missing-sender behavior are correct. **Concur with the review (post-fix).**
