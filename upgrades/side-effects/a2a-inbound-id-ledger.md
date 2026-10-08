# Side-Effects Review — A2A inbound message-id ledger

**Version / slug:** `a2a-inbound-id-ledger`
**Date:** `2026-10-07`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/a2a-inbound-id-ledger.md (v18, converged 17 iterations; approved under the operator's standing approval for the agent-comms track, 2026-10-06 18:57, topic 122413).

## Summary of the change

A receiver-side durable ledger (`src/threadline/InboundIdLedger.ts`, own SQLite file `state/a2a-inbound-ids.<agent>.sqlite`, WAL, busy_timeout 1 s, registered with the SqliteRegistry, excluded from backups) records every admitted agent-to-agent message id keyed by a namespaced sender key, written at a commit point after every gate and before every side effect on all four ingress paths: the relay `gate-passed` consumer (`commands/server.ts`, through `runRelayInboundWithLedger`), the unknown-sender relay path, `POST /threadline/messages/receive` (`ThreadlineEndpoints.ts`) and `POST /messages/relay-agent` (`routes.ts`). Outcomes are recorded through a data allowlist (`OUTCOME_ALLOWLIST`); `ThreadlineRouter` returns gain a `path` discriminator. Only a verified `no-reply` row (or, later, a durable hand-off — none today) suppresses a resend; every other resend is re-admitted and delivered with a fixed "resent copy" notice placed before the untrusted framing. `InboundMessageGate.setLedgerLookup` drops a terminal-row replay after the operation-permission check and before the rate limiter; `seenMessageIds` is consulted for data messages only while the lookup is unavailable. Also: a shared `isRelayChainLoop` predicate; `/threadline/health` advertises `inbound-id-ledger` + `protocolVersion: 2` only while operational and not daemon-deferred; a Registry-First read route `GET /a2a/inbound-ids` (+ `?scope=pool`); an annotate-only peer read for `resend: true` messages; the send chain carries one id on every route and a `resend` flag inside the message body; config `threadline.inboundIdLedger` (dev-gated); migration + template awareness section.

## Decision-point inventory

- Inbound admission (dedup) on four ingress paths — **add** — admit / answer duplicate / re-admit, per the transition table.
- `InboundMessageGate` replay step — **modify** — moved after `classifyOperation`; ledger lookup inserted between step 4 and step 5.
- `/messages/relay-agent` content window — **modify** — skipped for an id the ledger already has a row for; released on a ledger 503 or a recorded handoff-failed/refused.
- `/threadline/health` capability — **add** — a hint only.
- Peer annotation — **add** — wording of a notice only; no delivery decision.

---

## 1. Over-block

The only new suppression is a verified terminal (`no-reply`) row: a same-id resend from the same verified fingerprint after the warrants-reply gate judged the original to need no reply. That is the intended behaviour, and the gate decision it repeats is a pure function of the message. A sender that reuses an id for a different payload loses that payload — the sender's contract (spec §1). New refusal answers: HTTP 409 for an in-flight duplicate (a non-2xx, so today's `response.ok` senders retry rather than treat it as success) and a single 503 on a database error outside a cooldown. Neither drops a message: the sender retries.

## 2. Under-block

Duplicates that still get through, all labelled where detectable: a resend over any non-durable hand-off (every path today); a cross-machine resend (only annotated); an evicted or unrecorded `unverified:` id; a resend after the 14-day prune; a crash between a path's accept and the outcome write; a relay-socket wait that times out. Each is listed in spec §6 as an accepted duplicate window. Daemon-inbox mode is not covered (capability not advertised there).

## 3. Level-of-abstraction fit

The ledger sits at each ingress's existing accept point because the five ingress paths have different auth and delivery semantics (spec preamble); the consolidation onto one durable queue is ACT-055's scope. The gate integration uses the gate's existing late-binding setter pattern. The relay consumer wrapper and the HTTP glue live in `inboundIdLedgerWiring.ts` so production and tests run the same code.

## 4. Signal vs authority compliance

The ledger is an invariant store, not a brittle detector: a primary-key match on (verified sender, id) with a closed transition table. Its only blocking authority is a verified terminal row, and every failure path (DB error, cooldown, breaker, full namespace, unknown outcome shape, a peer's answer) fails toward delivery. A peer's unauthenticated answer can never suppress — it only words a notice (docs/signal-vs-authority.md: signal feeds wording, never authority).

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Admission is an invariant (spec "Decision points touched": one row per key, a closed transition table, an attempt token, an outcome allowlist); every row is classed `invariant` in the driving spec. The only judgment-shaped input — a peer machine's unauthenticated answer — is denied authority entirely and only words a notice.

## 5. Interactions

- `InboundMessageGate` replay protection: dark mode is byte-equivalent except the replay check now runs after the payload-size and classification steps (existing replay tests pass unchanged).
- `relayContentDedup`: a known id bypasses it; recording handoff-failed/refused on relay-agent calls `forget` only after the conditional write succeeds (a superseded attempt never releases the window). The content window still answers new ids, now tagged `dedupBy: 'content'` (additive).
- `MessageRouter.relay`: unchanged except the loop check now calls the shared predicate.
- `recordInboundAck`: gains `{ livenessBump, notAfter }`; the duplicate ack goes through the same funnel bounded to rows sent before the original's `admitted_at`.
- `A2ADeliveryTracker.recordAckByThread`: optional `notAfter` (additive).
- Send chain: `sendPlaintext` now mints a UUID instead of `msg-<now>-<rand>`; relay-send passes its one id to the relay route; the local envelope carries `from.fingerprint`.
- Unknown-sender relay handler no longer fabricates `msg-<now>` ids (unkeyed instead).

## 6. External surfaces

`/threadline/health` (unauthenticated) gains `capabilities` and `protocolVersion` while the ledger is operational — discloses dev-gate state beside the already-public fingerprint (accepted in spec §3). New authenticated route `GET /a2a/inbound-ids`. HTTP ingress gains 409 / 503 / deduped answers. Authed `/health` gains `threadline.inboundIdLedger` counters. New log `logs/a2a-inbound-refusals.jsonl` (metadata only, fixed reason codes, 5 MB rotation, two files, age-pruned). The SQLite driver is synchronous: an outside lock stalls the event loop up to 1 s once before the cooldown takes over.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard, approval page or grant/revoke form is touched; the read route is an agent-facing JSON API).

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read. Each machine writes only its own rows (single writer, never copied, excluded from backups). `GET /a2a/inbound-ids?scope=pool` merges every online peer's plain-scope answer through `readReaperPoolPeers` (machine-tagged rows, dark peer → `pool.failed`). A marked resend asks at most 8 peers (500 ms, 16 in flight, per-peer breaker) whether they handed the id off — only to word the notice. Cross-machine dedup is ACT-054. No user-facing notice beyond the in-prompt label; no topic-bound durable state; no generated URL.

## 8. Rollback cost

`threadline.inboundIdLedger.enabled: false` (live): the file is closed and left in place, the capability disappears, the gate falls back to its in-memory map. Reverting the release is safe: older code never reads the file; the `path` field, optional send-chain parameters and `resend` body flag are ignored by older code. No data migration, no agent-state repair.

## Conclusion

The review produced no design change beyond the spec; the build follows v18. Three small, recorded deviations (below) all keep the spec's fail direction — toward a labelled or unlabelled duplicate, never a loss. Clear to ship dark (dev-gated) after the second-pass review.

## Evidence pointers

- `tests/unit/a2a-inbound-id-ledger.test.ts` — transition table + allowlist as data and behaviour, commit point, attempts, namespaces, unverified caps + refusal log, socket wait (ceilings, timeout, settle mapping, no head-of-line), DB-error cooldown/breaker, prune batches/backoff/breaker, file/handle/flip, gate ordering vs rate limiter, notice placement, duplicate ack bound, peer annotator, backup exclusion, boot ordinal.
- `tests/unit/threadline/ThreadlineRouter-ledger-path.test.ts` — the router's `path` discriminator and notice placement.
- `tests/unit/PostUpdateMigrator-inboundIdLedger.test.ts` — migration parity (template, migrator, config default, dev-gate registry).
- `tests/integration/threadline/inbound-id-ledger.test.ts` — signed HTTP receive (409, terminal duplicate, refused retry, failure-visible retry, 503 then fail-open, capability) and a real AgentServer (relay-agent namespaces, bare verified answer, pre-registration attack, loop, read route incl. 401/400/pool, 503 releases the content window, live flip).
- `tests/e2e/threadline/inbound-id-ledger-alive.test.ts` — production controller + real relay + real AgentServers.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller of the `unbounded-self-action` class (the prune and counter-flush timers only delete expired rows and write a counters row) — not applicable.

## Second-pass review

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

Concur with the review — all seven invariants hold (every failure delivers without a row; only a verified terminal row suppresses; refusals re-admit; lookups never end a cooldown; owning attempts clear their keys in a finally; gate order is insufficient_trust → ledger → rate limiter; peer answers only word the notice; commit precedes side effects on every ingress). Two non-blocking nits, both resolved: a forced re-admission now settles any waiter parked on the superseded attempt immediately; and server.ts hands AgentServer a dark controller when its own construction fails, so the HTTP routes never advertise a ledger the relay socket lacks.

## Deviations from the spec text (recorded)

- **Listener and pipe notices.** The listener inbox entry and the pipe-spawn prompt have no separate framing slot the ledger can reach without a schema change, so the fixed notice is prepended to the text as `[server notice: …]` there. Router paths (live, cold, warm) place it before the grounding header as specified. Topic-linkage and approval-queue hand-offs carry no notice (their surfaces render the envelope themselves) — a missing label on a duplicate, never a loss.
- **E2E two-server case.** The relay refuses a same-id resend inside its 5-minute replay window, so the E2E drives the real relay for the original, re-emits the relay's `gate-passed` frame for the queued-copy case, and exercises the two-server annotation over real HTTP between two real AgentServers rather than a second real relay socket.
- **Read route.** `sender` is optional (an id-only read returns up to 20 rows across senders); `id` is required.

## Follow-up: resent-copy notice on the topic-linkage path

The backup-routes v2 adversarial review found that a resent copy routed through `TopicLinkageHandler.tryRouteReplyToTopic` reached the session without the resent-copy notice, because the handler builds its own framing and was handed the unmodified envelope. The fix prepends the same fixed server notice (`withServerNotice`) to the body of a shallow envelope copy, only when a notice is present. With no notice the envelope is passed unchanged, so ordinary topic routing is byte-for-byte as before. No new state, timer, or decision point. A unit test asserts the topic path returns `path: 'topic'` and the body handed to the handler starts with the notice.
