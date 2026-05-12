# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Thread↔Topic Linkage — threadline replies now route back to the originating topic session

When a topic-bound agent session sends a threadline message via `threadline_send`, it can now mark the send with the originating Telegram topic and a stated purpose. When the reply later arrives, instar routes it back to that topic's session (live-inject if running, queued-for-resume if dormant), creates a durable awaiting-state commitment that PromiseBeacon picks up automatically (giving the user free "still waiting on X" heartbeats), and posts a Telegram notification when the reply is the first one on a given thread.

**v1 ships with a deterministic salience rule, not an LLM-backed gate.** The SalienceGate class is plumbed for an LLM classifier callback but no classifier is wired by default. In v1 the rule is: first reply on each thread fires a Telegram notification; subsequent replies on the same thread route silently to the topic session. An LLM-backed gate that classifies reply content is a follow-up.

Spec source: `docs/specs/THREAD-TOPIC-LINKAGE-SPEC.md` (Rev 3).

- The MCP `threadline_send` tool gains two new optional fields: `originTopicId` (number) and `purpose` (string — stored locally, NEVER sent over the wire to the remote agent).
- The HTTP route `POST /threadline/relay-send` accepts the same two optional fields and forwards them to a new capture path.
- `Commitment` (in `CommitmentTracker`) gains optional fields: `verificationMethod: 'threadline-reply'` (new enum value), `relatedThreadId`, `relatedAgent`, `lastReplyAt`. New public methods `findByThreadId(threadId)` and `markReplyArrived(commitmentId)`.
- `ThreadResumeEntry` gains two optional cache fields: `originTopicId` and `originSessionName`.
- New module `src/threadline/SalienceGate.ts` — LLM-backed (when configured) or deterministic-fallback classifier.
- New module `src/threadline/TopicLinkageHandler.ts` — orchestrates outbound capture, inbound dispatch, Telegram surface, and commitment lifecycle.
- `ThreadlineRouter.handleInboundMessage` gains a topic-aware branch before the existing live-inject/resume/spawn flow.

All changes are additive. Existing threads created before this lands have no `originTopicId` and route via the unchanged thread-worker path.

## What to Tell Your User

Your agent can now hold a conversation with another agent on your behalf and pick up the work as soon as the reply lands. Before, when your agent sent a threadline message in a topic and the other agent later replied, the reply went to a separate worker session with no awareness of which topic kicked off the conversation. Now, when your agent sends and tags the message with the topic, the system remembers the link. When the reply arrives, it gets routed back to your topic session. If that session is awake, it sees the reply right away. If the session is paused, the reply is held until you message the topic again. You will get a Telegram notification on the first reply per thread; subsequent replies route silently to your topic session.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Topic-aware threadline send | Pass `originTopicId` and an optional `purpose` to `threadline_send` from a topic-bound session. |
| Automatic await tracking | The send creates a one-time-action commitment; PromiseBeacon picks it up by existing auto-opt logic when a `topicId` is attached. |
| Topic-routed inbound replies | Replies on linked threads route to the topic session via live-inject or resume-pending; falls through cleanly for unlinked threads. |
| Salience-gated user surface | A reply fires a Telegram notification when the deterministic rule (first reply per thread) marks it user-visible. LLM-backed content classifier is a follow-up. |
| Reply-arrival tracking | `Commitment.lastReplyAt` records actual reply arrivals; distinct from `heartbeatCount` which counts beacon emissions. |
| Stale-await cleanup | Commitments expire after 7 days; user is informed via existing digest. |

## Evidence

Spec source of truth: `docs/specs/THREAD-TOPIC-LINKAGE-SPEC.md` (Rev 3, 2026-05-11).

- `tests/unit/SalienceGate.test.ts` — 8 tests covering classifier passthrough, classifier-error fallback, timeout fallback, no-classifier configured, and the deterministic fallback rule.
- `tests/unit/TopicLinkageHandler.test.ts` — 18 tests covering outbound capture idempotency, inbound dispatch (no-linkage / topic-expired / live-inject / resume-pending), Telegram surface firing, rate-limiting, slow-reply regression, resume-pending commitment-delivered fix, prompt-injection delimiter guard, bad-entry poisoning guard, sender mismatch guard, per-topic rate-limit bypass guard, self-target ping-pong guard, purpose length cap.
- `tests/unit/CommitmentTracker-threadline-reply.test.ts` — 8 tests covering the new verification method, `findByThreadId` lookup, sweep no-op, and the unverifiable-backfill exclusion.
- Side-effects review: `upgrades/side-effects/thread-topic-linkage.md`.
- Convergence report: `docs/specs/reports/thread-topic-linkage-convergence.md`.
