---
title: "Thread↔Topic Linkage"
slug: "thread-topic-linkage"
author: "echo"
status: "converged"
review-convergence: "2026-05-11T23:55:00Z"
review-iterations: 2
review-completed-at: "2026-05-11T23:55:00Z"
review-report: "docs/specs/reports/thread-topic-linkage-convergence.md"
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-05-11"
approval-note: "Approved via Telegram topic 9210 — 'approved, please proceed' after reviewing Rev 2 of the spec; convergent review (4 internal reviewers + reviewer-driven code fixes) completed in two iterations before commit."
---

# Thread↔Topic Linkage Spec

**Status:** Converged (Revision 3 — multi-reviewer audit complete)
**Author:** Echo
**Date:** 2026-05-11
**Tracking:** Follow-up to PR #146 (live-relay discover). Requested by Justin via topic 9210.

## Revision History

- **Rev 1 (2026-05-11):** Initial spec proposed a new `awaitingThreads` field on `TopicResumeMap`, a bespoke salience gate, and bespoke notification cadence.
- **Rev 2 (2026-05-11):** Justin asked whether existing task-management infrastructure could be leveraged. After review, three subsystems map almost exactly onto the spec's needs — `CommitmentTracker`, `PromiseBeacon`, `InitiativeTracker`. This revision drops the new state field, expresses awaits as one-time-action commitments, and reuses the beacon for heartbeat cadence. Net effect: roughly half the new code, same user-facing behavior, one unified concept ("commitment with follow-through") instead of two parallel ones.
- **Rev 3 (2026-05-11):** Convergent review surfaced 29 findings across security, adversarial, scalability, and integration angles. Highest-impact findings addressed in the same commit: prompt-injection delimiter discipline on the inject path, bad-entry poisoning guard via first-write-wins on `originTopicId`, sender verification on inbound (commitment hijack), per-topic Telegram rate-limit (rotating-threadId bypass), threadId→commitmentId index (O(1) lookup, bounded by active threads), self-target guard (ping-pong loop), purpose length cap, honest fallback-only user copy. Multi-user and multi-machine concerns documented in §6 / §9 as out-of-scope-for-v1 with v2 follow-up plans.

## 1. Problem

When a user-facing topic session sends a threadline message to another agent and pauses waiting on a reply, today the reply does not flow back to that topic. It spawns (or resumes) a separate "thread-worker" session that has no awareness of which Telegram topic kicked off the conversation, no awareness of what the topic was trying to accomplish, and no path to surface the answer back to the user.

In practice this means:

- The user has to manually check whether a reply arrived and manually re-prompt the topic to continue.
- Agent-to-agent replies pile up in dormant thread-worker sessions and never reach the user even when the user needs them.
- A "Spawn denied — memory pressure" or any other thread-worker failure leaves the reply orphaned with no visible signal.
- There's no durable record of "topic 9210 is waiting on a reply from ai-guy about Stripe" — so if the session dies, the wait is forgotten.

This makes threadline feel mechanical instead of organic. The user should be able to ask their agent "ping ai-guy about the Stripe export" and trust that:

1. The reply lands in the same topic conversation, not somewhere else.
2. The agent knows it was waiting for that specific information and continues the work it was doing.
3. The user is notified only when the reply contains something the user actually needs to see or decide on — not for every back-and-forth between agents.
4. If the reply takes a day, the session pauses cleanly and wakes on its own when it arrives.

## 2. Goals

1. **Continuity.** Replies resume the topic session that initiated the conversation, with the full thread history available.
2. **Selective surfacing.** The user is notified in the topic when the reply is relevant to them, not for every back-and-forth between agents.
3. **Awaiting-state durability.** "Topic Z is waiting on thread X for purpose Y" survives session death, machine restarts, and long delays.
4. **Multi-thread per topic.** A topic can be awaiting multiple threadline replies simultaneously and route each one correctly.
5. **Reuse over reinvention.** Use existing follow-through infrastructure (`CommitmentTracker`, `PromiseBeacon`, optionally `InitiativeTracker`) instead of building parallel state.
6. **Backwards compatibility.** Threads created before this lands keep working under the current thread-worker path.

## 3. Non-Goals

- Not redesigning how threadline messages are sent or received on the wire. The relay protocol, `MessageEnvelope`, autonomy gate, and trust model are unchanged.
- Not unifying `ThreadResumeMap` and `TopicResumeMap`. The linkage is by reference, not by merger.
- Not building a generic "wait for arbitrary event" primitive for sessions. Scope is narrow: wait for a threadline reply on a specific thread.
- Not changing how the user's outbound prompts reach the topic session.

## 4. Existing Infrastructure We Will Reuse

This section is new in Rev 2. Before designing new state, we map the spec's needs onto what's already there.

### 4.1 CommitmentTracker (`src/monitoring/CommitmentTracker.ts`)

Already does:

- Durable "the agent promised X" store with a `one-time-action` type.
- `topicId` field linking a commitment to the Telegram topic it was made in.
- Extensible `verificationMethod` enum (`config-value | file-exists | manual`) for how a commitment self-verifies.
- Full lifecycle: `pending → verified → delivered` (terminal) plus `violated`, `expired`, `withdrawn`.
- Optimistic-CAS mutate path and persistent storage.
- Auto-opts a one-time-action commitment into `PromiseBeacon` when `topicId` is present.
- Time-promise sniffer (`detectTimePromise`) that turns "back in 20 minutes" into beacon cadence + hard deadline.

What we add: one new `verificationMethod: 'threadline-reply'` plus two fields (`relatedThreadId`, `relatedAgent`) on the commitment record.

### 4.2 PromiseBeacon (`src/monitoring/PromiseBeacon.ts`)

Already does:

- Watches commitments where `beaconEnabled: true` and emits cadence-based heartbeats to the topic ("still on it, no new output since last update", etc.).
- Snapshot-hash gate avoids LLM calls when nothing has changed.
- Quiet hours, daily spend cap, session-epoch check, signal-vs-authority guardrails.
- Shared `ProxyCoordinator` so it doesn't double-post with other monitors.

What we add: nothing in the beacon itself. A threadline-await commitment is just another commitment, so the beacon handles it out of the box. Optionally we can register a tiny `classifyProgress` callback that asks "is this thread still alive on the other side?" but that's an optimization, not a requirement.

### 4.3 InitiativeTracker (`src/core/InitiativeTracker.ts`)

Already does:

- Multi-phase work with phases, blockers, `needsUser`, `nextCheckAt`, topic links.
- Daily digest job alerts on stale / needs-user / next-check-due / ready-to-advance.

What we add: nothing required. For genuinely multi-agent jobs (e.g., the Stripe ask fanning out to ai-guy + Dawn + a backup direct-API pull), users can manually create an Initiative and link the threadline-await commitments to its phases. Surfacing an Initiative for every single threadline await would be over-engineering. Reserve for multi-step work.

### 4.4 ThreadResumeMap (`src/threadline/ThreadResumeMap.ts`)

Already does:

- `{threadId → {uuid, sessionName, remoteAgent, ...}}` with 7d TTL.
- Drives threadline resume on inbound replies.

What we add: two optional fields (`originTopicId`, `originSessionName`) as a fast-path cache for inbound routing. The source of truth for "what topic owns this thread" is the commitment record; the cache exists so the router doesn't have to query the commitment store on every inbound message.

## 5. Design

### 5.1 Data model — minimal additions

#### 5.1.1 New `verificationMethod` on Commitment

```ts
verificationMethod?: 'config-value' | 'file-exists' | 'manual' | 'threadline-reply';
```

#### 5.1.2 New optional fields on `Commitment`

```ts
/** For verificationMethod === 'threadline-reply': the thread we're waiting on. */
relatedThreadId?: string;
/** For verificationMethod === 'threadline-reply': the agent we're waiting on. */
relatedAgent?: string;
```

#### 5.1.3 New optional fields on `ThreadResumeEntry`

```ts
/** If this thread was initiated by a topic-bound session, the topic that owns it. */
originTopicId?: number;
/** Session name of the originating topic at send time. Fast-path cache. */
originSessionName?: string;
```

That's the entire schema delta. No new persistent files. No new map structures.

### 5.2 Outbound capture path

When `threadline_send` is invoked, before the envelope hits the relay:

1. **Identify the originating topic** in this order:
   - Explicit caller hint via a new optional `originTopicId` parameter on `threadline_send`.
   - Reverse lookup: the calling session's tmux name matched against `TopicResumeMap`.
   - If neither resolves → no linkage. Thread routes via existing thread-worker path on reply. (This is the existing behavior for autonomous job-fired sends.)

2. **Capture the agent's stated purpose** via a new optional `purpose` parameter on `threadline_send`. This is internal-only — never serialized into the outbound `MessageEnvelope`. It exists so the topic session, when later resumed by the reply, sees "you sent this to get the 2025 Stripe net+gross volume CSVs" rather than just the envelope text.

3. **Stamp the cache** on `ThreadResumeMap`:
   ```
   ThreadResumeMap.save(threadId, { ..., originTopicId, originSessionName })
   ```

4. **Create a commitment** via `CommitmentTracker`:
   ```
   commitment = {
     type: 'one-time-action',
     verificationMethod: 'threadline-reply',
     topicId: originTopicId,
     relatedThreadId: threadId,
     relatedAgent: message.to.agent,
     userRequest: purpose ?? `Awaiting reply from ${remoteAgent}`,
     agentResponse: `Sent threadline message to ${remoteAgent}, awaiting reply`,
     beaconEnabled: true,  // auto-opted by existing CommitmentTracker logic when topicId present
     expiresAt: <7 days from now>,  // matches ThreadResumeMap TTL
   }
   ```

5. **PromiseBeacon picks it up.** No new wiring — the existing auto-opt logic in `CommitmentTracker.create` (line 325) already triggers `beaconEnabled` when `topicId` is set. The beacon will emit "still waiting on ai-guy for the Stripe data" pings on its existing cadence schedule.

### 5.3 Inbound dispatch decision tree

`ThreadlineRouter.handleInboundMessage` is extended with a commitment-aware branch *after* the autonomy gate and *before* the existing resume/spawn logic. Pseudocode:

```
existingEntry = ThreadResumeMap.get(threadId)
topicId = existingEntry?.originTopicId

if topicId:
    commitment = CommitmentTracker.findByThreadId(threadId)  // new lookup
    topicEntry = TopicResumeMap.get(topicId)

    if topicEntry exists:
        salience = await SalienceGate.classify(message, commitment, threadHistory)

        payload = {
            kind: 'threadline-reply',
            threadId,
            remoteAgent: message.from.agent,
            body: message.body,
            threadHistory: ThreadHistoryStore.fetch(threadId),
            commitmentPurpose: commitment?.userRequest,
            salience,
        }

        if topic session is live:
            inject payload into topic session
        else:
            resume topic session with payload as resume prompt

        if salience == 'user-visible':
            TelegramAdapter.sendToTopic(topicId, formatUserNotification(payload))

        if commitment:
            CommitmentTracker.markDelivered(commitment.id, {
                resolution: `Threadline reply received from ${remoteAgent}`,
            })
            // PromiseBeacon stops heartbeating this commitment naturally.

        return { handled: true, deliveredTo: 'topic-session' }

# Fallback: no topic linkage → existing thread-worker behavior
...
```

A few notes:

- `CommitmentTracker.findByThreadId(threadId)` is a new lookup helper — small addition, ~10 lines, returns the matching one-time-action.
- Marking the commitment `delivered` is what tells `PromiseBeacon` to stop. No explicit beacon-stop call needed; the beacon's existing logic skips terminal commitments.
- If the commitment was already `delivered` or `expired` (e.g., a late reply after the 7-day window), still route the reply but skip the commitment transition.

### 5.4 Salience gate

A small LLM-backed classifier decides whether the reply is something the user should see in the topic, or whether agents are still working things out among themselves.

**Inputs:**
- The reply text.
- The commitment's `userRequest` (the stated purpose).
- The thread history (last N turns).
- A simple rubric.

**Output:** `'user-visible' | 'agent-internal'` plus a one-line reason.

**Rubric (system prompt skeleton):**

> You are deciding whether to surface a threadline reply to the human user in their topic. The user delegated a task to their agent; the agent is talking to another agent to complete it.
>
> Mark `user-visible` if the reply:
> - Contains a final answer, deliverable, or data the user asked for.
> - Asks the user a question only the user can answer (credentials, decisions, permissions).
> - Reports a hard blocker that the user needs to unblock.
> - Indicates the task is complete or has failed permanently.
>
> Mark `agent-internal` if the reply:
> - Is an acknowledgement, mid-negotiation, clarification between agents, or progress check that the receiving agent can act on without user involvement.
> - Is a routine "received, will work on it" message.

**Model:** Haiku-class (per "Intelligence Over String Matching" rule — efficient ≠ regex).

**Failure mode:** If the gate errors or times out (>2s), default to `user-visible` for the first reply on a thread (no `lastReplyAt` recorded yet) and `agent-internal` for subsequent replies. Bias toward not flooding the user but not silently swallowing first contact.

**Placement:** The salience gate is *separate from* the `PromiseBeacon.classifyProgress` callback. The beacon's classifier decides "are we still waiting / has the agent stalled" — a session-internal signal. The salience gate decides "should this reply surface to the user" — a topic-external signal. Different concerns, separate decisions.

### 5.5 Telegram notification surface

When salience is `user-visible`, the router posts to the originating topic via `TelegramAdapter`. Format:

```
💬 Reply from {remoteAgent} on "{subject}":

{body}

(You asked for this in this conversation; I'm picking it back up now.)
```

The notification fires *before* the topic session is injected/resumed, so the user sees the reply at roughly the same time the session does, and the session's next message in the topic builds naturally on top.

Rate-limit: max 1 user-visible surface per thread per minute, batched if multiple arrive in the window. (Defends against a chatty reply burst.)

### 5.6 Session resume prompt

When the topic session is resumed (vs. live-injected), the resume prompt is a structured message, not a raw paste. Template:

```
[threadline-reply]
A threadline reply just landed on a conversation you initiated.

Thread: {subject}
With: {remoteAgent}
Your stated purpose when you sent: {commitment.userRequest}

Reply body:
{body}

Thread history (most recent first):
{history}

Salience: {user-visible | agent-internal}
{If user-visible: A Telegram notification was already sent to topic {topicId}.}
{If agent-internal: The user has not been notified — handle without surfacing unless needed.}

Continue the work this thread was supporting.
```

### 5.7 Live-session injection

When the topic session is live, use the existing `MessageInjectionDelivery` path (the same one PR-4 uses for thread-injection). The injected payload is the same structured prompt as §5.6 but framed as a delivered message rather than a fresh session prompt.

### 5.8 Initiative linkage (optional, surfaced not built)

For multi-step efforts, the user (or the agent on their behalf) can create an `Initiative` whose phases reference threadline-await commitments. Wiring:

- `InitiativeLink.type === 'commitment'` (new link type, one line of code).
- The existing initiative-digest job already alerts on stale, needs-user, and ready-to-advance — those flags fire naturally when underlying commitments transition.

This is opt-in. No autocreation. Documented in the spec so the affordance exists; the user discovers it via the dashboard "Initiatives" tab when they want it.

## 6. Edge Cases

### 6.1 Multi-thread per topic

A topic might send threadline messages to three different agents in parallel. Each gets its own `threadId`, each is recorded on its own commitment, each routes back independently. The resume prompt names which thread fired. `CommitmentTracker.findByThreadId` returns at most one match per thread.

### 6.2 Topic resolved before reply arrives

If the topic has been removed from `TopicResumeMap` (24h TTL expired, user closed the topic), the router falls back to the thread-worker path and the reply lands there. The thread-worker prompt mentions "the topic that initiated this conversation has expired — handle this reply standalone." The commitment, if still pending, transitions to `delivered` with `resolution: 'Reply received after originating topic was archived'`.

### 6.3 Cross-machine origin

If `ThreadResumeEntry.machineOrigin` doesn't match the local machine, the router falls through to the thread-worker path and emits the existing cross-machine notification. Out of scope for this spec to change.

### 6.4 User sends a new message into the topic while a reply is in flight

Live message-injection delivery is FIFO per session — both messages queue and process in order. No new mechanism needed.

### 6.5 Spawn-denied / delivery failure

If injection fails and the session can't be resumed (memory pressure, no available process slot), the reply is queued in the existing inbound queue *and* the user gets a notification regardless of salience: "Reply arrived from {agent} on '{subject}' but I couldn't pick it up automatically — let me know when to retry." The commitment stays `pending` (not transitioned to `delivered`) so PromiseBeacon continues to heartbeat — the user has visible follow-through that something is wedged.

### 6.6 Stale commitment cleanup

Existing `CommitmentTracker` already handles `expiresAt`. We set 7-day expiry to match `ThreadResumeMap` TTL. When the commitment expires without a reply, the existing expiry handler runs; we add a one-line resolution note that prompts the user via the existing digest: "Asked {agent} about {purpose} 7 days ago and never heard back."

### 6.7 Reply on a thread our agent initiated without topic context

Job-fired or autonomous threadline sends have no `originTopicId` → no commitment created → router falls through to thread-worker. Existing behavior, unchanged.

### 6.8 Late reply after commitment delivered

If a reply arrives on a thread whose commitment is already in a terminal state (`delivered`, `expired`, `withdrawn`), still route the reply to the topic if possible. Skip the commitment transition. Salience gate still runs. Log a low-severity warning that a reply arrived post-resolution.

### 6.9 Bad-entry poisoning (first-write-wins on `originTopicId`)

If a local but unrelated caller (any process holding the agent's bearer token) attempts to re-stamp an existing thread's `originTopicId` with a different value, the capture handler refuses the overwrite and logs a warning. First-write wins. This prevents a misbehaving local tool or a stolen-token attacker from redirecting inbound replies on someone else's thread to a different topic. The source of truth is the commitment's `topicId` field, set at creation and immutable.

Out of scope for v1: full session→topic binding verification on the HTTP route (requires per-session capability tokens). Tracked as a v2 follow-up. The first-write-wins guard closes the most common attack shape; the v2 binding closes the rest.

### 6.10 Cross-user routing (multi-user)

When a single instar instance serves multiple Telegram users (per `MULTI-USER-SETUP-SPEC.md`), a reply must not surface in a topic owned by a different user than the one whose session initiated the outbound send. v1 does not yet implement multi-user routing — instar runs as a single-user agent in current deployments — and this spec does not add the `ownerUserId` field that the eventual multi-user routing will require. When multi-user lands, this section becomes a hard requirement: capture and persist `ownerUserId` alongside `originTopicId` on `ThreadResumeEntry` and on the commitment; refuse routing if the topic's current owner doesn't match the captured owner.

### 6.11 Cross-machine failover

ThreadResumeEntry carries `machineOrigin` and `migratedTo`. Telegram topics are machine-local; topic 9210 on machine A has no counterpart on machine B. When a thread is migrated, `originTopicId` is preserved on the entry but becomes meaningless on the target machine — `topicResumeMap.get(originTopicId)` returns null, the handler returns `topic-expired`, and the router falls through to the thread-worker path. The commitment lives on the original machine's `commitments.json` and is not migrated.

For v1 this is acceptable: cross-machine failover is rare, and the failover surface (existing cross-machine notification mechanism) signals the affected user. For v2, the router should scrub `originTopicId` from migrated entries (or refuse to apply it when `entry.machineOrigin !== local`) so the fall-through is explicit rather than racing on a stale topic-id space.

### 6.12 Sender verification on inbound

Per security review F5, when an inbound reply arrives on a thread for which a commitment exists, the handler verifies that `envelope.message.from.agent` matches `commitment.relatedAgent`. On mismatch the handler returns `no-linkage` (control falls through to the thread-worker path) and does NOT transition the commitment. This closes the threadId-collision / affinity-collision / observation-replay attack where a third party knowing the threadId could fabricate a reply on it.

### 6.13 Same-machine ping-pong guard

When `remoteAgent === localAgent` (an agent on the same machine sending to itself, e.g., during multi-agent collaboration), `captureOriginOnSend` returns null without creating a commitment. Without this guard, two of our own sessions exchanging messages would each accumulate commitments per turn and PromiseBeacon would amplify the cycle into alternating "still waiting" notifications across both topics.

### 6.14 Commitment manually withdrawn while thread is pending

User can withdraw a commitment via `PATCH /commitments/:id`. If the reply later arrives, route normally but skip notification (user already opted out of caring). Add a "withdrawn" note to the session resume prompt.

## 7. Migration

Fully additive:

- Two optional fields on `ThreadResumeEntry`. Existing entries deserialize as `undefined`.
- New `verificationMethod` enum value plus two optional commitment fields. Existing commitments unaffected.
- No new persistent stores.
- No data migration required.
- No flag-gating needed; new code paths only fire when `originTopicId` is populated, which only happens after the new outbound-capture code runs.

## 8. Test Plan

### 8.1 Unit

- `ThreadResumeMap.save` round-trips `originTopicId` and `originSessionName`.
- `CommitmentTracker.findByThreadId` returns the matching commitment, returns null on miss, ignores withdrawn/expired.
- `CommitmentTracker.create` with `verificationMethod: 'threadline-reply'` and a `topicId` auto-enables the beacon (existing behavior, regression test).
- `SalienceGate.classify` returns deterministic shape for each rubric branch (mocked LLM).
- Router decision tree: 6 cases — has-origin-and-live, has-origin-and-dormant, has-origin-but-topic-expired, no-origin, salience-user-visible, salience-agent-internal.

### 8.2 Integration

- End-to-end: topic session sends → server stamps origin + creates commitment → PromiseBeacon registers the commitment → simulated reply arrives → topic session is resumed → commitment transitions to `delivered` → beacon stops heartbeating → Telegram notification posts when salience is user-visible.
- Multi-thread per topic: send 3 in parallel, simulate 3 replies in scrambled order, verify each routes to the right commitment.
- Cross-machine origin: thread `machineOrigin` mismatched → fall through to thread-worker.
- Spawn-denied failure path: inject mock failure, verify commitment stays pending and user gets failure-visible notification.

### 8.3 Live verification (before claiming done)

Per the "verify against real APIs before shipping" rule:

1. From topic 9210 (echo on this machine), threadline_send to luna with a purpose ("ask for the latest threadline test agent count").
2. Confirm a one-time-action commitment with `verificationMethod: 'threadline-reply'` was created on echo, linked to topic 9210 and thread X.
3. Confirm `originTopicId: 9210` is stamped in `thread-resume-map.json`.
4. Confirm PromiseBeacon picked it up (visible in commitments list).
5. Have luna reply.
6. Verify: topic 9210 session receives the reply, the Telegram message lands in topic 9210 (if salient), the commitment transitions to `delivered`, the beacon stops heartbeating.

## 8.4 New defensive tests added (Rev 3)

Beyond the §8.1–§8.3 plan, the convergent review drove additional unit tests:

- `TopicLinkageHandler.test.ts`: refuses cross-topic overwrite (poisoning guard); refuses inbound on sender mismatch (hijack guard); inject payload wraps remote body in nonce-guarded delimiter (prompt-injection guard); per-topic rate-limit caps surfaces across rotating threads (bypass guard); same-machine self-target returns null (ping-pong guard); purpose length cap.

Result: 18 TopicLinkageHandler tests + 8 SalienceGate + 8 CommitmentTracker-threadline-reply = 34 new tests total, all passing alongside 152 existing related tests (186 total in the scope of this PR).

## 9. Risks & Open Questions

1. **Salience gate latency.** LLM gate adds a few hundred ms to inbound routing. Mitigation: classifier runs after the autonomy gate and in parallel with injection setup; if it doesn't return within 2s, default per §5.4.

2. **User-visible flooding.** If the salience gate over-triggers user-visible, the user gets spammed. Mitigation: per-thread rate-limit per §5.5.

3. **Race: reply arrives while topic session is mid-send to a different thread.** Live injection queues. No new race.

4. **Privacy: `purpose` field is internal.** Code review must assert that `purpose` never makes it into the outbound `MessageEnvelope`. It's a local-only annotation stored on the commitment.

5. **Threadline-affinity reuse for first-contact-without-threadId.** Existing `peekAffinity` mechanism preserves threadId across first-contact gaps. Our commitment lookup by threadId benefits from this — no new mechanism needed.

6. **`commitment.userRequest` text quality.** The commitment's `userRequest` becomes the "stated purpose" surfaced in the resume prompt. If the calling session passes no `purpose`, we default to `Awaiting reply from {agent}` which is correct but unhelpful. Open question: should we auto-derive a purpose from the outbound message body via an LLM call? Probably not for v1 — keep it explicit.

7. **`commitmentTracker.findByThreadId` index.** Shipped with the secondary `threadIdIndex` Map (per Rev 3 convergent review F1-scalability). Lookup is O(1) plus one status check, bounded by active threadline-reply commitments rather than lifetime commitment count. Index is rebuilt at load and maintained on every record/deliver/withdraw call.

8. **PromiseBeacon overlap with salience gate.** The beacon's `classifyProgress` is "is the agent stalled?" The salience gate is "should this reply surface?" They're distinct, but the rubrics share enough vocabulary to risk conceptual drift over time. Code review must keep the separation crisp.

9. **Notification format.** Verbatim with 500-char cap; longer bodies get a "expand" affordance (publish to private view). Open for refinement.

10. **Dashboard surface for awaiting commitments.** Out of scope for the build itself. Existing commitments dashboard lists active commitments and shows topicId / cadence / heartbeats. v1 dashboard does NOT specifically render `relatedThreadId`, `relatedAgent`, `verificationMethod`, or `lastReplyAt` — these fields exist on the record but are not yet surfaced in the UI. Per integration review F5. A v2 enhancement should add a threadline-await section to the commitments panel grouping commitments by topic and showing the remote agent + last-reply timestamp.

11. **Backup / downgrade safety.** A backup taken on the new version contains commitments with `verificationMethod: 'threadline-reply'`. Restoring that backup on an older instar version (pre-this-PR) leaves those rows in a `pending` state — the older `verifyOne` doesn't recognize the method and the older `isUnverifiableOneTime` doesn't match (so the auto-deliver backfill doesn't fire). Rows accumulate violation increments on every sweep until manually withdrawn via `PATCH /commitments/:id`. Operators downgrading should be aware. Per integration review F2.

12. **Config knobs.** v1 hard-codes: per-thread Telegram rate-limit (60s), per-topic rate-limit (3/60s), commitment expiry (7 days), purpose length cap (1024), inject body cap (8000), LLM classifier (unwired). A v2 config surface should expose these and add a kill-switch (`threadline.topicLinkage.enabled: false`) for emergency rollback short of revert.

13. **LLM-backed salience classifier.** The `SalienceGate` accepts a `classify` callback via its constructor but v1 wires no classifier — the deterministic fallback (user-visible on first reply per thread, agent-internal subsequently) is what ships. A Haiku-class classifier with the §5.4 rubric should be wired in v2 so the user-visibility decision becomes content-aware rather than recency-based.

## 10. Rollout Plan

Single PR via the instar-dev process. Side-effects review must cover:

- New outbound-capture path doesn't leak `purpose` over the wire.
- Salience gate's default-on-error behavior matches the rubric.
- New `verificationMethod: 'threadline-reply'` is correctly handled by the existing commitment verification sweep (it should be a no-op — the router transitions the commitment directly, the sweep should ignore it the same way it ignores `manual`).
- PromiseBeacon auto-opt-in fires correctly for the new commitments.
- Telegram notification surface doesn't double-fire with the beacon's heartbeat.
- The new commitment doesn't accidentally land in the `unverifiable` migration path (§4.1 of the existing CommitmentTracker).

Upgrade notes in the same PR per the release-notes-in-same-PR rule.

## 11. What Changes vs Rev 1

| Rev 1 | Rev 2 |
|---|---|
| New `awaitingThreads` field on `TopicResumeMap` | Removed — use `CommitmentTracker` |
| New bespoke heartbeat cadence | Removed — `PromiseBeacon` handles it |
| New bespoke stale-cleanup | Removed — `CommitmentTracker.expiresAt` handles it |
| Salience gate as new subsystem | Kept, but smaller — runs in the inbound router, plugs into the existing `TelegramAdapter` surface |
| `originTopicId` cache on `ThreadResumeEntry` | Kept (fast-path) |
| Resume-with-structured-prompt | Kept |
| Live-session injection | Kept |
| InitiativeTracker linkage | Surfaced as optional, not built |

Estimated line-count delta: roughly half of Rev 1's footprint, with stronger guarantees (the durable awaiting-state and heartbeat cadence are now backed by tested infrastructure).

## 12. Summary

Stamp `originTopicId` at send time. Create a one-time-action commitment that ties the thread, the topic, and the stated purpose together — `PromiseBeacon` automatically picks it up and gives the user free "still waiting" heartbeats. On inbound reply, route to the topic session (live-inject or resume), pass the structured payload with thread history and purpose, fire a Telegram notification only when an LLM-backed salience gate says the reply is user-worthy, mark the commitment delivered, and let the session continue its work. Fall back cleanly for threads without origin linkage, expired topics, and cross-machine cases.

End result: the user delegates a task, gets heartbeat reassurance while it's outstanding, gets pinged when something they need to see arrives, and the agent picks up its own work the moment the awaited information lands — all running on infrastructure that already exists.
