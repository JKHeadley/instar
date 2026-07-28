---
title: A2A Durable Delivery — "communications never just die out" between agents
date: 2026-06-06
author: echo
parent-principle: "Close the Loop"
parent-principle-fit: "An outbound A2A message awaiting acknowledgement is a loop the agent opened; until the peer processes it, it must be durably registered and re-surfaced (peerHealth/stale now; escalation in PR2) rather than left to rot. 'Untracked = Abandoned' is literally the failure this closes — Dawn's message sat unread 10h because nothing tracked or re-surfaced it. The A2ADeliveryTracker is the loop-closing substrate for agent-to-agent delivery, the same shape as commitments/beacons for user promises."
review-convergence: multi-agent-convergence-2026-06-06
review-convergence-detail: "Two parallel adversarial reviewers (correctness/idempotency/concurrency + integration/spec-fidelity/conventions) audited the spec against the real diff. Converged after folding all findings: 1 CRITICAL/HIGH (implicit-ack keyed outbound by fingerprint but inbound by display-name + cross-machine path unwired → ack never fired in production despite green tests) — FIXED (recordAckByThread keys on threadId alone; cross-machine relay-ingest path wired in server.ts with real fingerprint; local path resolves thread-owner fingerprint) + unit regression test + a real relay-agent round-trip wiring-integrity test; 1 MAJOR (weak msg-id INSERT-OR-IGNORE silent-drop) — FIXED (collision-visibility logging); 2 MINOR (close() SqliteRegistry unregister contract; inbound peerName) — FIXED; LOW spec over-claims (Tier-3 kill-receiver, escalation-sentinel-default-ON) — corrected to PR2."
approved: true
approved-by: Justin
approved-via: "Telegram topic 12476 (2026-06-06): explicit 24h autonomous-mode directive — 'enter a [autonomous] mode for 24 hours with the objective of improving thread line in the robustness for both you and DAWN ... including ... a long-lived queue ... so communications never just die out'. This spec IS that directive; approval recorded per the silently-stopped-trio autonomous-directive precedent. Internal-only convergence (no cross-model codex reviewer this round) — noted honestly."
eli16-overview: A2A-DURABLE-DELIVERY-SPEC.eli16.md
issue: https://github.com/JKHeadley/instar/issues/939
commitment: CMT-1143
---

# Spec — A2A Durable Delivery

## Problem

Agent-to-agent (Threadline + file-relay) messaging is **fire-and-forget at every
hop**. A `threadline_send` that returns `delivered:true / accepted` means only
that the TRANSPORT accepted the bytes — it says nothing about whether the peer
ever PROCESSED the message. And there is no record on the SENDER side that "this
message is still waiting for the peer to acknowledge it," so a peer going dark is
invisible until a human notices the silence.

Observed in production (Echo↔Dawn, 2026-06-05/06), three simultaneous failure
paths:
1. **Dawn→Echo over Threadline**: not landing (zero relay-accept entries). An
   addressing/discovery gap on the sender's side; the sender gets no signal the
   message was lost.
2. **Echo→Dawn over Threadline**: `delivered:true/accepted` ≠ read — a kickoff
   was accepted by the relay but Dawn never saw it.
3. **Dawn→Echo over the file relay**: lands but rots — a check-in sat 10h unread
   because nothing on the receiving side watched the channel.

Operator directive (Justin, 2026-06-06, topic 12476): *"There needs to be some
long-lived queue or something that makes sure communications never just die
out."*

## What already exists (verified in main @ v1.3.379 — do NOT rebuild)

- **Canonical outbox** (`ListenerSessionManager.appendCanonicalOutboxEntry`,
  `.instar/threadline/outbox.jsonl.active`): an HMAC-signed append-only AUDIT log
  of every outbound A2A message. It records that a send happened; it has NO
  delivered-vs-processed lifecycle, no retry, no escalation.
- **MessageProcessingLedger** + **ingressDedup**: the exactly-once INBOUND dedup
  ledger (Telegram/Slack). The pattern (SQLite, WAL, per-agent-id) is reused here.
- **Canonical-fingerprint thread ownership** (routes.ts §relay-send,
  `captureOrigin`): the thread owner is now stored as the peer's FULL fingerprint,
  not a display name. This already fixed the anti-hijack **false-isolation** of a
  known peer's reply (R1). The relay `trust.kind` staying `plaintext-tofu` (R2) is
  CORRECT — relay transport is genuinely not E2E-verified; with R1 fixed the guard
  passes for fingerprint-matched replies, so R2 needs no change.
- **dawn-relay-watch** (agent-local scheduler job, shipped 2026-06-06): polls the
  Echo↔Dawn file relay every 5m, machine-ACKs + stages new entries + raises ONE
  aggregated attention item. This spec generalizes that idea into instar.

## What this adds

The durable spine + observability that turns silence into a visible, escalatable
signal — built ON TOP of the existing canonical outbox, never replacing it.

### 1. A2ADeliveryTracker (SQLite, per-agent-id) — BUILT

The durable delivery lifecycle, mirroring MessageProcessingLedger's substrate
conventions (WAL, `busy_timeout`, `registerSqliteHandle`, in-memory test ctor).

Tables:
- `a2a_delivery` (message_id PK, peer_fp, peer_name, thread_id, subject,
  transport, state, sent_at, acked_at, attempts, last_attempt_at, next_retry_at,
  escalated_at). State machine: `awaiting-ack → acked | escalated | failed`;
  a late ack rescues an `escalated` row back to `acked`.
- `a2a_peer_inbound` (peer_fp PK, peer_name, last_accepted_at, accept_count):
  the inbound-liveness clock.

API: `recordSent` (idempotent on messageId — never resurrects an acked row),
`recordAck` / `recordAckByThread`, `recordInboundFrom`, `pending`, `findOverdue`
(the redelivery/escalation work-list), `markAttempt` / `markEscalated` /
`markFailed`, `peerHealth`, `allPeerHealth`.

### 2. Wiring (no new decision authority — pure recording)

- `recordSent` is called at BOTH canonical-outbox callsites in `relay-send`
  (local-delivery + relay-delivery paths), with the resolved peer fingerprint as
  `peerFp` (the same canonical fingerprint `captureOrigin` already stores).
- `recordInboundFrom` is called at the relay `onMessage` accept point in
  `server.ts` (where `[relay-agent] Accepted message from …` is logged).
- These are pure side-effect-free RECORDING calls — they never gate or alter a
  send/receive. Signal-vs-authority: this is a signal PRODUCER, not an authority.

### 3. Processed-ACK — two layers

**Layer A (PR1, shipped here) — implicit ack via reply.** When an agent ACCEPTS
an inbound A2A message on a thread, that is treated as proof the peer processed
our prior send on that thread: the accept point calls
`recordAckByThread(peerFp, threadId)`, flipping the oldest awaiting-ack message
on that (peer, thread) to `acked`. This is **protocol-free** — it works with
ANY peer today, no upgrade required (a normal reply IS the acknowledgement). The
accept point also calls `recordInboundFrom(peerFp)` to bump the liveness clock.

**Layer B (PR2) — explicit `a2a-ack` control message.** For fire-and-forget
messages that never get a reply, an agent emits a tiny `kind:"a2a-ack"` carrying
the original `messageId` on accept; the sender calls `recordAck(messageId)`. ACK
messages are never acked (no regress) and never spawn a session. Back-compat: a
peer that emits no acks simply leaves no-reply messages `awaiting-ack`; the
escalation path still surfaces the silence. No peer must upgrade for the SENDER
to gain the safety net. The tracker API (`recordAck`) already supports this; only
the emit/consume control-message plumbing is PR2 with the sentinel. <!-- tracked: #939 -->

### 4. Redelivery + escalation sentinel (signal consumer)

A periodic sweep (scheduler job, default every 15m) calls `findOverdue(ttlMs)`:
- For each overdue `awaiting-ack` message under `maxAttempts`: re-attempt
  delivery on its transport, `markAttempt` with exponential backoff
  (`next_retry_at`).
- On `maxAttempts` exhaustion: `markEscalated` and raise ONE AGGREGATED
  sender-side attention item per peer ("N message(s) to <peer> undelivered for
  >Xh") — never one item per message (P17 Bounded Notification Surface).
- Default TTL = 6h (matches the ACK-discipline window proposed to Dawn);
  `maxAttempts` = 5; all tunable in `.instar/config.json` → `threadline.delivery`.

### 5. Peer-health surface (read-only observability)

- `GET /threadline/peers/health` → `{ peers: PeerHealth[] }`
- `GET /threadline/peers/:fp/health` → `PeerHealth`

`PeerHealth = { peerFp, peerName, lastSentAt, lastAckedAt, lastInboundAt,
pendingCount, oldestPendingAgeMs, escalatedCount, stale }`. Turns "is my channel
to Dawn alive?" into a lookup. Read-only — never gates.

### 6. Inbound gate observability (PR4a) — make a silent block impossible

The peer-health surface answers "is my channel alive?" but not "*why* did an
inbound die?". `InboundMessageGate.evaluate()` returns `{action:'block', reason}`
and bumps in-memory metric counters — but **logs nothing**. A blocked inbound is
therefore invisible: it leaves no line in `server.log`, and the counters are
aggregate (not per-fingerprint) and reset on restart. That silence is the exact
mechanism by which the dawn→echo remote-relay leg went dark for ~1.5 days with
no trace — runtime grounding confirmed `/threadline/peers/health` shows Dawn's
fp with **zero** recorded inbound while `gate-passed` never fired for her, and a
`server.log` grep found **no** block line. The leading hypothesis (a trusted
peer whose inbound fingerprint representation does not match its trust-profile
key → resolves `untrusted` → `insufficient_trust`) cannot be confirmed because
the verdict is silent.

PR4a makes every gate verdict visible (the structural form of "comms must never
die *silently*"): `evaluate()` logs one `[inbound-gate] eval from=<fp12>
trust=<level> op=<type>` line per inbound, a `[inbound-gate] BLOCK <reason>
from=<fp12> …` line on each of the five block paths (carrying the **resolved
trust level** + allowed-ops for `insufficient_trust`, so a fingerprint/trust
mismatch is diagnosable from `server.log` alone), and a `PASS` line on success.
Fingerprints are truncated to 12 chars; **no payload content is logged**.
Behavior-preserving — pure observability, no routing/trust/rate change. This is
the decisive, in-Echo's-control diagnostic step: once deployed, the next live
dawn→echo test self-identifies as either a gate block (with the exact reason +
resolved trust) or an upstream relay-client drop (no eval line at all),
selecting the targeted fix (PR4b) without guesswork.

## Testing (Testing Integrity Standard — all three tiers)

- **Tier 1**: A2ADeliveryTracker lifecycle, idempotency, overdue/stale gates,
  peer-health composition, thread-fallback ack (19 tests, GREEN).
- **Tier 1 (PR4a)**: `InboundMessageGate` block-decision observability — a
  not-permitted op logs `BLOCK insufficient_trust` with the resolved trust level
  + fingerprint; an allowed message logs `eval` + `PASS`; an oversized payload
  logs `BLOCK payload_too_large` (3 tests, GREEN; full gate suite 40/40 GREEN).
- **Tier 2**: `/threadline/peers/health` + `/threadline/peers/:fp/health` over
  the full HTTP pipeline return 200 with composed data when the feature is wired.
- **Tier 3**: feature-is-alive — the routes answer 200 (not 503) from the
  production init path (AgentServer self-constructs the tracker from stateDir).
  (The kill-receiver-mid-delivery → exactly-once redelivery scenario belongs to
  PR2, which adds redelivery; PR1 has no redelivery to test.)
- **Wiring-integrity**: a REAL POST /messages/relay-agent round-trip asserts an
  inbound reply on a thread flips a pre-recorded outbound message from
  awaiting-ack → acked (`tests/integration/a2a-delivery-wiring.test.ts`) — the
  test that catches the send/inbound callsites being no-ops or keyed wrong (the
  exact bug cross-perspective convergence review found before merge).

## Migration parity

- New routes → CapabilityIndex + CLAUDE.md template (`generateClaudeMd`) Agent
  Awareness section so existing agents learn the surface.
- SQLite schema self-initializes on first access (no PostUpdateMigrator step).
- (PR2) The redelivery + escalation sentinel job is added via the standard job
  install path; it is NOT part of PR1 — PR1 ships the durable tracker + the
  read-only peer-health surface + the recording wiring only.

## Rollback

The tracker is recording-only; disabling the escalation sentinel
(`threadline.delivery.escalation.enabled:false`) reverts to today's behavior
(audit-only outbox) with zero data risk. The routes 503 cleanly when the tracker
is absent.

## Non-goals

- Not changing the relay transport or the `plaintext-tofu` trust model (R2 is
  correct as-is).
- Not solving Dawn's inbound addressing/discovery gap (separate investigation;
  the file relay + watcher is the proven working channel in the meantime).
