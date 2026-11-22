---
approved: true
approved-by: "echo; agent approval after reading convergence report, independent source/artifact concurrence, and explicit root integration/deployment disposition of all seven possible conformance flags; complete suite and physical rollout remain pending"
title: A message reaches the exact session selected on another machine, even just after it starts
slug: relay-asof-holder-skew
tier: 2
author: echo (instar-dev agent)
eli16-overview: docs/specs/relay-asof-holder-skew.eli16.md
tracked: post-mortem N73 (topic 145840), fb-a18726bc-742, fb-6f7bddcd-1be
parent-spec: docs/specs/messages-reach-renamed-sessions.md
parent-principle: An Instar Agent Is Always a Multi-Machine Entity
review-convergence: "2026-11-21T23:55:40.817Z"
review-iterations: 7
review-completed-at: "2026-11-21T23:55:40.817Z"
review-report: "docs/specs/reports/relay-asof-holder-skew-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
cross-model-review-reason: "Independent Codex processes; same family as author. Real conformance flags dispositioned by root. Carrier-only gate correction uses actual generated registry records. Complete suite and physical rollout pending."
single-run-completable: true
frontloaded-decisions: 8
---

# Messages reach the exact receiving session

Rendered complete overview: https://echo-studio.dawn-tunnel.dev/docs/721c80e1-7375-4e61-b6ec-ba9728ce5698 (publisher verified HTTP 200 and document read-back; no approval message sent).

## Problem

On 21 November 2026 the Mama PC's conversation 144319 session started at 20:22:23Z. Studio messages written at 20:24–20:29Z were refused as `role-respawned-after-message`. The receiver computed `arrival − senderMeasuredAge − 2W`, where W is the relay signature's five-minute clock window. The extra subtraction rejected holders during their first ten minutes. Refusals were terminal and reported a code.

The original arithmetic proposal added ten minutes to holder acceptance. The independent audit found that it admitted genuine post-send replacements. Removing that addition alone still cannot prove the intended session: `arrival − age` includes transit, and signature skew does not independently bound transit because clock offset can cancel delay. This repair instead binds the exact generation observed before message creation.

## Design

### Signed generation before creation

With the sender-only live flag `multiMachine.messageSessionGeneration.enabled` true, before assigning `message.createdAt`, a named same-agent cross-machine send asks the intended peer's canonical registry addresses `POST /api/messages/session-generation {target}`. Existing machine-auth middleware verifies the signature and consumes nonce/sequence state. The endpoint additionally calls the canonical `isMachineActive` predicate so a merged registry with `status: active` and `revokedAt` still rejects that revoked caller. No Bearer token or new key is involved.

The receiver resolves a unique running holder using its actual session records and standing-down exclusions, without a cross-clock cutoff. It returns `observation: {target, sessionId: string | null, observedAt: number}`, plus an existing signed relay ACK bound to its own machine and the request nonce. Its signed `messageId` is `session-generation-v1:` plus SHA-256 of the JSON array `[target, sessionId, observedAt]`. This digest is deliberate: `signRelayAnswer` signs only its named fields and would not cover arbitrary extra properties. The digest binds every observation field and separates this proof from ordinary message ACKs.

The sender verifies the registered peer public key, target, observation digest and fresh request nonce. Replaying a valid response for another request, changing its target, generation or time, or substituting another peer fails. The signed observation time is evidence, not a cross-clock eligibility test. Registered HTTP/HTTPS ropes are tried within one five-second total budget, including per-peer admission wait. One sender admits one preflight/send at a time per peer; expired waiters become explicit recorded failures. Each remaining rope receives a share of remaining time so a hung address leaves a chance for alternatives. Unsigned statuses, redirects and unverifiable bodies do not identify the peer and move to the next registered address with a fresh nonce. Redirects are never followed. A verified generation observation, including signed no-holder, settles the check. Proof response bytes are bounded to 4 KiB before JSON parsing; the target/id limits, nonce, digest, time, machine id and Ed25519 signature fit that envelope. Signed responses make LAN HTTP usable without releasing credentials or trusting an unsigned body.

New senders strip caller-supplied generation fields and write `to.sessionGenerationRequired: true` and, when proved, `to.sessionId`. Both are inside `AgentMessage`, already included in full in `signedPayloadOf`; envelope signature verification therefore covers them. Creation follows the observation, so transit after creation cannot change the intended generation.

### Receiver and injection boundary

The receiver verifies the envelope before reading its binding. A bound message resolves its role and requires the exact signed session id. A different id is `target-session-generation-changed`. A required but missing id is `target-session-generation-unavailable`. No resolver means no typing for a bound/required message.

The selected session pin is persisted before typing; a failed write returns without typing. `MessageDelivery` checks that same logical generation synchronously after its final safety await and immediately before synchronous injection. Production supplies the check from actual running-session records. A same-name replacement during pin persistence or safety inspection therefore receives no text.

The existing physical tmux boundary remains: this fences Instar's recorded logical incarnations. It does not claim to authenticate an operator who externally replaces tmux state while leaving Instar's session records false.

### Bounded waiting and crash recovery

Known roles without holders and legacy too-new-holder refusals enter the existing Layer-2 lane. A bound id that differs from the current generation, or a required id that is absent, is conclusive and fails immediately. Unknown names, ambiguity, ended jobs, a topic placed elsewhere and resolver exceptions keep their previous terminal behavior.

An unresolved wait is `received` with `holderPending: true` and `deliveryPending: false`, persisted in one write. The phase is intentional downgrade safety: an old retry manager does not type an unpinned `received` message by name. New code explicitly retries that state. Once resolution succeeds, the pin write clears `holderPending` and arms `deliveryPending` with `typingStartedAt`. An exclusive in-memory active-attempt registration is released in `finally` after final persistence. Recovery skips only an attempt actually executing now, including an unpinned inbox snapshot. Under the exclusive claim the router rereads the current store record; a terminal or absent record cannot be resurrected. A prior process or a completed attempt whose final write failed becomes outcome unknown, tells the sender and is never retyped. A busy-session safety refusal proves that injection did not begin, clears the uncertainty marker and remains pinned in `queued`. A physical send returning false or throwing may already have pasted chunks or pressed Enter; it returns typed `outcomeUnknown: true`, retains typing evidence, fails once with a may-have-arrived notice and never automatically retries.

The new durable recipient lane reuses the existing ten-attempt ceiling, 30-second base interval and derived five-minute work window. Its failed-attempt interval grows exponentially and cannot outlive that window or the message TTL; it may therefore stop before ten attempts. The notice reports the actual retry count. Generic old nonrecipient retry records retain their existing policy. Its first-attempt time, count and last-attempt time are persisted under the same exclusive claim before resolution or typing, so restarting cannot reset its budget or cadence. Direct busy-session waits receive the same durable lane state. Missing redelivery wiring never falls back to typing by name. A terminal `MessageDelivery` result is honored immediately. Repeated holder refusals update attempts/detail without growing transitions each pass. The self-action registry exercises the same pure decision across reconstruction.

Missing pre-send proof cannot be invented after creation, and a replacement is not expected to revert to its predecessor. Those cases settle immediate refusals. A genuinely eligible old generation whose record was temporarily unavailable can become visible and receive its message. Final failure uses the existing local notifier or signed delivery-notice back to the sender's machine.

### Evidence and agent awareness

Each refusal appends one bounded JSONL audit row with message id, target, reason, reference time, holder start, origin machine, attempt and outcome. An awaited serialized asynchronous writer rotates it at 5 MiB with one retained predecessor; directory initialization is cached and write-error warnings are coalesced until recovery. It never blocks the event loop with synchronous audit IO and is never read to grant delivery. Counts describe retained observations, not an all-time census. Count distinct message ids for incidents and rows for attempts.

The existing automatically installed awareness entry explains generation binding, waiting and notices to new and existing agents. The endpoint is same-agent machine plumbing under the existing messaging surface. The sender flag is absent/off on both new and existing configurations, so no installed-file migration is needed. The normal feature ladder, pool capability status, coherence-exclusion registry and automatically installed awareness entry record the rollout and its live getter.

## Compatibility and rollback

- Updated receiver code is always ready to answer preflight and verify signed generation bindings. Sender binding ships off everywhere, including the development agent; root enables a sender only after receiving peer support is proved.
- An enabled new sender that reaches an old receiver obtains no proof and records an explicit origin failure without transmitting the payload. With the sender flag off, previous delivery works unchanged. This is a staged rollout, not mixed-version generation compatibility.
- An old sender has no generation fields. A new receiver retains its old `arrival − age − 2W` reference. This is an explicit mixed-version limitation, not proof of bounded transit.
- On receiver downgrade, unresolved waits remain `received`; old code does not inject them and its normal TTL sweep eventually issues the failure. Pinned `queued` envelopes retain their original id check. The old-code behavior is exercised as a separate rollback proof.
- Live rollback turns the sender flag off for new sends without restarting; it does not remove verification from already-bound received work. Code downgrade retains the received uncertainty/waiting states that old recovery/TTL paths handle without an unsafe by-name retry. No data migration is required; audit files are inert.

## Decision points touched

| Decision | Classification and basis |
|---|---|
| Accept generation proof | invariant; basis: irreversible-consequence; evidence: accepting an unverified or substituted recipient could type private text into the wrong session |
| Accept bound holder | invariant; basis: irreversible-consequence; evidence: text already injected into a replacement session cannot be untyped |
| Holder refusal waits | invariant; basis: enumerable-domain; evidence: the closed resolver union distinguishes holder evidence from unknown role, ambiguity, foreign placement and ended job |
| Retry cadence/cap | judgment-candidate; finite work and no automatic uncertain retype are floors. Root accepted the inherited initial resource policy and its availability cost; it is not an externally proved timing theorem. Durable state preserves the chosen allowance, and the rollout owner reviews capacity and measured outcomes before changing that policy. |
> Audit rows are observability only and never grant delivery; they add no independent block/allow decision.

## Signal vs authority

Reference: `docs/signal-vs-authority.md`. The proof supplies an identity fact. Role resolution, same-agent ownership, standing-down exclusions, signatures, TTL and the existing finite retry ceiling retain their roles. This adds no authority to kill sessions, grant trust, change leadership or message another agent. Missing information cannot be upgraded into a proved generation.

## Multi-machine posture

The preflight and final notices use established signed machine communication. Session records, receiving retry state and refusal audits are machine-local by design (`machine-local-justification: physical-credential-locality`): the physical session exists on its receiving machine. Failure outcomes return through the existing signed delivery-notice. No user-facing URL is generated by the feature. Existing topic-transfer/standing-down exclusions remain; pending state ends through its durable budget or TTL.

## Verification and current status

Unit checks cover proof tamper/replay/foreign peer/mixed-version behavior, exact resolver boundaries, known roles, pin-write failure, and replacements during awaited persistence or safety checks. Integration drives the actual HTTP machine-auth routes, signed responses, young-session delivery, delayed replacement, retry exhaustion and signed sender notice. E2E constructs a real AgentServer, StateManager, store, router, resolver and retry manager and proves authenticated send/read endpoints are alive and delegate to real pinned delivery. Only physical tmux is substituted. Source wiring assertions are supplemental.

Work remains in progress. Material audit findings have led to generation binding, exclusive state claims, bounded peer admission, asynchronous evidence writes, exact physical-outcome classification and staged rollout. Targeted checks are running on those boundaries. The complete `test:all` run must use the shared Local Verify slot and is not claimed before that result exists.

## Proportion

Tier 2: the new published machine-auth endpoint and durable uncertain-injection/retry state make the expanded repair security-sensitive despite a reversible code path. The arithmetic proposal failed its audit, requiring exact generation binding and a narrow machine-auth endpoint to support existing LAN-only pools without trusting unsigned responses. Additional review and tests are focused on that changed design and its crash boundaries. No new project or unrelated repair is included.


## Frontloaded Decisions

1. Bind exact receiver generation before message creation; a time estimate cannot establish it.
2. Reuse signed machine-auth and relay-answer primitives; support registered LAN HTTP and internet HTTPS without Bearer credentials.
3. Missing proof fails immediately at the origin before relay; a changed generation fails immediately at the receiver. Neither is late-bound to a replacement.
4. Keep legacy time behavior only for old senders/receivers and state the mixed-version limit plainly.
5. Store unresolved and uncertain work at `received` to prevent old versions from injecting it by name on downgrade.
6. Reuse the ten-attempt ceiling, 30-second base and derived five-minute work window; apply growing backoff and durable ownership/budget to recipient retries.
7. Treat physical send failures as uncertain terminal outcomes, preserving evidence and attempting one logical outcome notice through the best-effort notifier.
8. Ship the sender flag off; verify peer support before coordinated enablement, and roll back live by switching off new bound sends.

## Evidence at decision boundaries

| Symbol | Claimed state and independent corroboration | Unmeasurable result |
|---|---|---|
| Nonce-bound signed observation | The registered receiver observed one generation before creation; its pinned key signs the digest and actual local resolver supplies the id | No proof; a new message requires a generation and settles a refusal |
| Signed recipient id and real session record | This is the generation selected before creation; checked again against running records after the last await and before injection | No injection |
| Durable typing marker | An attempt was armed and actual injection may be unknown; actual active-attempt ownership is separate and released in `finally` | Unknown outcome, best-effort notice, no automatic retype |
| Physical send false or exception | Acknowledgement is missing, not proof that nothing happened; tests execute the side effect before returning/throwing | Explicit `outcomeUnknown`, best-effort notice, no automatic retype |

## Fixed behavioral limits

The preflight inherits the five-second peer session-read resource budget, including per-peer waiting. It is not evidence that a peer is dead or untrusted. All registered unique HTTP/HTTPS addresses may be tried within that budget; an unauthenticated answer never suppresses a later verified peer response. The 200-character target boundary matches the existing session-name API. Session ids are UUIDs and fit that envelope. The Layer-2 ten-attempt ceiling and 30-second base derive a five-minute work window; new durable recipient retries add increasing backoff and persist eligibility, with TTL as another outer bound. The audit retains one 5 MB rollover as existing delivery audit files do. These are resource budgets; none upgrades missing information into identity or delivery proof.

## Open questions

*(none)*


## Maturation plan

- **ladder:** multiMachine.messageSessionGeneration
- **dark-window:** sender switch is absent/off everywhere. The signed endpoint and receiver checks are always available. This avoids breaking delivery while the pool updates asynchronously.
- **test-agent-live:** isolated real-session operator drill is required before the repair owner enables development senders. Automated unit, authenticated HTTP integration and actual AgentServer lifecycle proofs are preflight evidence, not a completed physical-tmux live rung.
- **dev-agent-live:** pool repair owner verifies every intended receiving peer's signed endpoint, enables the designated development-agent sender live, exercises a young holder and a replaced holder, and observes one day with at least three delivered-bound samples and passing development harm metrics before broadening. Deliberate uncertainty/crash drills run in isolated test-agent logs. Development-canary errors remain harm; no silent relabeling or exclusion is implemented.
- **fleet:** recurring model review and independently agreed fleet-default change remain required. Owner-driven enablement after seven days and at least ten representative bound deliveries; registered metrics can hold or mark harmed when thresholds fail, but cannot switch the sender automatically; owner review remains required. Every intended receiver must already support the signed endpoint.
- **graduation criterion:** peer support proved, live drills match exact generation and no retype on uncertain outcome, and the owner approves the measurements. Rollback is immediate sender flag off; pending bound messages remain fenced.
- **evidence:** actual bound delivery emits `generation-delivered`, a prevented replacement emits `generation-changed`, unavailable proof emits `proof-unavailable`, and physical uncertainty emits `delivery-outcome-unknown` to the normal feature evidence log. The full recipient/pin remains on the envelope for investigation.

## Envelope-level scope

Once-only claims here concern one immutable message id. A caller that submits a distinct POST after losing the first response currently creates another envelope; stable caller submission ids and client adoption are separately tracked as fb-cf81617c-e91 under messaging reliability / takeover-ready pool. No automatic HTTP resend or content/time-window deduplication is introduced here. <!-- tracked: CMT-2183 -->

## Final review clarifications

Strict generation payloads use `/api/messages/relay-machine-generation-v1` with a machine-authenticated domain-tagged body `{protocol: "session-generation-v1", generationEnvelope}`. Authentication precedes unwrapping. An old relay endpoint rejects that wrapper even if an HTTP intermediary rewrites the path; unwrapping in transit invalidates the body signature. Initially accepted bound work is received with holderPending and no deliveryPending, so old recovery cannot type it before pinning. Every pin/arming write uses received plus typing evidence. A retry owner that wins newly accepted unarmed work executes it under the same claim. Expired admission waiters cannot remove a predecessor's lane. Broadcast machine `*` retains its previous protocol.

Confirmed pinned delivery is never regressed to queued merely because the watchdog later observes an unsafe process. Durable outcomes drive rollout evidence across initial delivery, retry and uncertain recovery. A failed final write returns the committed phase, never a transient in-memory delivered result. Audit fields are individually shortened for bounded rows, with full detail retained on the message; rotation accounts for the incoming row.

The preflight intentionally reports generic unavailable-generation rather than candidate sessions or moved-topic metadata. Off mode retains existing detailed resolver notices. This reduces enabled-mode diagnostic detail. Missing resolver is unavailable proof, never a proved absence. Existing generic queued unpinned legacy records retain inherited handling; new generation-bound messages always carry an exact id and production supplies the immediate checker. Increasing backoff may end checks before the five-minute window; this is an explicit availability tradeoff.

Terminal outcome persistence is required. Proactive sender notices are best-effort: inherited crashes before notification intent persistence or offline origins can prevent display. Separate repair fb-292ec9c9-9d3 (carrier CMT-2184) is owned by messaging reliability / takeover-ready pool, including crash-before-notice-persist and offline-origin acceptance tests. SenderNotifier undelivered counters at GET /messages/stats provide partial observability, not durable notice assurance.

Receiver-local expiry is persisted from accepted sender-measured age and remaining TTL; fresh messages do not expire because the machines have different wall clocks. Unavailable resolver returns503 rather than a signed no-holder observation. Initial callbacks only execute initial acceptance states; they cannot bypass a queued pin or its retry reservation. The timer never steals inert local sent records from their initial router executor. Strict payload redirects are manual and the strict route validates required generation fields before unwrapping.

The final physical boundary also enforces the shared five-minute retry work deadline after awaited safety and the exact generation lookup. Current-id lookup distinguishes an absent holder from an observed replacement, including the final synchronous fence. Resource and rollout numbers are consciously retained compatibility/operations policies, not facts proved by identity or liveness; the owner weighs measured capacity, isolated test-agent drill outcomes and development-agent evidence before changing them. MaturationLadder harm/hold states remain binding observation gates; deliberate drills are not mixed into development-canary logs.

## Review approval basis

Root integration/deployment review explicitly approved this Tier2 design and commit candidate after examining final source, actual conformance JSON, old-code rollback and AgentServer tests. The seven possible flags are dispositioned as resource-policy availability costs, real maturation harm/hold gates plus minimum exposure floors, owner-directed first-rollout sequencing, separately tracked best-effort notices, development-role selection and admitted generic diagnostic reduction. Read durable message status and pool/ownership state for detailed triage. This is source/side-effects/deployment-plan approval; complete suite and physical live rollout remain outstanding.

## Frozen Foundation Carriers

These are real registry records generated through refresh-carrier-ledger.mjs, linking the existing feedback obligations to offline-checkable text. Root assigned the named pool owner; this is not an acknowledgement by another agent and does not claim the foundation is built. The foundation work remains outstanding under the program pause.

> **CMT-2183** — "Messaging reliability / takeover-ready pool owns fb-cf81617c-e91: add a stable client submission id before preflight, atomically map it to one immutable envelope, and have retrying clients reuse it. Prove lost send response followed by resubmission produces one message and one injection. N73 covers one immutable envelope only."

> **CMT-2184** — "Messaging reliability / takeover-ready pool owns fb-292ec9c9-9d3: atomically persist terminal notice intent with delivery outcome; recover after crash before notice persistence and while origin is offline; never retype payload. Prove one logical outcome-notice obligation after restart. Proactive notice display remains best-effort until fixed."

The notice foundation remains separately tracked. <!-- tracked: CMT-2184 -->
