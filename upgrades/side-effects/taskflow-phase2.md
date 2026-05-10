# Side-Effects Review — TaskFlow Phase 2 (ThreadlineFlowBridge + cross-agent-callback)

**Version / slug:** `taskflow-phase2`
**Date:** 2026-05-09
**Author:** Echo
**Second-pass reviewer:** required (touches inbound message routing)

## Summary of the change

Adds `ThreadlineFlowBridge` — a small post-relay hook that consumes inbound threadline envelopes and resumes any TaskFlow flow waiting on `kind:'cross-agent-callback'`. The bridge runs *after* `messageRouter.relay()` accepts the envelope, so authentication has already passed upstream (Bearer token for same-machine, ed25519 signature for cross-machine).

Identity is taken from `envelope.message.from.agent` and matched against the flow's `waitJson.expectedAgentId`. Correlation key is read from `envelope.message.payload.correlationId` (preferred) or a `[correlation:<uuid>]` token in the body (fallback). The bridge fires `taskflow:wait-fired` with `{flowId, controllerId, waitKind, correlationId, threadId, messageId}` so the owning controller can fetch the inbound message from its own store and advance.

Files touched:
- `src/tasks/ThreadlineFlowBridge.ts` (new) — the bridge module
- `tests/unit/threadline-flow-bridge.test.ts` (new) — 8 vitest cases (happy path, body-token fallback, agent-id mismatch, threadId mismatch, no-correlation-id, no-matching-flow, replay, non-waiting flow)
- `src/server/routes.ts` — adds `RouteContext.threadlineFlowBridge`; calls `consumeInbound(envelope)` after relay-accept in `POST /messages/relay-agent`
- `src/server/AgentServer.ts` — adds `threadlineFlowBridge` option, propagates to `RouteContext`
- `src/commands/server.ts` — instantiates the bridge alongside the registry when `config.taskFlow.enabled` is true
- `upgrades/side-effects/taskflow-phase2.md` (this file)

## Decision-point inventory

- `ThreadlineFlowBridge.consumeInbound` — **add** — selectively resumes flows. NOT a block/allow gate on the message itself; the message has already been accepted by `messageRouter.relay()` upstream and is being handed downstream regardless.
- `extractCorrelationId` — **add** — structural extractor (preferred field; regex fallback). Hard-invariant validation (UUID-shape on regex). No judgment surface.
- `expectedAgentId` and `threadId` matching — **add** — equality checks against the verified envelope. Spoof defense (Threat Model § Wait-callback injection).

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The bridge does not gate the message; the message lands in the inbox regardless of bridge outcome. The bridge's "rejections" only mean "no flow was resumed by this message," which is fine — most inbound messages are not callbacks for waiting flows.

The narrowest case: a legitimate Dawn reply that lacks the `correlationId` field. The bridge silently no-ops (`reason: 'no-correlation-id'`). The threadline router still processes it for session injection. Senders are responsible for echoing the correlationId on replies; if they don't, the flow's lost-eligibility threshold (default 7 days for cross-agent-callback per spec § Sweeper threshold policy) eventually fires and the controller picks up via `taskflow:wait-fired` from the sweeper-driven `markLost` path.

## 2. Under-block

**Spoof attempts beyond the v1 threat model:**
- A malicious Threadline peer forging a reply on the same threadId with the right correlationId AND impersonating the expected agent. The defense is the verification step ahead of the bridge: `messageRouter.relay()` rejects unsigned/wrongly-signed messages (cross-machine) and rejects mis-tokened messages (same-machine). The bridge inherits that trust. If `relay()` accepts, the envelope's `from.agent` is the verified-sender for our purposes.
- Correlation guesses: a 128-bit correlationId is computationally infeasible to guess. The body-token regex requires at least 8 hex chars; the schema validator on `setFlowWaiting` requires the `correlationId` field to be ≥16 chars. Real callers use UUID v4 (32 chars).

The bridge does NOT defend against:
- A compromised owning agent (Echo) that voluntarily resumes its own flow with bogus state. That's an authority decision Echo controls, not a transport defense.
- The peer agent (Dawn) being entirely malicious. Spec § Threat Model accepts this — `expectedAgentId` is a known-good identity from the flow's setFlowWaiting time; if Dawn herself is malicious, the flow's design assumed trust she didn't deserve.

## 3. Level-of-abstraction fit

Right layer. The bridge is a thin adapter between two existing systems (Threadline message routing, TaskFlow registry). It does not own message routing (that's `MessageRouter` / `ThreadlineRouter`), it does not own state machine semantics (that's `TaskFlowRegistry`), and it does not handle session lifecycle (that's `ThreadlineRouter.handleInboundMessage`).

The bridge being a separate module (rather than logic inside `ThreadlineRouter`) is deliberate: it has distinct concerns, its own tests, and an off-switch (the bridge can be removed by setting `config.taskFlow.enabled` to false, leaving the rest of the messaging pipeline untouched).

The post-relay placement in the route handler is the right seam: relay-accept guarantees auth has run; the bridge call is fire-and-(mostly-)forget; it doesn't block or alter the threadline-router downstream call.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No** — this change has no block/allow surface.

The bridge is a *consumer* of an upstream authority decision (relay-accept). It produces a state transition (`waiting → running`) on a flow that explicitly asked to be resumed by exactly this kind of inbound. The transition itself is mechanics: equality match on `correlationId`, `threadId`, and `expectedAgentId`. Mismatch ⇒ no-op. The structural validation (correlationId ≥ 16 chars; UUID-shape regex on body fallback) is hard-invariant edge validation, exempt under the principle's "Hard-invariant validation" carve-out.

The `taskflow:wait-fired` event is a notification, not an authority signal — controllers may ignore it (the flow's state already moved; the event is just a wakeup).

## 5. Interactions

- **Shadowing**: The bridge runs BEFORE `ThreadlineRouter.handleInboundMessage`. The router's job (session resume/spawn) is independent of TaskFlow state — even if the bridge resumes a flow, the router still processes the message for session injection. Both can fire on the same envelope; that's intentional (the controller receives the wait-fired event AND the session receives the injected message).
- **Double-fire**: The bridge cannot resume the same flow twice for the same message. After `resumeFlow` succeeds, the flow's status moves to `running` and the `waitInstanceId` is cleared. A second call to `consumeInbound` finds no waiting flow with that correlationId.
- **Races**: Concurrent inbound for the same correlationId — the registry's OCC catches the second-to-resume with `revision_conflict`, which the bridge swallows (the first one won; second is a no-op). The bridge's failure mode is structurally inert: no partial state.
- **Feedback loops**: None. The bridge does not write any messages out; it only reads the envelope and writes flow state.
- **Sweeper interaction**: If the sweeper marks a long-waiting cross-agent-callback flow `lost` and then the late reply arrives, the bridge's resume call returns `revision_conflict` (sweeper bumped the revision) → swallowed. The flow stays `lost`. Operators see both events in the SharedStateLedger audit trail.

## 6. External surfaces

- **Other agents on the same machine**: No new outbound. The bridge consumes envelopes that already arrived; it doesn't generate new ones.
- **Other users of the install base**: New module is opt-in via `config.taskFlow.enabled` (default off, inherited from Phase 1). Existing installs unchanged.
- **External systems**: None.
- **Persistent state**: Writes to the same `.instar/task-flows.db` opened by Phase 1. No new files, no schema changes.
- **Timing**: The bridge call adds one synchronous SQL query (`findWaitingByCorrelation`) plus one UPDATE (`resumeFlow`) to the `relay-agent` route handler when a match exists, and just the SELECT when there's no match. The SELECT uses the indexed `wait_kind, wait_started_at` partial index on the `flows` table; lookup is O(matching rows), which is bounded by uniqueness of correlationId — usually 0 or 1 row.

## 7. Rollback cost

- **Hot-fix release**: Pure additive; `git revert` ships as next patch. The bridge is opt-in via the same flag as Phase 1, so an operator can also disable just by flipping `config.taskFlow.enabled` to false.
- **Data migration**: None. The bridge writes through the existing TaskFlow OCC API; flows resumed by the bridge are indistinguishable from flows resumed by a controller, except in the audit log (where the system-waker scope is recorded).
- **Agent state repair**: None. Active flows when the bridge is removed continue to exist; their cross-agent-callback waits will eventually fire via the sweeper's lost path or a manual `cancelFlow`.
- **User visibility**: None — Phase 1 already had no business consumers; Phase 2 maintains that.

---

## Conclusion

ThreadlineFlowBridge is a thin, no-block adapter between Threadline's already-authenticated inbound pipeline and TaskFlow's `cross-agent-callback` wait kind. It produces zero new judgment surface, depends on three deterministic equality matches (correlationId, threadId, expectedAgentId), and degrades cleanly when any match fails. The route-handler placement runs after relay-accept and before the threadline-router downstream call — the existing pipeline is unchanged. Cleared to ship pending second-pass concurrence.

---

## Second-pass review

**Reviewer:** independent code-audit subagent (general-purpose)
**Independent read of the artifact: concur**

The bridge is a thin no-block adapter that correctly inherits upstream auth (Bearer for same-machine at routes.ts ~10085, Ed25519 for cross-machine via messageRouter.relay()), and all four claimed defenses verify in code: spoof guard at `ThreadlineFlowBridge.ts` (`expectedAgentId !== senderAgent`), replay no-op via `findWaitingByCorrelation`'s `status='waiting'` filter in the store, race swallowing of `revision_conflict` in the bridge's catch, and the wait-fired event carries enough (`flowId, controllerId, correlationId, threadId, messageId`) for the controller to retrieve the inbound from the messaging store; route hook placement inside `if (accepted)` and the `instanceof Error` guard on the new catch are both correct.

---

## Evidence pointers

- Test run: `npx vitest run tests/unit/threadline-flow-bridge.test.ts` → 8/8 passing (91ms).
- Combined: `npx vitest run tests/unit/threadline-flow-bridge.test.ts tests/unit/route-completeness.test.ts` → 17/17 passing.
- Typecheck: `npx tsc --noEmit` → clean.
- Spec source of truth: `docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` § Migration Plan / Phase 2.
- Phase 1 baseline: PR #135, commit `976f94b9`.
