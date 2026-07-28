---
name: threadline-reply-surfacing-fix
review-convergence: 2026-05-25T17:45:00Z
approved: true
eli16-overview: THREADLINE-REPLY-SURFACING-FIX-ELI16.md
---

# THREADLINE-REPLY-SURFACING-FIX-SPEC

**Status:** APPROVED 2026-05-25 (Justin, topic 12304)
**Author:** Echo · **Date:** 2026-05-25 · **Base:** JKHeadley/main @ v1.2.80
**Tracks:** CMT-515 (surfacing), CMT-508 (send-path), bilateral E2E-PAIR baseline with instar-codey
**Convergence:** 2 parallel reviewers grounded against v1.2.80 source (correctness + side-effects). Their findings are folded in below; the most important were a *missed relay path* and a *Fix-2 over-correction*.

---

## 1. Problem

A co-located agent (Codey) replies on a Threadline thread bound to a Telegram topic (`boundTopicId = 12304`). The reply is recorded but **never surfaces to the user's topic**. Reproduced live + bilaterally 2026-05-25. Transport works; every failure is downstream. Six defects; two share one root cause.

### Verified root causes (all line refs = v1.2.80)

- **A1 — topic-bound inbound spawns a throwaway handler instead of routing to the topic.** `ThreadlineRouter.handleInboundMessage:457` routes only when `threadResumeMap.get(threadId)?.originTopicId !== undefined`. `ThreadResumeMap.get():146` returns `null` for any non-pinned entry where `!jsonlExists(entry.uuid)`; `jsonlExists` looks for a Claude `{uuid}.jsonl`. Topic-linkage entries are stamped with `uuid:''` on first send (`TopicLinkageHandler.captureOriginOnSend:228`) and their liveness is the *topic's*, not a JSONL's → valid entries are nulled → router falls through to `spawnNewThread`. The code **already documents this hazard** (captureOriginOnSend ~206-210) and worked around it on the *send* path via the commitment record — but the *inbound* path never got the fix.

- **C — `threadline_history` "not found or expired" for live threads.** Same root cause: existence gate at `ThreadlineMCPServer.ts:623/772` calls the same lossy `get()`. (Bilaterally reproduced.) NOTE: `ConversationStore` stores only metadata (`messageCount`), no bodies; bodies live in MessageStore via `getThreadHistory`. ⇒ **C has a hard dependency on D**: fixing the existence gate makes the thread *resolve*, but it reads half-blind until D persists both legs.

- **A2 — `live-inject` is treated as guaranteed delivery with no confirmation.** `injectIntoSession` (server.ts:6810) = `sessionManager.injectPasteNotification(...)` returning `true` on **dispatch**, not consumption. Injecting into a busy Claude TUI hits the paste-end Enter race (`Injection stuck — Auto-recovering`, ~17× live), so the payload silently never submits. Yet `tryRouteReplyToTopic:407` sets `deliveryMode='live-inject'` on that bare `true`; `surfacedToUser:478` then resolves the commitment, and `shouldSurface:427` skips the Telegram fallback (verdict not `user-visible`). ⇒ reply recorded, commitment closed, user sees nothing.

- **A1-relay (MISSED PATH, convergence-found) — the cross-machine relay branch bypasses topic routing entirely.** On `threadlineRelayClient 'gate-passed'` (server.ts:7047), inbound is handled by **pipe-spawn** (7202, guarded `!threadResumeMap.get(threadId)`) or **warm-listener** (7244, *unguarded*) and `return`s **before** `handleInboundMessage` (7264). A trusted peer's short reply takes the warm-listener branch and never reaches TopicLinkageHandler. The local `/messages/relay-agent` path *does* call the router (covered) — which is exactly why the co-located test passed and this would slip through. This is the prior relay-vs-local split-gate bug recurring.

- **B — `originTopicId` not stamped on the transmitted envelope.** The relay-send local-delivery envelope carries no topic id, so the *peer* can't attribute an inbound to one of *its* topics. Secondary (Echo surfaces via its own captured entry), needed for symmetric collaboration.

- **D — only the inbound leg persists on the local fast-path.** Relay-send POSTs to the peer and persists no outbound leg into the sender's thread history (only an observability outbox entry) → each node holds only the other agent's half. Confirmed bilaterally (46 envelope files, all `codey→echo`).

- **E — duplicate-send / ack-loop flooding.** Operational hardening. The Codey-side 3-copy send is Codey-owned — flagged to Codey, tracked <!-- tracked: CMT-508 -->; our-side inbound dedup-by-message-id already exists in `relay()`/`store.save` and is covered by a regression test in this PR.

---

## 2. Goals / Non-goals

**Goals:** (1) topic-bound replies reliably reach the bound topic on BOTH the local and relay paths; (2) surfacing is robust to a stalled inject and commitments resolve only on *confirmed* user-facing surface — without creating a double-surface in the common case or a notification flood; (3) `threadline_history` resolves live threads and returns BOTH legs; (4) peer can attribute inbound (B); (5) no duplicate floods from our side (E).

**Non-goals:** fixing the Claude TUI paste-race itself (broader; we make surfacing *robust to* it); cross-machine relay-connection work; Codex-side send-retry dedup.

---

## 3. Design

### Fix 1 — `ThreadResumeMap.get()`: don't null topic-linkage entries (fixes A1 + unblocks C)

```ts
// get(), line ~146 — skip the JSONL guard for topic-bound entries
if (!entry.pinned && entry.originTopicId === undefined && !this.jsonlExists(entry.uuid)) return null;
```
`originTopicId` is reliably populated (`conversationToEntry:74` maps `boundTopicId`→`originTopicId`). Rationale: a topic-linkage thread's liveness is the topic's; the JSONL guard's original purpose (expire dormant *Claude-session* resume entries) is preserved for non-topic threads.

**Enumerated effect on the 6 other `get()` callers** (convergence requirement):
- `server.ts:7204` pipe-spawn guard `!threadResumeMap.get(threadId)` → now returns non-null for topic-bound ⇒ pipe-spawn correctly **skipped** for topic-bound replies (desired).
- `ThreadlineRouter.ts:489` `tryInjectIntoLiveSession` → now runs for these entries; with empty `uuid`/`sessionName` it is a no-op (verify in impl + test).
- `onSessionEnd:516` / `onThreadResolved:536` / `onThreadFailed:554`, `ThreadlineMCPServer:772` → benign (operate on returned entry); add regression coverage.
- **Dead-topic leak:** entries are no longer JSONL-nulled, but still expire via `ConversationStore.isExpired` (7-day `lastActivityAt`, `ConversationStore.ts:510`), and `tryRouteReplyToTopic`'s `topicActive` check (`:332`) handles a dead topic at route time. No permanent leak.

### Fix 1b — close the relay-path miss (NEW, convergence-found)

On the `gate-passed` handler (server.ts ~7047), a **topic-bound reply must take the topic-routing path regardless of pipe/listener eligibility.** Add a topic-bound predicate (resolve via `threadResumeMap.get(threadId)?.originTopicId` — now reliable post-Fix-1 — falling back to `conversationStore.get(threadId)?.boundTopicId`) and:
- guard the warm-listener branch: `if (listenerManager && shouldUseListener(...) && !isTopicBoundReply)` (7244);
- the pipe-spawn guard already excludes topic-bound post-Fix-1 (7202);
- ⇒ topic-bound replies fall through to `handleInboundMessage` (7264) → `tryRouteReplyToTopic`.
Integration test must exercise the **relay** path (not just local) with a trusted short reply.

### Fix 2 — confirmed-consumption + deterministic fallback (redesign; supersedes the rejected "always-surface")

The convergence verdict: "always-surface" guarantees a *double-surface* in the common (inject-works) case and makes rate-limit the sole throttle — a near-silent violation. Instead:

1. **Make the inject report real consumption.** Extend `SessionManager.injectPasteNotification` (which already has stuck-detection + 4-attempt auto-recovery) to return a verified result, and have the `injectIntoSession` dep surface it (sync if bounded; otherwise a `Promise<boolean>`). `deliveryMode='live-inject'` is set **only on confirmed consumption**. If recovery exhausts → treat as not-injected → `deliveryMode` stays `failure-visible`.
   - *Fallback if confirmation proves infeasible in impl:* mark the thread `pending-surface`, and a short bounded beacon (≤N s) posts the deterministic surface if no user-facing post for the thread is observed. (Documented alternative; prefer the direct confirmation.)
2. **Honest delivery accounting:** `surfacedToUser = (deliveryMode==='live-inject' /*confirmed*/ ) || telegramSent`. A stalled inject no longer resolves the commitment.
3. **Guaranteed surface only when needed, salience preserved as suppressor:** keep `shouldSurface` driven by `verdict==='user-visible' || deliveryMode==='failure-visible' || (deliveryMode==='resume-pending')`. Because a *stalled* inject now yields `failure-visible`, the deterministic surface fires exactly in the failure case — NOT on a successful live-inject (no double-surface). Salience still suppresses pure-ack noise.
4. **First-reply carve-out:** on `isFirstReply`, force the surface even if rate-limited (a first reply must never be the one dropped).
5. **Per-topic coalescing (anti-flood, S2):** buffer topic surfaces over a short window (~30–60 s) and post ONE digest ("codey replied N× on \"X\"") when bursts exceed the per-topic cap (`USER_VISIBLE_PER_TOPIC_LIMIT=3/60s`), instead of dropping the surplus.
6. **Null-telegram:** if `sendTelegramToTopic===null` (no Telegram configured), leave the commitment OPEN (never falsely resolved). Wiring-integrity E2E asserts the dep is non-null in the standard boot path.

### Fix 3 — stamp `transport.originTopicId` on the transmitted envelope (B)

Additive optional field. Peer maps it to ITS OWN topic only via its own mapping and **never echoes the sender's value back as a routing target** (preserves the F1 anti-poisoning guard). Topic id = Telegram `message_thread_id` (a small per-chat integer, inert without bot token+chat id) → low sensitivity.

### Fix 4 — persist the outbound leg through the aggregate writer (D; prerequisite of C)

On the relay-send local fast-path, persist the **outbound** envelope through the SAME path the inbound leg uses (`MessageRouter.relay(...,'agent')`/the writer that builds `threads/{threadId}.json`), NOT a bare `messageStore.save()` — `getThread():306` reads the `threads/{id}.json` aggregate, so a bare save would leave history one-leg-blind. Idempotent by message id. Test asserts `getThread()` returns BOTH legs.

### Fix 5 — dedup + ack-loop (E)

Inbound dedup by `message.id` (drop a re-delivered envelope already recorded for the thread). Confirm the existing "don't spawn for terminal courtesy acks" guard ([[bug_cross_agent_ack_spawn_loop]]) covers the warrants-reply path; add a test.

### S5 — CollaborationSurfacer mutual-exclusion

`routes.ts:11914` surfaces *parentless* warranted inbounds via `collaborationSurfacer`; topic-bound go via TopicLinkageHandler. The new logic must keep these **mutually exclusive** (exactly one surfacer per inbound). Integration test asserts it.

---

## 4. Test strategy (all three tiers + test-as-self)

**Unit:** `get()` returns a topic-bound entry with no JSONL, still nulls a non-topic entry with no JSONL, still returns pinned (both sides). `tryRouteReplyToTopic`: confirmed-inject ⇒ NO extra Telegram note (double-surface guard) + commitment resolves; stalled-inject ⇒ deterministic surface fires + commitment resolves on `telegramSent`; null-telegram ⇒ commitment stays OPEN; first-reply forces surface past rate-limit; coalescing emits one digest for a burst. Envelope builder stamps `transport.originTopicId`. Inbound id-dedup drops a duplicate.

**Integration:** **relay path** (gate-passed, trusted short reply, topic-bound) routes to the topic — NOT warm-listener/pipe-spawn (Fix 1b). Local `/messages/relay-agent` topic-bound reply → topic surface. `threadline_history`/`GET /messages/thread/:id` returns the thread AND both legs (C+D). Exactly one of {TopicLinkageHandler, CollaborationSurfacer} fires per inbound (S5).

**E2E (wiring + lifecycle):** TopicLinkageHandler constructed at `server.ts:6803` with `sendTelegramToTopic !== null` in the standard boot path (not just constructed). Inbound topic-bound reply end-to-end produces a topic surface.

**Test-as-self (mandatory gate):** build → deploy dist to live Codey shadow-install → restart → drive the real round-trip (Echo→Codey w/ originTopicId; Codey replies) on BOTH a stalled-session and a healthy-session scenario → assert the reply appears in topic 12304 (not just the store) and is NOT double-posted when the live session relays → restore Codey to released dist → then merge.

## 5. Migration parity

Pure `src/` changes shipped in the dist → existing agents get them via the normal update path; no `.claude`/config/template/hook surface changed ⇒ no PostUpdateMigrator entry (confirm in impl). `transport.originTopicId` additive/optional → no version gate.

## 6. Side-effects (convergence-ranked)

- **Notification flood (was HIGH):** mitigated by confirmed-inject (no surface on working inject) + salience suppressor + per-topic coalescing + first-reply carve-out. Net: replies that currently vanish now produce at most one (coalesced, rate-limited) surface.
- **Double-surface (was HIGH):** eliminated — deterministic surface fires only on `failure-visible` (stalled inject), never alongside a successful live relay.
- **Guard-weakening (Fix 1):** scoped to `originTopicId !== undefined`; non-topic resume semantics unchanged; dead-topic entries still TTL-expire.
- **Fix 4 read-path:** must write through the aggregate writer, else history stays half-blind despite the save — pinned by a `getThread()` assertion.
- **originTopicId leak:** low; opaque per-chat integer; peer never echoes it back as a routing target.
- **Rollback:** localized to ThreadResumeMap / TopicLinkageHandler / ThreadlineRouter / SessionManager.injectPasteNotification / relay-send route / gate-passed handler — clean revert.

## 7. Resolutions (decided during implementation)

1. Fix 2: implemented direct confirmed-consumption — `SessionManager.injectPasteNotificationConfirmed` observes the paste-recovery window (checks at 1/3/5/7.5s) and returns whether the marker left the prompt; `injectIntoSession` is now async and returns that verdict. No beacon variant was needed.
2. Anti-flood: the existing per-thread (60s) + per-topic (3/60s) rate limits are retained as the throttle. The originally-considered first-reply carve-out was DROPPED during implementation — a thread's first reply has no prior surface so it already passes the per-thread limit, and the per-topic cap must hold even for first replies (otherwise N rotating threads = N surfaces = the very flood the cap prevents; a carve-out would also misfire once the commitment is delivered, since findByThreadId then returns null and isFirstReply flips true again). A buffering/coalescing digest was judged unnecessary given the per-topic cap already limits a topic to 3 surfaces/min.
3. Fix 5 ships in this PR: our-side inbound dedup-by-message-id already exists (`relay()` line ~233 + `store.save` dedup) and is locked in by a regression test.
