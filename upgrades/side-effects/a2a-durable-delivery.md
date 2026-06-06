# Side-Effects Review — A2A Durable Delivery (peer-health + delivery lifecycle)

**Version / slug:** `a2a-durable-delivery`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `two parallel adversarial reviewers (multi-agent convergence) — see below`

## Summary of the change

Adds the durable spine of "agent-to-agent communications never just die out"
(A2A-DURABLE-DELIVERY-SPEC.md, issue #939, CMT-1143). New SQLite component
`src/threadline/A2ADeliveryTracker.ts` records every outbound A2A message's
delivery lifecycle (`awaiting-ack → acked | escalated | failed`) and a per-peer
inbound-liveness clock, and composes a `peerHealth()` read ("is my channel to
<peer> alive?"). Wired into the existing relay-send paths (`recordSent` at both
canonical-outbox callsites in `routes.ts`) and the relay accept point
(`recordInboundFrom` + implicit-ack-via-reply `recordAckByThread` at
`routes.ts` ~15729). Two read-only routes `GET /threadline/peers/health` and
`GET /threadline/peers/:fp/health`. `AgentServer` self-constructs the tracker
from `stateDir` when not injected, so the routes are alive on every entry path.
Files: `src/threadline/A2ADeliveryTracker.ts`, `src/server/routes.ts`,
`src/server/AgentServer.ts`, `src/commands/server.ts`,
`src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, + 3 test files.

## Decision-point inventory

- `A2ADeliveryTracker recording calls` — add — pure RECORDING side-effects on
  send/accept; they never gate, delay, or alter a message. No decision authority.
- `GET /threadline/peers/health[/:fp]` — add — read-only observability; returns
  computed health, never acts.

No block/allow surface is introduced.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The tracker records; it
cannot reject a send or an inbound message. `recordSent` is wrapped in try/catch
at both callsites (a tracker failure logs and is swallowed — the send already
happened above the recording call).

---

## 2. Under-block

No block/allow surface — under-block not applicable. Coverage note for the
liveness signal: implicit-ack-via-reply only acks messages on threads that
receive a reply; a genuine fire-and-forget message with no reply stays
`awaiting-ack` and (correctly) shows as pending/stale. That is the intended
signal, and the explicit `a2a-ack` control message (PR2) closes the no-reply
case. No silence is hidden.

---

## 3. Level-of-abstraction fit

Correct layer. This is a **signal producer** (a durable detector of "what have I
sent / heard / had acknowledged") plus a read-only view. It does NOT re-implement
the canonical outbox (which already audits sends) — it adds the lifecycle the
outbox lacks, alongside it. It reuses the proven SQLite substrate pattern
(`MessageProcessingLedger`: WAL, `busy_timeout`, `registerSqliteHandle`,
in-memory test ctor) rather than inventing a new store. The escalation that will
consume `findOverdue` (PR2) is the authority layer and is intentionally NOT in
this PR.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface (and the future escalation
  consumer in PR2 is an aggregated attention item, not a blocking authority).

The tracker is brittle-free recording; it owns no authority. The peer-health
routes are read-only. Nothing here can wrongly block a message.

---

## 5. Interactions

- **Shadowing:** none. `recordSent` runs AFTER the actual send + after
  `captureOrigin`; `recordInboundFrom`/`recordAckByThread` run AFTER
  `messageRouter.relay(...)` returns `accepted` and after the existing accept
  log — it cannot pre-empt or shadow delivery/dedup logic.
- **Double-fire:** the tracker may be constructed in BOTH `commands/server.ts`
  (production injection) and `AgentServer` (fallback). Guarded: AgentServer only
  self-builds when `!options.a2aDeliveryTracker`, so production opens ONE handle.
  `recordSent` is `INSERT OR IGNORE` on `message_id` — a retry of the same id
  never double-inserts and never resurrects an acked row.
- **Races:** SQLite WAL + `busy_timeout=5000` (same as MessageProcessingLedger);
  recording calls are independent rows, no shared mutable state with concurrent
  code.
- **Feedback loops:** none. Recording an ack/inbound does not emit a message.

---

## 6. External surfaces

- **Other agents on this machine:** none — per-agent-id DB file
  (`state/a2a-delivery.<agentId>.sqlite`), isolated.
- **Install base:** new read-only routes + two CLAUDE.md template/migration
  sections (Agent Awareness Standard — `generateClaudeMd` + `migrateClaudeMd`,
  content-sniffed, idempotent). Existing agents gain the awareness on update.
- **External systems:** none. No Telegram/Slack/GitHub/Cloudflare surface change.
- **Persistent state:** a new SQLite file, schema self-initializing on first
  access (no PostUpdateMigrator DB step). Append/update only.
- **Timing:** none introduced (no new timers in this PR; the redelivery sweep is
  PR2).

---

## 7. Rollback cost

Pure additive code change. Back-out = revert the commit and ship a patch. The new
SQLite file is orphaned harmlessly if the code is reverted (no other component
reads it). No user-visible regression during the rollback window — the routes
simply 503 again if the tracker is absent, and sends/receives are unchanged
(recording-only). No agent-state repair needed; the CLAUDE.md sections are
content-sniffed so a re-run is a no-op.

---

## Conclusion

The review found no block/allow surface and no authority — this is recording-only
infrastructure plus a read-only health view, riding the proven SQLite substrate
and sitting alongside (not replacing) the canonical outbox. The one interaction
worth noting (double-construction) is guarded by the inject-or-self-build pattern
and `INSERT OR IGNORE` idempotency. Clear to ship as PR1; the redelivery +
escalation authority + explicit `a2a-ack` control message are intentionally
scoped to PR2.

## Second-pass review (multi-agent convergence, 2026-06-06)

**Reviewers:** two parallel adversarial agents — (A) correctness/idempotency/concurrency, (B) integration/spec-fidelity/conventions.
**Independent read: CONCERN → resolved.** Both independently caught a load-bearing bug the green test suite hid:

- **[CRITICAL/HIGH] Implicit-ack non-functional in production.** Outbound rows were keyed by the peer's FINGERPRINT, but the inbound accept point keyed the ack by `from.agent` — a display NAME on the local transport — and was wired ONLY on the same-machine path, never on the cross-machine relay-ingest path (the actual Echo↔Dawn case). The ack never fired; messages would sit awaiting-ack and go stale even after the peer replied. Tests passed only because they used one identifier for both sides. **Resolution:** `recordAckByThread` now keys on `threadId` ALONE (robust to the identity-format asymmetry); the cross-machine relay-ingest accept point in `server.ts` records with the real `senderFingerprint`; the local path resolves the thread-owner fingerprint for liveness. Added a unit asymmetry regression test + a real `POST /messages/relay-agent` round-trip wiring-integrity test asserting awaiting-ack → acked.
- **[MAJOR] Weak message-id silent-drop.** `INSERT OR IGNORE` is idempotent only if ids are unique; plaintext/local transports use a weak `msg-<ms>-<4char>` id. **Resolution:** `recordSent` detects an ignored insert whose existing row is a genuinely different (peer, thread) and logs it loudly instead of silently dropping. (Root id-generator hardening noted as a follow-up; out of PR1 scope.)
- **[MINOR] `close()` violated the SqliteRegistry unregister contract.** **Resolution:** capture + call the unregister fn in `close()`.
- **[MINOR] inbound `peerName` always null.** **Resolution:** pass the sender name as the label.
- **[LOW] Spec over-claims** (Tier-3 kill-receiver scenario; "escalation sentinel default ON"). **Resolution:** corrected — both are PR2; the wiring-integrity test the spec promised now exists.

After folding all findings the design converged: read surface + lifecycle were sound; the fix was identifier reconciliation + wiring the cross-machine path + the missing wiring-integrity test. 31 tests green across all tiers; tsc clean.

## Evidence pointers

- Tier 1: `tests/unit/A2ADeliveryTracker.test.ts` — 20 tests (lifecycle,
  idempotency, overdue/stale gates, peer-health composition, thread-keyed ack +
  the identity-asymmetry regression).
- Tier 2: `tests/integration/threadline-peer-health-route.test.ts` — 6 tests
  (full HTTP pipeline, staleAfterMs param, 503-when-absent).
- Tier 2 wiring-integrity: `tests/integration/a2a-delivery-wiring.test.ts` — 2
  tests (real POST /messages/relay-agent round-trip flips awaiting-ack → acked;
  inbound-liveness bumped).
- Tier 3: `tests/e2e/a2a-peer-health-alive.test.ts` — 3 tests (real AgentServer
  boot, routes 200-not-503, DB file created on prod init path).
- All 31 green; `tsc --noEmit` clean; pre-commit lints clean.
