# Side-Effects Review — Threadline Canonical, Symmetric History + Conversation Discipline (Robustness Phase 2)

**Version / slug:** `threadline-canonical-history`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `general-purpose reviewer subagent (Phase 5 — required: touches inbound/outbound messaging + a routing resolver)`

## Summary of the change

Adds a canonical, append-only, **hash-chained log per Threadline conversation** (`{stateDir}/threadline/threads/{threadId}.log.jsonl`, `ThreadLog`, modeled verbatim on `MandateAudit`/`TrustAuditLog`) written through **one append funnel** (`recordThreadMessage`) that every message-persisting route now calls — the structural fix for **F3** (a sender reading "0 messages" on a thread it had just sent on). `threadline_history` and `GET /messages/thread/:threadId` are re-pointed at that log as a **UNION** with a one-time bounded backfill (history can only gain). A new bearer-gated `GET /threadline/threads/:id` + `/health` expose the canonical log + an **advisory** cross-end symmetry state (identity-free content digests + an order-independent 256-bit modular-sum accumulator). A durable, verified-only **(peerPrincipal, workstreamKey) → canonicalThreadId resolver** makes outbound replies join one canonical thread instead of forking (**F5**) — the one behavior change, dev-gated + dry-run-first. Files: new `ThreadLog.ts`, `recordThreadMessage.ts`, `threadDigest.ts`, `threadSymmetry.ts`, `canonicalHistoryRead.ts`; extended `ConversationStore.ts`, `ThreadlineEndpoints.ts`, `server/routes.ts`, `commands/server.ts`, `AgentServer.ts`, `ConfigDefaults.ts`, `devGatedFeatures.ts`, `PostUpdateMigrator.ts`, `BackupManager.ts`, `scaffold/templates.ts`.

## Decision-point inventory

- `recordThreadMessage` append funnel (`src/threadline/recordThreadMessage.ts`) — **add** — observability append; never gates delivery (off the send critical path).
- Conversation-discipline resolver JOIN (`recordThreadMessage.resolveOutboundThread`, wired at `routes.ts` relay-send) — **add** — recoverable routing; chooses which threadId an outbound send groups under. Never blocks a send.
- Cross-end symmetry state + divergence Attention (`threadSymmetry.ts`) — **add** — advisory signal only; never blocks, never binds.
- Participant-authorized convergence backfill responder/requester (`threadSymmetry.ts`, `POST /threadline/threads/backfill`) — **add** — read-only, participant-scoped; ingestion recomputes everything (untrusted).
- `GET /messages/thread/:threadId` read source — **modify** — re-pointed from the lossy derived aggregate to the canonical log union; id validation widened from UUID-only to the anchored minted-shape allowlist.
- Placeholder `GET /threadline/messages/thread/:id` (hard `messageCount:0`) — **remove** — the second F3 hard-zero source, deleted.
- Close-only canonical-log retention seam (`ConversationStore.fireLogRetention`) — **add** — deletes a thread log on resolved/failed close (never on cold archive/LRU).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only block surface added is the read routes' id validation. `GET /threadline/threads/:id` and the re-pointed `/messages/thread/:threadId` validate `:id` against an anchored allowlist (`^(?:[0-9a-f-]{36}|msg-[a-z0-9]+(?:-[a-z0-9]+)*|thread-[a-z0-9]+(?:-[a-z0-9]+)*)$`). This is strictly *looser* than the prior `MSG_ID_RE` (UUID-only) that 400'd legitimate `msg-…`/`thread-…` ids — so the change *un-blocks* the real minted shapes that previously failed. A genuinely odd id shape (e.g. an uppercase-hex thread id, if any existed) would 400 — none of the minted shapes use uppercase, so no real id is rejected. The append funnel and resolver have **no** block surface (the funnel never gates delivery; the resolver never blocks a send).

---

## 2. Under-block

**What failure modes does this still miss?**

- **Cross-end symmetry against a *malicious* verified peer (SA3):** the 256-bit modular-sum accumulator is order-independent + O(1) but NOT collision-resistant, so a hostile verified peer could in principle craft a colliding `(count, setAccum)`. Accepted because symmetry is advisory-only — a forged `verified` misleads an auditor but grants nothing (never blocks/binds). LtHash-style hardening is the named Phase-3 path.
- **Relay/encrypted outbound `createdAt` symmetry:** the wire `createdAt` for the relay path is stamped inside the relay client/encryptor and not recoverable, so relay-path outbound legs may report `unverified`/`diverged` rather than `verified`. The leg is still LOGGED (F3 holds unconditionally); the local co-located delivery path is fully symmetric (and is the F3-incident path).
- **A deliberate local-FS attacker** who rewrites BOTH the log AND the independently-stored head stamp defeats `verify()`. Out of scope per Phase 1's FS-attacker posture; named honestly.
- **Backfill cannot recover an inbound leg absent from BOTH the outbox tail and the per-thread aggregate** — stated honestly; the symmetry surface (not backfill) flags the residual gap.

---

## 3. Level-of-abstraction fit

The canonical log + funnel are **low-level append-only persistence** reusing the in-tree `MandateAudit`/`TrustAuditLog` hash-chain primitive (no new crypto, no new format) — correct layer. The symmetry surface is a **detector** that produces an advisory state, never an authority. The resolver is **recoverable routing** at the send path, fed by the verified peer fingerprint (an existing primitive) — it does not re-implement identity resolution; it consults the `ConversationStore` (the single conversation source of truth) and writes its binding there. The append funnel deliberately mirrors Phase 1's `recordInboundAck` funnel (the established pattern), enforced by a wiring-integrity test. No higher-level gate is bypassed; no lower-level primitive is re-implemented.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces signals consumed by existing surfaces; the one routing decision is recoverable and never blocks/binds.

Phase 2 adds **NO new blocking gate** (the spec states this explicitly). The canonical log is audit/observability. The symmetry state is advisory — it never blocks a send, never binds, never gates an irreversible action, and never auto-loops a backfill outside the bounded, single-flight, sticky-terminal episode. The resolver JOIN is recoverable routing: a wrong grouping is fixed locally with an explicit fork, it never blocks a send, and it ships dry-run-first because the wire effect is one-way. The append failure path raises a *signal* (one deduped Attention item), it does not gate anything. Binding authority still lives only in the Phase-1 operator-anchored Coordination Mandate / ReviewExchange flow.

---

## 5. Interactions

- **Shadowing:** the append funnel runs *beside* (not before) the existing `appendCanonicalOutboxEntry` + `recordLocalOutbound`/`recordInboundAck` at each site — it neither shadows nor is shadowed (it's additive observability). The re-pointed `/messages/thread/:threadId` falls back to the legacy `messageRouter.getThread` aggregate only when `ctx.threadLog` is absent (threadline disabled), so no double-source.
- **Double-fire:** the outbound funnel is called once per delivery path (local OR relay, mutually exclusive branches); the local path records the leg once before building the envelope (the later duplicate call was removed). The funnel is idempotent on `(threadId, messageId, direction)`, so even a double-call is a no-op.
- **Races:** `ThreadLog.append` is synchronous (`appendFileSync` of one sub-PIPE_BUF line is atomic; Node is single-threaded → no in-process interleave). The head-cache is a coalesced best-effort write that never runs inside a per-message CAS; a read never writes it back (SI1). Retention deletion is post-commit (after the atomic write lands), so a CAS rollback can't strand a record without its log.
- **Feedback loops:** the divergence→backfill episode is single-flight + sticky-terminal (one episode per thread), so a peer streaming unreconcilable legs cannot loop it; the rate limit gates episode initiation.

---

## 6. External surfaces

- **Other agents:** three additive, optional wire fields (`contentDigest`+`digestVersion`, `threadSync`, the `thread-backfill-req/resp` kind). A legacy peer ignores all three → no flag-day; Dawn needs no change and no coordinated cutover.
- **Install base:** new config block `threadline.canonicalHistory.*` (backfilled by `applyDefaults` on update), a backup-manifest union (`threadline/conversations.json`), and CLAUDE.md template + migration paragraphs. All additive.
- **External systems:** the divergence/append-failure Attention items surface to Telegram (one deduped item per thread/episode — Bounded Notification Surface). No new third-party spend.
- **Persistent state:** new per-thread `threads/*.log.jsonl` + `threads/archive/` + `*.meta.json` under `{stateDir}/threadline/`; new optional `Conversation` fields. Older code ignores the new fields on load → clean revert both directions.
- **Operator surface (Mobile-Complete):** the canonical history + symmetry are surfaced on the **dashboard Threadline tab** via the re-pointed `/threadline/observability/threads/:id` (now carries `canonicalHistory`) and the bearer-gated `GET /threadline/threads/:id`+`/health`. The operator recovery for a `local-integrity-fault` is returned inline in the `/health` response (a phone-readable playbook). No new PIN-gated/laptop-bound operator action.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Declared per surface (the spec carries the full table):

- **Canonical log + append funnel:** **machine-local BY DESIGN** under the existing single-holder model — a per-thread log is one authoritative writer per machine; the per-entry `author` field is the Phase-3 cross-machine-merge seam. Append + resolver JOIN are **holder-only** (the resolver passes `isHolder`) so two machines never write sibling logs for one threadId.
- **Head-cache:** machine-local; authoritative only at the holder; a pool read proxies to the holder (`?scope=pool`).
- **Symmetry digest:** content-addressed + identity-free → **machine-agnostic** (meaningful across the Phase-3 merge without rework).
- **Divergence / append-failure Attention item:** raised only by the holder (one-voice-gated by single-holder ownership), deduped per (thread, episode) — two machines never double-alert.
- **Durable state on topic transfer:** a Telegram topic moving machines does NOT move its A2A conversation (the relay address is part of the holder's identity), so the per-thread log is never stranded by a topic transfer.
- **Generated URLs:** the read routes are bearer-gated own-agent paths; the dashboard surfaces them via the tunnel URL (survives machine boundaries like every other dashboard route).

---

## 8. Rollback cost

Pure code change with additive, ignore-on-load persistent state. **Back-out:** revert the code and ship a patch. On revert with the flags off, the log keeps being written (it is the correct read source), the resolver stops rerouting, and stale symmetry state is inert. The new `Conversation` fields are additive+optional (older code ignores them) → clean revert both directions. No data migration is required to roll back (the per-thread logs are reconstructable via backfill and are excluded from backup by design). No user-visible regression during the rollback window — the worst case is history reverts to the pre-Phase-2 aggregate read, which is exactly today's behavior.

---

## Conclusion

The review confirms Phase 2 is additive observability + recoverable routing with **no new blocking authority**. The design changes the review hardened were already folded in during spec convergence (identity-free symmetry, order-independent accumulator, participant-authorized terminating backfill, persisted-seen-set idempotency, coalesced read-never-writes head-cache, close-only-never-LRU retention, the net-new backup migration). The one residual honestly named is the relay-path `createdAt` symmetry (advisory degradation, F3 still holds). The change is clear to ship behind its dev-gate + dry-run-first posture; the F3/F5 fixes and the symmetry surface ship live in core (gain-only / observability), the resolver JOIN is dev-live-dry-run / fleet-dark.

---

## Second-pass review (if required)

**Reviewer:** general-purpose reviewer subagent
**Independent read of the artifact: CONCUR**

The reviewer independently verified against the code:
- The append funnel + resolver hold no block authority — `record()` never throws into the caller and is off the send path; `resolveOutboundThread()` keeps the minted threadId on every error branch; the relay-send wiring falls back to the minted id in a try/catch (`routes.ts`). The "no new blocking gate" claim is accurate.
- The resolver `enabled` is dev-gated via `resolveDevAgentGate(...conversationDiscipline?.enabled...)`; `ConfigDefaults.ts` OMITS `enabled` (only `dryRun:true`); registered in `DEV_GATED_FEATURES` and absent from `DARK_GATE_EXCLUSIONS` — the correct dev-live/fleet-dark posture, not the #1001 mechanism.
- Symmetry is advisory-only; the participant check + backfill route key on the Ed25519-derived `threadlineVerifiedFingerprint` (fails CLOSED when absent), never a name/body claim (SA1). Ingestion recomputes digests, stamps `backfilled:true`, drops unrequested records, ignores peer chain fields (SA4). The episode is single-flight + sticky-terminal — one Attention item, no loop (SA2).
- Retention is close-only (`LOG_DELETION_STATES = {resolved, failed}` excludes `archived`); cold `pruneMapInPlace`/`evictStatesIfNeeded` paths delete only the in-memory key with no lifecycle diff, so a cold thread's log survives (SA5 — the F3-regression risk is correctly closed).
- ThreadLog is append-only hash-chained; dedup falls back to a live-log scan when the cache is incomplete (not a tail window); the read routes are timing-safe bearer-gated with the id allowlist + path confinement. No artifact claim is contradicted by the code.

---

## Evidence pointers

- Unit: `tests/unit/threadDigest.test.ts` (frozen reference vectors), `ThreadLog.test.ts` (chain/idempotency/retention-invariant accumulator), `recordThreadMessage.test.ts` (funnel + resolver matrix), `threadSymmetry.test.ts` (states + SA1/SA4 + terminating episode), `ConversationStore-canonicalHistory.test.ts` (close-only retention SA5 + resolver binding).
- Integration: `tests/integration/threadline/canonical-history-wiring.test.ts` (every persisting route through the funnel), `canonical-history-routes.test.ts` (F3 read-back, health, traversal, bearer gate), `canonical-history-backfill.test.ts` (union + memoized + restore SI2 + SA1/SA4 + legacy downgrade).
- E2E: `tests/e2e/threadline-canonical-history-lifecycle.test.ts` (feature-alive 200, F3 + F5 incidents, cross-instance symmetry convergence, diverged→backfill→sticky-terminal, dev-gating live-on-dev/dark-on-fleet).
- Dev-gate conformance: `tests/unit/lint-dev-agent-dark-gate.test.ts` golden map updated by hand (+29 shift), `devGatedFeatures-wiring.test.ts` auto-covers the new entry.
