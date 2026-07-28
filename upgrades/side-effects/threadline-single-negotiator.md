# Side-Effects Review — Threadline Single-Negotiator Lock + Honest Acks (Robustness Phase 1)

**Version / slug:** `threadline-single-negotiator`
**Date:** `2026-06-12`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent — CONCUR`

## Summary of the change

Phase 1 of the Threadline Robustness program (CMT-1362), making the 2026-06-11 warm-session cutover-lock incident structurally impossible on our side. Three guarantees: **G1** a per-conversation *negotiator lease* so at most one session owns a conversation's outbound voice (a warm/side session is withheld and can only emit a fixed holding notice); **G2** prose is inert — a normal Threadline message never creates a binding/authorization record, enforced *positively* by a typed `AnchoredAuthorization` boundary that irreversible-action gates must accept instead of prose; **G3** honest ack wiring — the verified relay inbound path now records the implicit delivery ack (closes the F4 false-`stale` noise) via a shared `recordInboundAck` funnel. Files touched: `src/threadline/ConversationStore.ts` (lease fields + `acquireOrRenewLease`), new `src/threadline/NegotiatorLease.ts` + `NegotiatorGate.ts` + `recordInboundAck.ts`, new `src/coordination/AnchoredAuthorization.ts`, `src/threadline/ContentClassifier.ts` (advisory commitment signal), `src/threadline/ThreadlineMCPServer.ts` + `mcp-http-client.ts` (surface held/note/advisory to the session), `src/threadline/ThreadlineEndpoints.ts` (receive-route ack funnel), `src/server/routes.ts` (send gate + `GET /threadline/negotiator` + funnel refactor), `src/commands/server.ts` (funnel refactor), `src/core/ExternalOperationGate.ts` (anchored-auth boundary), `src/config/ConfigDefaults.ts` + `src/core/devGatedFeatures.ts` + `src/core/PostUpdateMigrator.ts` + `src/scaffold/templates.ts` (config default + dark-gate classification + migration + awareness).

## Decision-point inventory

- `/threadline/relay-send` lease/voice gate (`routes.ts`, via `NegotiatorGate.evaluateSendGate`) — **add** — withholds a non-owner's content send when enforcing; the ONE new blocking action.
- `ContentClassifier.detectCommitmentClass` — **add** — signal-only advisory nudge; NO authority, never blocks.
- `ExternalOperationGate.evaluate` authorization input — **modify** — adds an optional `authorization` that, if supplied for an irreversible op, MUST be a typed anchored artifact (fails closed).
- `recordInboundAck` funnel at all inbound-receive sites — **modify** (refactor of existing inline logic) — recording-only, never gates.
- `GET /threadline/negotiator` — **add** — read-only, bearer-gated.

---

## 1. Over-block

**What legitimate inputs does this reject that it shouldn't?**

The only blocking action is the lease send-gate withholding a non-owner's content send, and it is gated three ways before it can over-block anything real: (a) **default dark** (`enabled:false` ⇒ pure pass-through, no store write); (b) **dry-run-first** when enabled (`dryRun:true` logs the would-be verdict but still sends); (c) when enforcing, it blocks ONLY on the structural ownership check, never on content. Concrete over-block shapes once enforcing is on:

- A legitimate second session of the SAME agent that genuinely should speak (e.g. an operator deliberately running two sessions on one conversation) would be withheld. Mitigation: the lease is renew-on-send with a 90s TTL and dead-owner reclaim — if the "real" owner session dies or goes idle past TTL, the next session acquires cleanly. The withheld session also gets an honest `held:true` + note telling it the owner will respond, so it is never a silent drop.
- A send with **no resolvable owning session identity** (no `INSTAR_SESSION_NAME`) cannot be lease-checked — this is treated as **fail-open + alert**, NOT a withhold, precisely so a missing-identity edge never over-blocks a real send.

The dry-run-first rollout exists specifically to measure this over-block (false-positive) rate before enforcement is ever enabled (FD-7).

---

## 2. Under-block

**What failure modes does this still miss?**

- **Cross-machine concurrent processing of one conversation (F2).** The lease is per-machine (`conversations.json` is per-machine); single-voice across machines rests on the existing single-holder model (one machine serves a conversation). A genuine split-brain where two machines both process one conversation is explicitly **Phase 3** and is surfaced (not silently missed) by the `detectDuplicateLiveHolders` runtime detector + the holder-singularity test (FD-2).
- **The peer's own prose.** We cannot force an un-upgraded peer (Dawn on her own train) to treat *her* prose as inert. Phase 1's guarantee is one-sided by design: our side never manufactures authority from prose, and irreversible actions remain gated by their own operator-anchored door. Bilateral content-agreement is Phase 2.
- **The commitment-class signal is intentionally incomplete** — it is advisory only, so a missed nudge is just a missing hint; the prose is inert either way (G2 does not depend on it).
- **Fail-open window.** During a lease-store error the gate fails open and G1 is explicitly not enforced — bounded, counted, and loudly alerted (HIGH attention item). Safe because prose is inert: the worst case is two of our own sessions briefly both speaking inert prose, never a binding.

---

## 3. Level-of-abstraction fit

The lease lives on the **existing** `ConversationStore` — already the one CAS-protected, single-writer, atomic-write per-conversation record. No new store, no new lock, no new process. The send gate sits at the **single server-side chokepoint** (`/threadline/relay-send`), where the ConversationStore and the server-authoritative session identity both already live (the MCP stdio subprocess forwards `originSessionName` from `INSTAR_SESSION_NAME`; identity is never taken from a peer-supplied string). The ack funnel reuses the **existing** `A2ADeliveryTracker` and consolidates three previously-copy-pasted callsites into one helper. The authorization boundary reuses the **existing** operator-anchored primitives (Mandate / ReviewExchange / OperatorConfirm) as the only authority — it does not invent a new commitment wire protocol. This is the right layer: extend the durable record already on the path, not a parallel mechanism.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] **Yes — but the only blocking authority is a structural ownership check, not brittle content judgment.** The lease blocks on *who speaks* (a deterministic (sessionName, machineId, epoch) comparison over a CAS record), which the principle explicitly permits as a structural validator / safety guard, NOT a judgment about what a message *means*.

The brittle/content piece — `detectCommitmentClass` — is deliberately **signal-only**: it produces an advisory nudge surfaced on the send response, never blocks, fails open to no-nudge, and runs off the send path. This is the exact inversion convergence review demanded: an earlier draft proposed a content classifier with *blocking* authority to refuse "binding prose"; that was rejected as both a Signal-vs-Authority violation and unworkable (the incident's own evidence had no lexical keyword). Authority is now positive and structural; prose has no pathway to authority by construction. The G2 boundary (`requireAnchoredAuthorization`) fails *closed* on the authority path — correct for an irreversible-action authorizer — while the lease fails *open* for inert prose.

---

## 5. Interactions

- **Shadowing:** the lease gate runs at the top of `/threadline/relay-send`, before the local/relay delivery branches and before the existing grounding gate (which lives in the MCP stdio process, upstream). When the gate withholds, it returns early — the delivery branches never run, which is the intent. When it allows (own / dry-run / fail-open / disabled) the handler proceeds unchanged. It does not shadow the grounding gate (different process, different concern).
- **Double-fire:** the holding-notice is emitted via a single best-effort `relayClient.sendAuto` and creates NO `A2ADeliveryTracker` awaiting-ack record (guarded — verified by the integration test asserting `pending().length === 0` after a held send), so it cannot inflate pending/stale or double-count. The ack funnel is idempotent (`recordAckByThread` flips awaiting→acked; repeats are no-ops).
- **Races:** lease acquire/renew is one `ConversationStore.mutate()` CAS transaction — the unit test proves two concurrent acquires yield exactly one winner; the loser sees the live foreign lease. No background renewal timer exists (renew-on-send), eliminating the "renewal silently succeeded while wedged" race.
- **Feedback loops:** none. The dry-run JSONL is write-only observability; the `/threadline/negotiator` route is read-only.

---

## 6. External surfaces

- **Other agents (the peer):** ONE additive wire kind — `holding-notice`. An un-upgraded peer renders it as a harmless one-line text; safety depends on nothing the peer does (it is never ack/content/count-bearing on our side). No flag-day: Dawn's side needs no change. Ordinary conversation is byte-for-byte unchanged when the feature is dark (default).
- **The sending session:** new optional response fields (`held`, `note`, `advisory`, explicit `delivered:false`) flow back through `sendMessageViaHttp` → the MCP `threadline_send` result. Additive — existing callers that ignore them are unaffected.
- **Persistent state:** three additive OPTIONAL fields on the `Conversation` record (`negotiatorLease`, `lastHoldingNoticeEpoch`, `lastHoldingNoticeAt`). An existing `conversations.json` without them loads unchanged; the acquire path initializes them. A daily-rotated dry-run JSONL under `logs/` (retention-pruned).
- **Operator:** a HIGH Attention item only on a genuine fail-open (lease store unreadable) — a state that must never be silent.

---

## 7. Rollback cost

Pure code change with a config kill-switch — the safest possible posture. `threadline.singleNegotiator.enabled:false` (the default) makes the gate pure pass-through with zero behavior change; flipping it off instantly disarms enforcement on the next session/server (the config is read live at the chokepoint, not cached at boot). No data migration on revert: the lease fields are inert optional data; stale lease state simply isn't read when the feature is off (no cleanup job needed). G2 + G3 ship live in core but are pure additions (a positive type boundary that only activates when a caller passes an `authorization`, and a recording-only ack call) — reverting is a code revert + patch, no persistent-state cleanup, no user-visible regression during the rollback window.

---

## Conclusion

The review confirms the design holds the line the convergence review drew: the only blocking authority is the structural lease (who-speaks), the content classifier is demoted to a signal-only nudge, and G2 is enforced positively via a typed authorization boundary rather than a rot-prone negative audit. The change ships dark + dry-run-first for the one new blocking action, with G2/G3 (pure correctness additions) live in core. Over-block risk is bounded by the dark default, the dry-run measurement stage, the structural (not content) gate key, and the fail-open-on-uncertainty posture. The 3-tier test suite proves the incident is structurally reproduced-and-prevented, the F4 ack gap is closed and wiring-enforced, and the G2 boundary rejects prose while accepting anchored artifacts. Clear to ship pending second-pass concurrence (required — outbound messaging block/allow surface).

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose)
**Independent read of the artifact: CONCUR**

The reviewer independently traced all seven surfaces and affirmed: (1) the sole blocking authority blocks on the structural `(ownerSessionName, ownerMachineId, epoch)` CAS comparison, never on content; (2) `detectCommitmentClass` is genuinely signal-only (surfaced as an `advisory` field, never wired to a block path, fails open to no-nudge); (3) `decision:'hold'` is structurally unreachable unless `enabled===true && dryRun===false` AND a foreign live lease exists; (4) missing store / blank session identity / any store-CAS throw all return `allow` + raise the HIGH alert — the gate never fails closed on the content path and never throws into the send path; (5) the held path returns before either `recordSent` callsite, so the holding-notice creates no awaiting-ack record (no pending/stale pollution); (6) `requireAnchoredAuthorization` correctly fails CLOSED on prose for an irreversible op — the right contrast with the lease failing open. No over-block, under-block, or single-voice bypass defect found; the cross-machine F2 gap is an explicitly-scoped Phase-3 boundary surfaced by `detectDuplicateLiveHolders`, not silently missed.

---

## Evidence pointers

- Unit: `tests/unit/NegotiatorLease.test.ts` (20), `tests/unit/AnchoredAuthorization.test.ts` (7), `tests/unit/recordInboundAck.test.ts` (4).
- Integration: `tests/integration/threadline/negotiator-send-gate.test.ts` (5 — held/owner/dry-run/advisory/route), `tests/integration/threadline/inbound-ack-wiring.test.ts` (4 — funnel enumeration).
- E2E: `tests/e2e/threadline-negotiator-alive.test.ts` (3 — feature alive/bearer/lease state), `tests/e2e/threadline-g2-boundary.test.ts` (7 — import-boundary + gate reject/accept + holder-singularity).
- Spec: `docs/specs/THREADLINE-SINGLE-NEGOTIATOR-SPEC.md`; ELI16: `docs/specs/threadline-single-negotiator.eli16.md`; convergence report: `docs/specs/reports/threadline-single-negotiator-convergence.md`.
