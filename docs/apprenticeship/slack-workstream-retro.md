# Slack workstream retrospective and WS5 scope

Date: 2026-07-19  
Apprenticeship arc: WS3–WS4  
Evidence: live demo-workspace smoke, feedback entries `fb-b1010093-9db` and `fb-d54eb6d4-8d2`, PR #1518

Status: retrospective evidence is settled; WS5 is scoped but not authorized or implemented.

## Outcome

WS3 and WS4 moved the demo Slack integration from credentials-on-disk to a verified, source-bound conversation path. The final live state proved a distinct `instar-codey-demo` app identity, complete required scopes, explicit demo-channel membership, Socket Mode connectivity, authenticated inbound receipt, observe-only permission decisions, exactly-once ingestion, and thread-session routing. PR #1518 then closed the missing final leg: a spawned session can reply to its originating Slack thread without receiving raw channel or thread authority.

The workstream did not flip the adapter from observe-only to responding. That is the next authority rung and remains an operator decision.

## What was built and proved

### WS3 — provision and observe

- Provisioned a dedicated demo-workspace Slack app and bot for Instar-codey, distinct from Echo's identity.
- Established the owner-identity administration path, scope matrix, reinstall requirement, channel membership checks, and Socket Mode preflight in the canonical reprovision runbook.
- Configured the adapter in observe-only mode with a bounded cast and verified authenticated principal resolution.
- Proved inbound events after subscription repair: one directed root and its thread replies arrived exactly once, produced truthful observe-only permission decisions, and routed to the expected channel/thread session key.
- Proved outbound transport and delivery-id replay suppression without granting the adapter response authority.

### WS4 — source-bound reply relay

- Added a provider-neutral Slack reply helper for spawned Codex, Claude, and Gemini sessions.
- Added `POST /slack/session-reply`, accepting only `conversationId` and `text`. The server resolves channel and thread from the bind-gated local conversation registry; the caller cannot select or override a destination.
- Refused missing/incorrect bindings, caller-supplied destinations or metadata, malformed conversation records, and replicated or foreign-origin targets.
- Reused the existing Slack tone, idempotency, and send path rather than creating a parallel delivery authority.
- Added SHA-provenance installation and migration: known shipped helpers may be atomically replaced; customized files are preserved and receive a `.new` candidate; symlinks and unreadable evidence fail closed.
- Added route, installer, prompt-census, migration, thread-routing, and full CI coverage. PR #1518 merged after exact-head peer approval and green unit, build, integration, and E2E gates.

## Defects surfaced and attribution

| Finding | Surfaced by | Origin / result |
|---|---|---|
| The delivered Slack credentials belonged to Echo's existing app, which would have made two agents compete for one Socket Mode identity. | Instar-codey | Provisioning handoff error; connection was contained and cleaned up, and a distinct app identity became a hard precondition. |
| An operator click-list was handed back for work the agent could perform through an owned provisioning identity. | Justin's correction | Mentor-side process defect; the owner-identity path became explicit, and later shared machinery added an owned-identities self-unblock source plus an advisory task-substitution signal. |
| A manifest update used replace semantics and unintentionally erased the app's event subscriptions. | Codey's zero-receipt evidence plus Echo's app inspection | Mentor-side provisioning defect; subscriptions were restored, and the runbook now requires export, additive modification, reinstall, and full live diff/read-back. |
| Socket Mode connected and adapter self-verification passed while no app events were delivered. | Joint live smoke | Diagnosed through Codey's zero-receipt evidence and Echo's app inspection; event-subscription state is now a separate gate, because transport health cannot stand in for subscription health. |
| Thread routing succeeded, but spawned sessions had no installed Slack reply helper and could not answer the source thread. | Instar-codey live smoke | Framework distribution gap; filed as `fb-d54eb6d4-8d2` and fixed by PR #1518's source-bound relay. |

Attribution matters here because the apprenticeship evidence is about the system, not scorekeeping: Codey caught the identity collision and missing reply surface; Echo named and repaired the two mentor-side errors. Each correction became a durable contract rather than a conversational promise.

## Durable lessons

### Replace-semantics APIs require export → additive change → full diff

A manifest update is not a patch unless the API contract explicitly says so. The safe sequence is:

1. Export the current manifest or configuration.
2. Add the intended fields to the complete representation.
3. Submit the complete representation.
4. Reinstall when grants or tokens are affected.
5. Diff every safety-relevant field and verify live token scopes, event subscriptions, and membership.

Checking only the field being added would have missed the subscription wipe.

### Provision through the verified owner identity

An agent-created workspace owner or service identity is part of the agent's usable infrastructure while its credential pointer remains valid. Before escalating an app-administration step to the operator, the agent should consult its owned-identity registry and exercise the verified owner path. This does not weaken human-reserved boundaries such as payments, legal assent, CAPTCHA, or the enforcement flip below.

### Socket Mode is not event subscriptions

A successful WebSocket handshake proves transport reachability only. It does not prove that the app is subscribed to `app_mention` or message events, that Slack accepted the subscription set, or that envelopes reach the adapter. Live readiness therefore needs independent evidence for identity, scopes, membership, Socket Mode, event subscriptions, and actual inbound envelopes.

### Attestation consumers must fail closed

`distinctIdentityVerified` was deliberately consumed as an admission fact, not inferred from nearby fields. When a credential refresh omitted the attestation, the runner refused before mutating config or vault state. That refusal was correct even though the omission was accidental. Producers must preserve or reissue attestations; consumers must never reconstruct them from plausibility.

### Authority must stay source-bound

A spawned session needs the ability to answer its conversation, not a general Slack-addressing capability. Passing an opaque conversation id plus a session binding lets the server resolve the destination from verified source evidence. It also makes cross-machine behavior honest: the machine without the local-origin binding refuses instead of posting from ambiguous replicated state.

## WS5 forward scope — demo-channel responding rung

### Goal

Move the existing demo adapter from observing authorized demo-channel traffic to producing real replies in the same demo conversation. This is the first live-user-channel proof toward the AI-employee goal: an authenticated human can direct the agent in Slack and receive a useful, thread-correct response through the normal session lifecycle.

This section is a scope stub, not authorization to build or enable the increment.

### Preconditions

- PR #1518's source-bound relay is installed and migration readiness reports packaged-identical executable bytes.
- The distinct Codey app identity, required bot scopes, event subscriptions, Socket Mode connection, and demo-channel membership are freshly verified.
- Authenticated inbound, exactly-once ingestion, principal resolution, and thread-session routing remain green on a disposable canary.
- The responding cast and demo channels are explicitly bounded; no live operator or production channel is included.
- Outbound tone review, delivery-id idempotency, source binding, one-voice ownership, and off-authority refusal are enabled and observable.
- A deterministic rollback exists: return enforcement to observe-only without deleting inbound evidence or conversation history.
- The operator has reviewed the evidence and explicitly authorized the enforcement transition.

### Authority boundary: observe → respond

Changing `enforced:false` observation into real delivery grants the adapter external speaking authority. Models, sentinels, smoke success, or mentor approval may produce readiness evidence, but none may flip that authority. The transition must remain a named, audited operator action with the exact app, workspace, channel/cast boundary, and rollback posture shown at the decision surface.

The implementation must not hide the flip inside restart, migration, configuration normalization, or a successful test. Missing, stale, unreadable, or conflicting evidence holds the adapter in observe-only mode.

### Required test matrix

| Cell | Required assertion |
|---|---|
| Operator authority | Without an explicit valid operator grant, respond mode cannot be enabled; an expired/revoked grant returns the adapter to observe-only. |
| Authenticated directed root | One authorized human mention produces exactly one admitted session and exactly one source-bound response in the intended location. |
| Directed thread continuation | A directed reply in the same thread reaches the same thread routing key and produces exactly one in-thread response, never a channel-root fallback. |
| Ambient traffic | Undirected messages follow the reviewed ambient policy and do not cause accidental speech. |
| Unauthorized principal | A sender outside the responding cast receives no autonomous response; the refusal is observable without leaking sensitive policy detail. |
| Caller authority | Spawned sessions cannot supply channel, thread, system metadata, or a foreign conversation id. |
| Idempotency | Replaying one delivery id produces no duplicate Slack message; ambiguous transport outcomes are reconciled before redrive. |
| Session recovery | Restart/respawn/compaction preserves the source binding and response contract without repeating a committed effect. |
| Cross-machine owner-dark | A machine lacking the local-origin conversation/adapter authority refuses; durable custody remains visible and exactly one owning machine speaks after recovery. |
| One voice | Concurrent sessions or machines cannot both answer the same admitted event. |
| Tone and content gate | Real conversational output passes the existing semantic tone authority; brittle detectors remain signals, not blocking semantic judges. |
| Enforcement rollback | Operator disable takes effect immediately and survives restart; open work cannot re-enable responding. |
| Migration parity | Fresh init, update migration, and recovery install the same helper bytes and render the same destination-free prompt contract. |
| Cleanup | Canary messages, sessions, grants, and temporary fixtures are removed or returned to their pre-test state with read-back evidence. |

### Acceptance evidence for an operator decision

The eventual WS5 proposal should present the matrix results, exact app/workspace/channel identity, current grant state, known gaps, rollback control, and a short ELI16 description of what enabling response authority changes. A green matrix means the system is ready up to the door; it never opens the door itself.
