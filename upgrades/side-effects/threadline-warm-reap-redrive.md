# Side-Effects Review — Threadline warm-worker reap redrive

**Version / slug:** `threadline-warm-reap-redrive`  
**Date:** 2026-07-16  
**Author:** Instar-codey  
**Second-pass reviewer:** independent reviewer agent

## Summary of the change

The shared `ResumeQueue` now accepts an exact Threadline recovery identity (`threadId` plus canonical inbound message ID) when quota pressure kills an unbound warm reply worker mid-turn. Threadline replies carry an HMAC-covered `inReplyTo`, so `server.ts` detects a provably unsettled authenticated inbound, the existing drainer retains all pressure and retry gates, and the recovery helper reconstructs only that exact message for the normal router after checking again that no authenticated correlated outbound settled it.

## Decision-point inventory

- `ResumeQueue.classifyEligibility` — modify — an unbound session has a resume path only when both Threadline identifiers exist.
- `server.ts sessionReaped` subscriber — modify — authenticated canonical inbound plus no later authenticated outbound produces the existing strong `pending-injection` evidence.
- `ResumeQueueDrainer.revalidate` — modify — exact Threadline state must remain pending immediately before redrive.
- `ThreadlineRouter.handleInboundMessage` — pass-through — the existing router still owns trust framing and spawn admission.

## 1. Over-block

Recovery is deliberately refused for malformed identifiers, missing/tampered canonical records, incomplete identity pairs, unavailable wiring, and messages already followed by an outbound. A legitimate message cannot be recovered if its local canonical file is unreadable; this is the safe failure direction because fabricating or replaying unverified content would be worse. Existing delivery remains unchanged.

## 2. Under-block

Outbound settlement requires the exact thread ID and `inReplyTo` message ID. Replies created without correlation metadata do not suppress recovery; this favors at-least-once completion over silently losing a reply. The prompt, MCP schema, localhost HTTP funnel, and canonical outbox all propagate the identity structurally for new reply workers.

## 3. Level-of-abstraction fit

Canonical lookup and HMAC verification belong in `ListenerSessionManager`, durable scheduling belongs in `ResumeQueue`, and contextual routing remains in `ThreadlineRouter`. No parallel reaper or restart controller was introduced. The low-level facts feed the established recovery authority and its quota, pressure, cap, retry, and resurrection gates.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

The authenticated inbound and later-outbound absence are bounded signals. They do not kill, spawn, or send independently. The existing reaper remains kill authority, the drainer remains restart authority, and the router remains message-handling authority.

## 4b. Judgment-point check

No new static heuristic resolves competing semantic signals. Exact identity pairing, HMAC validity, and identifier syntax are enumerable integrity invariants. Thread-level settlement is intentionally conservative and feeds the existing recovery controller rather than claiming conversational judgment.

## 5. Interactions

- **Shadowing:** Threadline revalidation runs alongside the existing topic/job branches and cannot alter them.
- **Double-fire:** enqueue checks for an exact correlated outbound; drain checks again. A successful correlated send racing the reap therefore invalidates the queued replay before spawn.
- **Races:** a send after the second check but before cold spawn remains a narrow at-least-once boundary shared by distributed delivery systems. Stable per-thread queue keys, cold-spawn selection, and the router's normal conversation ownership reduce concurrent duplication.
- **Restart boundary:** ordinary reply claims are process-local, so a server restart after claim acquisition but before reply settlement reopens that same at-least-once window. Only the delivery-succeeded/outbox-append-failed edge is persisted as a durable failure claim, because it has positive evidence that replay risks a duplicate.
- **Feedback loops:** a failed spawn uses the existing bounded exponential backoff and resurrection cap; it does not recursively enqueue.

## 6. External surfaces

Other agents gain continuity: a reply that previously vanished can arrive after local pressure clears. Persistent state gains two non-secret identifiers in `resume-queue.json`; message bodies remain only in the existing canonical inbox. No operator action, new API, URL, Telegram flow, or external protocol is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local BY DESIGN:** quota reaping, the killed tmux worker, canonical inbox/outbox, and resume queue are truths of the machine that owned that warm session. Relay ownership and routing remain unchanged, so another machine does not independently redrive the same local worker. The feature emits no user-facing notice, creates no URL, and holds no topic-transfer state. Queue state expires or settles locally rather than following a Telegram topic.

## 8. Rollback cost

Hot-fix revert and patch release. Old binaries ignore the optional queue fields; no migration or agent-state repair is required. Existing queued Threadline entries would age out under the normal TTL after rollback.

## Conclusion

The design closes the discovered custody gap by reusing the one durable recovery controller, authenticating the recovery source, preserving all existing gates, and revalidating settlement at drain time. Focused unit, integration, and E2E tests cover integrity, production wiring, quota-reap persistence, and one redrive. Clear to ship after independent concurrence and the full push gate.

## Second-pass review

**Reviewer:** independent reviewer agent  
**Independent read of the artifact:** concur

Concur with the review after two iterations added exact durable reply correlation, same-thread HMAC validation, a shared atomic send/redrive claim, structural omission rejection, and a durable append-failure claim that survives server restart.

## Evidence pointers

- `tests/unit/threadline-reap-recovery.test.ts`
- `tests/integration/threadline-reap-recovery-wiring.test.ts`
- `tests/e2e/threadline-reap-mid-processing.test.ts`

## Class-Closure Declaration (display-only mirror)

This modifies a self-triggered recovery path. The control-loop edge is quota reap → one stable per-thread queue entry → one router redrive. The steady-state bound is one open entry per thread with the existing queue TTL, retry ceiling, resurrection cap, and pressure/quota gates. The settling brake is an authenticated outbound whose `inReplyTo` exactly names the queued inbound, rechecked immediately before redrive.

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `guard`
- **`guardEvidence`** — `{ enforcementType: ratchet, citation: tests/e2e/threadline-reap-mid-processing.test.ts, howCaught: a quota-reaped warm Threadline worker must leave one exact durable recovery entry and produce exactly one redrive after pressure clears; tests/unit/self-action-convergence.test.ts ratchets the bounded-controller declaration }`
- **`gap`** — not applicable
