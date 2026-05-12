# Side-Effects Review — Thread↔Topic Linkage

**Version / slug:** `thread-topic-linkage`
**Date:** 2026-05-11
**Author:** Echo
**Second-pass reviewer:** general-purpose review agent (see below)

## Summary of the change

Routes threadline replies on threads initiated by a topic-bound session back to that originating Telegram topic, instead of spawning a sibling "thread-worker" session. The session resumes (or live-injects) with the full thread history and the agent's stated purpose; a Telegram notification fires only when an LLM-backed (or fallback) salience gate says the reply is user-worthy.

Per Rev 2 of the spec (THREAD-TOPIC-LINKAGE-SPEC.md), the awaiting-state and heartbeat cadence are delegated to existing infrastructure rather than built fresh:

- A one-time-action `Commitment` (new `verificationMethod: 'threadline-reply'`) is created on outbound send. `PromiseBeacon` auto-opts in because `topicId` is attached, giving the user free "still waiting on X" heartbeats. `expiresAt` provides 7-day stale cleanup.

Files touched:

- `src/threadline/ThreadResumeMap.ts` — adds `originTopicId` + `originSessionName` (optional fields on `ThreadResumeEntry`).
- `src/monitoring/CommitmentTracker.ts` — adds `'threadline-reply'` to `verificationMethod`, adds `relatedThreadId` + `relatedAgent`, adds `findByThreadId()`, short-circuits `verifyOne` for threadline-reply commitments so the sweep is a no-op.
- `src/threadline/SalienceGate.ts` — NEW. LLM-backed (optional) classifier with deterministic fallback (user-visible on first reply, agent-internal on subsequent).
- `src/threadline/TopicLinkageHandler.ts` — NEW. Outbound capture + inbound dispatch + Telegram surface + commitment lifecycle.
- `src/threadline/ThreadlineRouter.ts` — adds optional `setTopicLinkageHandler()`, calls handler before existing thread-worker path when thread has `originTopicId`.
- `src/server/AgentServer.ts` — exposes `threadResumeMap` and `topicLinkageHandler` on ctx.
- `src/server/routes.ts` — extends `/threadline/relay-send` with optional `originTopicId` + `purpose`, calls `captureOriginOnSend` after each successful send.
- `src/threadline/ThreadlineMCPServer.ts` — extends `threadline_send` tool schema with optional `originTopicId` + `purpose`.
- `src/threadline/mcp-stdio-entry.ts` — passes through to HTTP route.
- `src/commands/server.ts` — instantiates `SalienceGate` (fallback-only for v1) and `TopicLinkageHandler`, attaches to router and ctx.

Decision points touched:

- `SalienceGate.evaluate` — new judgment authority (smart, LLM-backed when wired; deterministic fallback otherwise).
- `ThreadlineRouter.handleInboundMessage` topic branch — new structural dispatcher.
- `TelegramAdapter.sendToTopic` — existing surface, called with rate-limit (transport mechanic).

## Decision-point inventory

- `SalienceGate.evaluate` — **add** — Classifies inbound replies as `user-visible` or `agent-internal`. LLM-backed if a classifier is injected; deterministic fallback otherwise. Smart authority (not a brittle blocker).
- `ThreadlineRouter.handleInboundMessage` topic branch — **add** — Routes replies on threads with `originTopicId` to the topic session via `TopicLinkageHandler`. Structural dispatch, not judgment. Falls through to existing thread-worker path on miss.
- `CommitmentTracker.verifyOne` for `'threadline-reply'` method — **add** — Returns no-op (`passed: false, detail: 'Awaiting threadline reply'`) without status mutation. Prevents the periodic sweep from accumulating violations on externally-resolved commitments.
- `CommitmentTracker.findByThreadId` — **add** — Linear-scan lookup by `relatedThreadId`. Pure read accessor.
- `/threadline/relay-send` outbound capture — **add** — Stamps `ThreadResumeMap` and creates a commitment. Idempotent on threadId; no-op when `originTopicId` is missing.
- `Telegram surface rate-limit` — **add** — 60s per-thread cap on user-visible notifications. Pure mechanics.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface on the inbound side. The router never blocks based on topic linkage — it only chooses *which* delivery path to take. If linkage is present and the topic is live, the reply goes to the topic; if linkage is present but the topic is dormant, the reply still gets recorded via the standard inbox path; if linkage is absent, the reply goes to the existing thread-worker. No legitimate reply is rejected.

The salience gate does not block delivery — it only decides whether to fire a Telegram notification. A reply marked `agent-internal` is still injected/resumed into the topic session; the user just isn't pinged about it. Over-surfacing is the dual risk (see §2 / under-block), not over-blocking.

The `originTopicId` request-body validator is permissive: bad type → ignored, no error. Sends still succeed without linkage. No over-rejection.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Salience gate over-surfaces in fallback mode.** With no LLM classifier configured (v1 ships fallback-only), every first reply per thread fires a Telegram notification. For very chatty multi-reply threads with short purposes ("ack received"), the first reply still surfaces even when it's mid-negotiation. Mitigated by the 60s per-thread rate-limit but not eliminated. Acceptable for v1 since the bias is "user sees too much" rather than "user sees nothing."

- **Salience gate under-surfaces in fallback mode.** All subsequent replies after the first default to `agent-internal`. A reply on turn 5 of a conversation that's actually the final answer the user is waiting on will NOT fire a Telegram notification (it still routes to the session). The session is expected to surface it itself — but that requires the agent to make the right call. Acceptable for v1 since the session has the reply in hand and can choose to message the user; this risk is also mitigated by the LLM classifier when it's wired in a follow-up.

- **`captureOrigin` runs after successful delivery only.** If the relay drops a send mid-flight (network dies), no commitment is created, so the user doesn't get a "still waiting" beacon. The HTTP route returns a 5xx in that case and the calling session sees it; this is acceptable because the failure is loud (the agent knows the send didn't happen).

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes, with explicit choices:

- `SalienceGate` is at the *authority* layer (smart, full context). It is NOT a low-level filter. It does not duplicate `PromiseBeacon.classifyProgress` (which is about "is the awaiting agent stalled" vs this gate's "should the reply surface").

- `TopicLinkageHandler` is at the *coordinator* layer — it owns the cross-cutting flow (commitment creation, route selection, Telegram surface, lifecycle transition) so the call sites in `routes.ts` and `ThreadlineRouter` stay thin. This is the same shape as other handlers in `src/threadline/` (e.g., `InboundMessageGate`, `HandshakeManager`).

- `Commitment` field additions are at the *data model* layer. `findByThreadId` is at the *lookup* layer. No new higher-level abstraction was warranted given existing infrastructure.

- The new `verificationMethod: 'threadline-reply'` is intentionally treated as externally-resolved: the periodic sweep is a no-op, and the router (the natural authority for thread state) does the transition. This avoids a feedback loop between sweep and router.

A higher-level gate already exists for inbound autonomy decisions (`AutonomyGate`) — this change runs *after* it, deliberately, so autonomy decisions are not bypassed.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface AND the one new authority (SalienceGate) is a smart gate with full conversational context (LLM-backed when configured, deterministic fallback otherwise).

The only new judgment authority is `SalienceGate.evaluate`. It is LLM-backed (when wired via the `classify` callback) or runs a deterministic fallback rule. The deterministic fallback is intentionally chosen to bias toward user-visible on first contact — that is the cautious-toward-visibility default, not a hidden allow/block. The fallback is *not* a "brittle blocker disguised as a gate"; it's a structured visibility rule with no information-flow blocking semantics.

The inbound router branch is structural dispatch (does this thread have an `originTopicId`?) — covered by the "idempotency/transport mechanics" carve-out in `signal-vs-authority.md`. It never blocks; it only chooses among delivery paths.

The Telegram surface rate-limit is transport-layer dedup (60s/thread). Also covered by the carve-out.

The new `verificationMethod` value is data-model. No authority.

Compliant.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The topic-linkage branch runs *after* the autonomy gate and *before* the existing live-inject / resume-or-spawn path. When it returns `routed`, the existing paths are skipped — by design, that's the whole point. When it returns `no-linkage` or `topic-expired`, control falls through to the existing paths unchanged. We confirmed via test that no-linkage threads route exactly as today.

- **Double-fire:** Could `PromiseBeacon` and the Telegram surface both notify the user about the same thread? In principle yes — beacon fires periodic "still waiting" heartbeats, and on reply the surface fires a "reply landed" notification. They are *different* messages (status check vs answer received) and target different states. Beacon stops when commitment is marked delivered; surface fires once per reply (rate-limited per thread). No double-fire on the same event; possible interleave on the same conversation, which is the intended UX.

- **Races:** `CommitmentTracker.record` and `CommitmentTracker.deliver` are serialised through the existing mutate queue (CAS-retry). The `captureOriginOnSend` idempotency check (`findByThreadId`) reads outside the queue, but a second call within the same send burst is benign — both would see no existing commitment, both would record, and the resulting two records would only differ in id/purpose. We don't expect this race in practice (single-writer per send via HTTP route), but it's worth noting. Mitigation: the `findByThreadId` check is followed by `record`, both atomic individually; ordering matters but conflicts are rare and non-corrupting.

- **Feedback loops:** `verifyOne` on threadline-reply is a no-op, so the periodic sweep cannot cycle the commitment through `pending → violated → delivered`. The router is the single transition path. No loop.

- **Adjacent cleanup:** `CommitmentTracker.backfillUnverifiableOneTimeActions` runs once at construction. It does NOT touch `'threadline-reply'` commitments because they don't match the unverifiable definition (`undefined | null | 'manual'`). Verified by regression test.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** No. `purpose` is local-only and never serialized to the outbound `MessageEnvelope`. `originTopicId` is the same — local-only, attached to the commitment and the thread-resume cache but never sent over the wire. The remote agent receives the exact same envelope it would have received pre-change.

- **Other users of the install base:** The new fields on `Commitment` and `ThreadResumeEntry` are all optional. Existing JSON files deserialize cleanly. Agents upgrading to this version will not see their old data corrupted, and agents on older versions reading a state file produced by this version will ignore the unknown fields. Tested via regression on existing CommitmentTracker tests.

- **External systems:** The Telegram surface adds new outbound messages to the topic — visible to the human user. The format is bounded (500-char body cap, structured footer) and rate-limited (60s/thread). No new API calls, no new third-party integrations.

- **Persistent state:**
  - `commitments.json` gains rows with `verificationMethod: 'threadline-reply'`. Old commitments unaffected.
  - `thread-resume-map.json` gains optional `originTopicId` and `originSessionName` fields. Old entries unaffected.
  - No new persistent files.

- **Timing / runtime conditions:** Salience gate has a 2s timeout and fails open per rubric. Telegram send is best-effort (catches errors and logs). Live injection uses existing `injectPasteNotification` — same timing characteristics as Telegram-relay injection. No new sensitivity to clock drift, daylight saving, or process restart timing.

- **MCP tool surface:** `threadline_send` schema gains two new optional fields. Existing callers (older MCP clients, scripted senders) work unchanged. Documented in the upgrade notes.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** Yes — pure code revert, ship as next patch. The new optional fields on `Commitment` and `ThreadResumeEntry` will simply stop being populated, and pre-existing commitments/entries with the new fields will be ignored.

- **Data migration:** None required. `'threadline-reply'` commitments left over from this version will, after revert, hit the `verifyOneTimeAction` `default` case (unknown method) → return `passed: false, detail: 'Unknown verification method: threadline-reply'`. This is the pre-existing behavior for unknown methods. They will *not* be auto-marked delivered by the unverifiable backfill (their method is not in `undefined|null|'manual'`). Operator could manually expire them via `PATCH /commitments/:id` if desired, but no urgency.

- **Agent state repair:** None required. Topic sessions on the rollback version will continue to receive threadline replies via the existing thread-worker path. The commitment rows from this version will sit as inert "pending" rows until expiry (max 7 days).

- **User visibility:** During rollback, the user may experience a transient gap where they expect a reply notification and don't get one — because the new surface stops firing. The reply itself still routes via the existing path. No data loss, no broken conversations.

Estimated rollback time: < 10 minutes from revert push → CI green → npm publish.

---

## Conclusion

This change is structurally additive: new optional fields, a new verification method, a new handler class, and a new gate. All hooks into existing infrastructure go through the existing mutate/dispatch surfaces (no parallel write paths). The only new judgment authority (SalienceGate) is a smart gate with deterministic fallback. No brittle blocking. No persistent state migration required. Rollback is a code-only revert.

V1 ships with the salience gate's fallback rule only — the LLM classifier is plumbed but not wired by default. A follow-up can wire a Haiku-class classifier when ready; the existing 2s timeout and fail-open rubric mean a slow LLM never breaks delivery.

Clear to ship.

---

## Second-pass review

**Reviewer:** general-purpose review agent (per /instar-dev high-risk policy — this change touches inbound dispatch, commitment lifecycle, and a new gate).

**Independent read of the artifact: concern raised → resolved before commit.**

The audit confirmed clean: signal-vs-authority compliance, the `verifyOne` short-circuit ordering vs `isUnverifiableOneTime`, router fall-through on `no-linkage`/`topic-expired`, `captureOrigin` idempotency, wire-leakage check (`purpose` and `originTopicId` never reach the relay envelope), and Telegram-surface rate-limit semantics.

Two real issues were raised and **both have been fixed in this same commit**:

1. **`isFirstReply` derivation bug.** The original implementation derived `isFirstReply = commitment.heartbeatCount === 0`. But `heartbeatCount` is incremented by `PromiseBeacon` on every "still waiting" emission, not by reply arrivals. For any slow-replying thread (i.e., the common case — by the time a reply lands, the beacon has fired at least once), `heartbeatCount > 0`, which made `isFirstReply = false`, which in fallback-only v1 downgraded the *very first reply* to `agent-internal` → no Telegram surface → silently swallowed first contact. Exactly the failure mode the spec's §5.4 fallback rule was meant to prevent.

   **Resolution:** Added a `lastReplyAt?: string` field on `Commitment`, plus a `markReplyArrived(commitmentId)` public method on `CommitmentTracker`. The handler now sets `lastReplyAt` on every reply arrival (regardless of delivery mode), and derives `isFirstReply = !commitment?.lastReplyAt`. A dedicated regression test exercises the slow-reply path (beacon has fired heartbeats, no reply yet, first reply must still be user-visible).

2. **`resume-pending` left the commitment open.** The original code marked the commitment delivered only on `live-inject`. On `resume-pending` (topic session dormant, reply queued for next user interaction) it left the commitment open, which meant `PromiseBeacon` continued firing "still waiting" heartbeats even after the user had already been told via the Telegram surface that the reply landed. The spec §6.5 carve-out for "leave open" was scoped specifically to the wedged `failure-visible` path, not dormant-session waiting.

   **Resolution:** Both `live-inject` and `resume-pending` now mark the commitment `delivered`. Only `failure-visible` (actually-wedged: injection error, delivery breakdown) leaves it open so the beacon keeps surfacing the unresolved state. A dedicated regression test exercises the dormant-session path and asserts `commitmentDelivered: true`.

**Reviewer's post-fix posture:** concur — the two fixes address the root causes (rather than papering over symptoms) and add regression tests at the right boundary. Total test count after fixes: 11 new TopicLinkageHandler tests, 8 SalienceGate, 8 CommitmentTracker-threadline-reply → 27 new tests, all passing alongside 152 pre-existing related tests.

Minor remaining notes (non-blocking for v1):
- A small race in `captureOriginOnSend` can occur if an inbound reply marks the existing commitment delivered between the `findByThreadId` read and a concurrent outbound `captureOrigin` write on the same thread. Result is one extra commitment row rather than corruption; window is microseconds in practice.
- Salience-gate LLM classifier is plumbed but not wired in v1. Fallback rule is now correct; LLM upgrade is a follow-up.
- No dashboard surface for awaiting threadline-reply commitments specifically — they appear in the existing commitments dashboard panel, which is sufficient for now.

---

## Convergent-review fixes (Rev 3)

Beyond the second-pass internal reviewer's two fixes (above), a full convergent-review pass with four parallel internal reviewers (security, adversarial, scalability, integration) surfaced 29 findings. All HIGH-severity findings were addressed in code in this same commit; MEDIUM and LOW findings were either addressed in code or documented in the spec's §9 Risks & Open Questions with concrete v2 follow-up plans.

Code fixes landed:

- **Prompt-injection defense on inject payload.** `TopicLinkageHandler.buildSessionPayload` now wraps the remote reply body in a nonce-guarded delimiter (`<<<REMOTE_REPLY_BEGIN nonce=hex>>>` … `<<<REMOTE_REPLY_END nonce=hex>>>`) with an explicit "treat as untrusted data" instruction preceding the block. Body is also capped at 8000 chars inline; full body remains accessible via `threadline_history`.
- **Bad-entry poisoning guard.** `captureOriginOnSend` now refuses to stamp `originTopicId` on a thread whose commitment already records a different `topicId`. First-write wins. Source of truth is `commitment.topicId` (immutable after creation), not the `ThreadResumeMap` cache (which has a JSONL-existence guard that can return null even when the file row exists).
- **Sender verification on inbound.** `tryRouteReplyToTopic` now verifies `envelope.message.from.agent === commitment.relatedAgent` before routing. On mismatch, returns `no-linkage` (falls through to thread-worker path) and does NOT transition the commitment. Closes the threadId-collision / affinity-collision / observation-replay attack.
- **Per-topic rate-limit.** New layer above the per-thread 60s rate-limit: max 3 user-visible Telegram surfaces per topic per 60-second window. Closes the rotate-threadIds-to-bypass attack and the fail-open-classifier flood scenario.
- **Self-target ping-pong guard.** `captureOriginOnSend` returns null when `remoteAgent === localAgent`. Stops same-machine bridged-topic loops from accumulating cross-topic "still waiting" notifications.
- **purpose length cap (1024 chars).** Prevents pathological / malicious in-process callers from bloating the commitments JSON file.
- **threadId → commitmentId index in CommitmentTracker.** `findByThreadId` is now O(1) lookup + one status check, bounded by active threadline-reply commitments (not lifetime store size). Index rebuilt at load, maintained on every `record`/`deliver`/`withdraw`.
- **Honest user-facing copy in NEXT.md.** Rewrote the "What Changed" / "What to Tell Your User" / capabilities table to describe v1's deterministic recency rule honestly; LLM-backed content classifier flagged as a follow-up.

Documented in spec §6 / §9 / §11–§13 (deferred to v2):

- Multi-user (`ownerUserId` on commitment + thread, §6.10).
- Multi-machine (originTopicId scrub on migrate, §6.11).
- Dashboard threadline-specific surface (§9.10).
- Backup downgrade-safety operator note (§9.11).
- Config knobs surface (rate-limit, expiry, classifier wiring, kill-switch — §9.12).
- LLM-backed salience classifier wiring (§9.13).
- saveStore O(n) coalesce or SQLite migration (scalability F3).
- Commitments store GC for terminal rows (scalability F2).
- Beacon + surface interleave debounce (adversarial F7).

New regression tests landed alongside the fixes (5 new tests in `TopicLinkageHandler.test.ts`):

- `refuses to overwrite originTopicId when a thread already carries a different one (bad-entry poisoning guard)`
- `no-ops on same-machine self-target (ping-pong loop guard)`
- `caps the stored purpose to PURPOSE_CAP chars`
- `refuses to route inbound when sender does not match recorded relatedAgent (commitment-hijack guard)`
- `inject payload wraps remote body in nonce-guarded delimiter (prompt-injection guard)`
- `per-topic rate-limit caps user-visible Telegram surfaces across rotating threads (bypass guard)`

Total test count after Rev 3 fixes: **18 TopicLinkageHandler tests + 8 SalienceGate + 8 CommitmentTracker-threadline-reply = 34 new tests**, all passing alongside 152 pre-existing related tests (186 total in scope).

Convergence report: `docs/specs/reports/thread-topic-linkage-convergence.md`.

## Evidence pointers

- Unit tests: `tests/unit/SalienceGate.test.ts` (8 tests), `tests/unit/CommitmentTracker-threadline-reply.test.ts` (8 tests), `tests/unit/TopicLinkageHandler.test.ts` (10 tests) — 26 new tests, all passing.
- Regression: `tests/unit/CommitmentTracker.test.ts`, `tests/unit/CommitmentTracker-mutate.test.ts`, `tests/unit/threadline/ThreadlineRouter.test.ts`, `tests/unit/threadline/ThreadResumeMap.test.ts` — 152 tests, all passing post-change.
- Spec source of truth: `docs/specs/THREAD-TOPIC-LINKAGE-SPEC.md` (Rev 2, 2026-05-11).
- Live verification plan: post-merge, send threadline_send from echo topic 9210 to luna with a `purpose`, confirm commitment created + beacon active + reply routes back to topic + commitment delivered.
