# Side-Effects Review — Slack inbound dispatch consults pool placement (WS1.1 Slack arm)

**Version / slug:** `slack-pool-dispatch-to-owner`
**Date:** `2026-06-14`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `dispatch-reviewer subagent (Phase 5 — touches inbound dispatch)`

## Summary of the change

The Slack adapter's inbound channel→session dispatch was LOCAL-ONLY: a Slack message bound a channel to whatever local session was already running and reused it, IGNORING pool ownership. So when a Slack channel's topic was transferred/pinned to a peer machine (ownership converged, `reason:pinned`), the NEXT Slack message in that channel was still injected into the already-running LOCAL session instead of being routed to the owner machine. Telegram's inbound path already followed a transfer (WS1.1 dispatch-to-owner: SessionRouter consultation + the owner-side `deliverMessage` bridge). This change extends that SAME machinery to Slack: (1) the Slack `onMessage` handler now consults `_sessionRouter.route()` on the Slack routing key BEFORE local dispatch and short-circuits when `isRemotelyHandled` says the owner is a remote peer; (2) the existing Slack dispatch body was extracted into a shared `slackInboundDispatch(message)` function so the live inbound path AND the owner-side bridge replay through one code path; (3) a new pure module `src/core/SlackForwardBridge.ts` (`isSlackSessionKey` / `parseSlackRoutingKey` / `reconstructSlackMessage`) lets the owner-side `onAccepted` bridge distinguish a Slack key (non-numeric string `C…`/`C…:ts`) from a Telegram topic key (pure number) and reconstruct the inbound Message. Files: `src/commands/server.ts` (Slack `onMessage` + owner-side `onAccepted` branch), `src/core/SlackForwardBridge.ts` (new). The whole feature is gated on the existing `_sessionPoolStage() !== 'dark'` — when dark (the fleet default and any single-machine install) the Slack path is byte-identical to today.

## Decision-point inventory

- `Slack onMessage → SessionRouter.route()` (src/commands/server.ts) — **modify** — Slack inbound now consults the §L4 SessionRouter (the existing dispatch authority) before local dispatch, mirroring Telegram. New consultation, not a new authority.
- `Owner-side onAccepted bridge` (src/commands/server.ts) — **modify** — the forwarded-deliverMessage handler gained a Slack arm: a non-numeric session key reconstructs a Slack Message and replays it through `slackInboundDispatch`; a numeric key keeps the unchanged Telegram path.
- `isSlackSessionKey` (src/core/SlackForwardBridge.ts) — **add** — a structural validator (numeric vs non-numeric key) selecting WHICH dispatch arm to use. Holds no block/allow authority.
- `Slack emergency-stop / pause sentinel intercept` — **pass-through** — moved verbatim from the old `onMessage` closure into the new `onMessage` handler; runs on the receiving machine (local-process actions), never forwarded. Unchanged behavior.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The change only ROUTES an inbound message (local dispatch vs forward-to-owner vs durable-queue custody). No Slack message is ever rejected by this change. When the SessionRouter consultation throws, the code falls through to today's local dispatch (fail-safe); when the pool is dark the consultation is skipped entirely.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable. As a routing concern, the residual gaps are: (a) if the owner machine advertises but cannot durably receive (`ownerSupportsForward` false / version skew), the SessionRouter's existing conservative path keeps the message in OUR durable queue rather than forwarding — same as Telegram, by design. (b) The Telegram path also has an inbound-queue ORDERING gate (`_inboundQueue.hasQueued`) that enqueues a live message behind existing queued entries; I mirrored the custody-ACK short-circuit but NOT that ordering pre-gate. Impact is bounded: the inbound queue ships dark, and without the pre-gate a live Slack message for an in-custody session would fall through to the router (which itself custody-checks) rather than strictly ordering behind the queue — a parity refinement, not a correctness break for the primary follow-the-transfer fix. Tracked as a follow-up below, not deferred silently.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The dispatch authority (SessionRouter, §L4) already exists and is platform-agnostic — it keys on a `string` `sessionKey` and makes the place/forward/queue decision. The right fix is to FEED the Slack inbound path INTO that existing authority, exactly as Telegram does — not to build a parallel Slack-specific ownership resolver. The new `SlackForwardBridge` helpers are low-level structural primitives (key discrimination + Message reconstruction) with no decision authority — the correct layer for them. `parseSlackRoutingKey` deliberately mirrors `SlackAdapter.parseRoutingKey` so the owner-side reconstruction matches the live path's key derivation.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The change consults the existing SessionRouter authority (the single owner of the §L4 dispatch decision) and acts on its `RouteOutcome`. `isSlackSessionKey` is a structural validator (numeric vs non-numeric) used only to select the dispatch arm in the owner-side bridge — it never blocks a message; both arms dispatch. No new brittle blocker with authority was introduced.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The SessionRouter consultation runs AFTER the sentinel emergency-stop/pause intercept (preserved at the top of `onMessage`) and BEFORE local dispatch. Emergency-stop/pause still short-circuit first (correct — they're local actions). When the pool is dark the consultation block is skipped so the sentinel + local path run exactly as before.
- **Double-fire:** The exact bug this fixes is double-dispatch (spawn-on-owner AND inject-locally). `isRemotelyHandled(outcome, _meshSelfId)` short-circuits local dispatch whenever the session ended up on another machine, and the custody-ACK short-circuit prevents local fall-through when the durable queue took custody. The owner-side bridge dedupes via the existing `recordReceipt`/ledger (a redelivered messageId ACKs `duplicate` and is NOT re-dispatched — proven in the e2e test).
- **Races:** The SessionRouter serializes per `sessionKey` (its `chains` map), so two Slack messages for the same routing key dispatch in order, one in-flight — same guarantee Telegram gets. The shared `slackInboundDispatch` reads `getSessionForChannel(routingKey)` the same way the old closure did; no new shared mutable state was introduced.
- **Feedback loops:** None. The owner-side bridge calls `markRemoteInjected`/`reportPeerInjectError` on the inbound queue (best-effort, gated on `_inboundQueue` which is dark by default) exactly as the Telegram bridge does.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none.
- **Other users of the install base:** none while dark (fleet default). When the session pool is enabled on a multi-machine Slack-using agent, a Slack conversation now correctly follows a topic transfer between machines — the intended, user-positive behavior.
- **External systems (Slack):** the owner-side bridge fetches channel history via the Slack API on the OWNER machine (Slack history is server-side, reachable from any machine), and replies via the same `slack-reply.sh` relay path. No new Slack API surface; reuses existing adapter methods.
- **Persistent state:** none new. Reuses the existing MessageProcessingLedger (receipt dedupe) and the dark-by-default inbound queue. No new config keys, so no migration parity work needed.
- **Timing/runtime:** the forward is async/bounded by the SessionRouter's existing deliver retry/timeout config — unchanged.
- **Operator surface (Mobile-Complete):** No operator-facing actions added — this is internal dispatch routing.

---

## 6b. Operator-surface quality

No operator surface — not applicable. The change touches no `dashboard/*` file, approval page, or grant/revoke/secret-drop form.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: replicated (dispatch-to-owner).** This feature IS a multi-machine coherence feature — it makes a Slack conversation follow the user across machines. The replication path is the §L4 SessionRouter + the `deliverMessage` mesh verb + the journal-backed `SessionOwnershipRegistry` (the exact path Telegram already uses, WS1.1). Ownership is a LOCAL read of the placement view; a remote-owned conversation forwards over the mesh to the owner, which spawns/injects with CONTINUATION context.

- **User-facing notices / one-voice:** The dispatch itself produces no user-facing notice; the conversation's replies come from exactly one session (the owner's), which is the one-voice property this fix RESTORES (before it, both the stale local session and the new owner could answer).
- **Durable state on topic transfer:** No new durable state strands — the owner-side bridge reconstructs the Message from the forwarded payload and the session registry is per-machine, resolved fresh on each side.
- **URLs across machine boundaries:** none generated.
- **Single-machine / dark:** strict no-op — gated on `_sessionPoolStage() !== 'dark'`; a single-machine or dark-pool agent runs the byte-identical local dispatch.

---

## 8. Rollback cost

Pure code change — revert the commit and ship as the next patch. No persistent state is created (reuses existing ledger + dark inbound queue), no new config key, no migration. While dark (fleet default) the change is inert, so a rollback has zero user-visible effect on the install base. On a multi-machine Slack agent with the pool enabled, rollback simply restores the prior local-only Slack dispatch (the pre-fix behavior).

---

## Conclusion

The review produced no design changes — the implementation already feeds the existing SessionRouter authority rather than adding a parallel brittle blocker, and is gated dark/additive. One parity refinement (the inbound-queue ORDERING pre-gate that the Telegram path has) is surfaced as a tracked follow-up rather than silently deferred; it does not affect the correctness of the primary follow-the-transfer fix because the SessionRouter custody-checks regardless. The change is clear to ship behind the existing dark pool gate. (Separately surfaced as a tracked follow-up, NOT fixed here to avoid scope-creep: ~33 `[mesh-rpc] rejected session-status: stale-timestamp` rejections observed in a live multi-machine log despite `/pool` reporting `clockSkew:ok` — needs live cross-machine timestamp-vs-receipt diagnosis; widening the 30s tolerance blindly would weaken the replay-window guard.)

---

## Second-pass review (if required)

**Reviewer:** dispatch-reviewer subagent
**Independent read of the artifact: concur**

Concur with the review. The change feeds the existing §L4 SessionRouter authority rather than adding a new blocker — `isSlackSessionKey` is a pure numeric-vs-string validator selecting a dispatch arm (both arms dispatch; no block authority), so it is signal-vs-authority compliant. Double-dispatch is closed on both ends: the inbound path short-circuits via `isRemotelyHandled` + the custody-ACK check (identical arms to Telegram's), and the owner-side Slack branch sits inside `DeliverMessageHandler`'s `recordReceipt`-gated `onAccepted`, so a redelivered forward ACKs `duplicate` and never re-dispatches (proven by the e2e test). On a `route()` throw the path falls through to local dispatch (fail-safe, never drops), and the whole block is dark-gated so single-machine/dark agents are byte-identical. The admitted Telegram-parity divergence (the inbound-queue ordering pre-gate) is correctness-neutral for the primary fix because the inbound queue ships dark and the SessionRouter custody-checks regardless — acceptable as a tracked follow-up.

---

## Evidence pointers

- Unit: `tests/unit/SlackForwardBridge.test.ts` (8 tests — both sides of the Slack-vs-Telegram key boundary + reconstruction), `tests/unit/slack-thread-session-wiring.test.ts` (21 tests — re-anchored on `slackInboundDispatch` + new WS1.1 pool-routing wiring assertions).
- Integration: `tests/integration/session-router-dispatch.test.ts` (Slack-shaped routing key forwards to the remote owner over real MeshRpc).
- E2E "feature alive": `tests/e2e/session-pool-delivermessage-e2e.test.ts` (owner-side `onAccepted` dispatches a forwarded Slack key to Slack with channel+thread+sender; a numeric Telegram key routes to the Telegram path; redelivery deduped).
- Wiring ratchet preserved: `tests/unit/session-pool-activation-wiring.test.ts` updated for the split dark-gate / `!telegram` gate.
