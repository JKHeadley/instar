---
title: "Memory privacy: another agent gets a place of its own instead of a refusal"
slug: "memory-privacy-agent-places"
author: "echo"
parent-principle: "Know Your Principal"
parent-spec: "docs/specs/memory-privacy.md"
eli16-overview: "memory-privacy-agent-places.eli16.md"
status: "draft"
review-convergence: "2026-11-08T21:38:53.677Z"
review-iterations: 9
review-completed-at: "2026-11-08T21:38:53.677Z"
review-report: "docs/specs/reports/memory-privacy-agent-places-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: "Echo (agent), standing spec-approval grant, 2026-11-08 14:58 PST"
approval-decisions: "Decision 4 linkedPeerReplies = deliver (default). Machine-local posture for peer place folders and the per-machine refuseAgentSessions switch ratified by Echo (agent) under the standing grant, not by Justin. iOS line approved as written."
---

## Problem statement

`docs/specs/memory-privacy.md` section 3 refuses every inbound agent-to-agent (Threadline / A2A) session on a multi-person agent with memory privacy on: "Trust levels limit what a peer may do, not what data its session can see, so a `verified` peer given owner reach could ask for a person's fact and pass it on, and scoped sessions have no MCP to reply with. Stated cost." The refusal is `refuseSpawn` in `SpawnRequestManager` (wired in `src/commands/server.ts` where `spawnManager` is built, checked at `SpawnRequestManager.ts` `#evaluateGuarded`).

The app tells the owner this when they turn privacy on: "Agents can't start conversations with this one." Justin, topic 134088, 2026-11-08: "That seems like an unnecessary hobbling of the agent." The refusal was a stated cost, not a goal.

Both reasons for it can be fixed with machinery that exists:

1. **Owner reach.** A2A runs on the headless lane, which is `system`. Fix: run it in a scoped place whose audience is the peer agent, like a Slack channel.
2. **No way to reply.** A scoped session runs with `--strict-mcp-config` and no servers, so it has no `threadline_send`. Fix: a reply script and a session-bound route, as `app-reply.sh` is for app conversations.

Mapping every path by which peer text reaches a session (section 3) also found that the refusal never covered several of them. On a multi-person agent with privacy on, **today**, pipe mode and the listener inbox run peer messages with owner reach, live inject and reply waiters take any sender on a thread id, and reap recovery replays the thread owner's identity rather than the sender's. This spec closes those regardless of the new default.

## Goal

On a multi-person agent with memory privacy on, an inbound A2A conversation is accepted and runs in a place of its own:

- audience = that peer agent, keyed by its authenticated fingerprint;
- memory scoped to that place only: never a person's private facts, never owner reach, never another place's memory;
- a working reply path from the scoped session back to that peer and no one else;
- the peer's trust level still limits what it may do, exactly as today;
- the same rules as every other place: the per-message audience check, resume dropped on audience change, every respawn recomputes from the place.

## Design

### 1. The place and the peer's identity

The place key is `agent:<fingerprint>`, where the fingerprint is the sender's **authenticated** fingerprint, taken per entry point:

| Entry | Identity used | Never |
|---|---|---|
| Relay (`handleGatePassedRelayMessage`) | `msg.from`, the relay-authenticated sender, the key `AgentTrustManager` and `InboundMessageGate` already use. Accepted when the gate passed the message and `decision.reason !== 'probe'` | `senderName` |
| Local route (`POST /messages/relay-agent`) | `provenSenderFp`, which exists only when the signed envelope verified in enforcing mode | `senderRegistryFp`, `resolvePeerFingerprintByName` (name lookups) |
| Direct HTTP (`POST /threadline/messages/receive`) | `req.threadlineVerifiedFingerprint` | the body's `from` |
| Reap recovery | a ThreadLog row's sender fingerprint **only when the row carries the new `senderAuthenticated: true` flag** (section 3) | the row's `peerFingerprint` without that flag |

Each entry passes it to the router as a new option, `memoryPeerFingerprint`. The router writes it to the thread (below) and puts it on the spawn request as `SpawnRequest.memoryPeer`. Nothing derives it from `message.from.agent`, which is a name on the local route and body-asserted on direct HTTP. It is never taken from a peer-asserted alias, and there is no canonical-identity merging: the one fingerprint authenticates the sender, keys the place, owns the thread, and is the reply destination. A peer with several keys gets one place per key, which is the strict direction.

**Stated dependency:** local-envelope signing is dev-gated (`localEnvelopeSignature.ts`) and off or dry-run on the fleet, so `provenSenderFp` is absent there. On a fleet agent that is multi-person with privacy on, same-machine local-route peers are therefore still refused until signing is enforced. Relay peers are accepted.

**The identity is no stronger than the trust system's.** A relay able to impersonate peer A to the trust gate could reach A's place and get only what was said with A, never a person's or the owner's memory.

**Admission truth table** (multi-person = `isMultiPersonAgent()`: privacy on and more than one person):

| Multi-person | Authenticated fp | Explicit trust grant | `refuseAgentSessions` | Sandbox + claude-code | Result |
|---|---|---|---|---|---|
| no | any | any | any | any | today's behaviour, byte-identical |
| yes | no | any | any | any | refused, today's reason |
| yes | yes | no | any | any | refused, today's reason |
| yes | yes | yes | true | any | refused, today's reason |
| yes | yes | yes | false/absent | no | refused (`MemoryPrivacyUnavailableError`, as every scoped spawn) |
| yes | yes | yes | false/absent | yes | accepted into `agent:<fp>` |

**Explicit trust grant** means the peer's `AgentTrustManager` profile has `source` `user-granted`, `paired-machine-granted` or `mutual-verified`, at level `verified` or above. A `setup-default` profile never qualifies, whatever its level. This matters on the fleet: the relay unknown-sender check is dev-gated, and outside enforcing mode a first-contact plaintext sender is passed as `verified` by `legacyDeliver` (`relayUnknownSenderTrust.ts`), and new profiles are created `verified`. Without this column anyone who makes a key could open places, fill the place slots and spend the operator's subscription. Today's refusal blocks that, and so does this rule.

**The same check before every delivery, not only at spawn.** One function, `admitPeerDelivery(senderFp)`, evaluates this table with live trust and live config. It runs before every delivery of peer text into a place: spawn, launch, live inject, injecting a second thread into a live place session, and the drain. If it refuses while that peer's place session is live (the switch was turned on, or the grant was revoked), the message is not delivered and the live place session is ended. A conversation therefore does not survive a refusal past the peer's next message. The multi-person flip is sticky (parent spec), so an agent never returns to single-person at runtime. Turning privacy off takes effect at restart (section 4). Turning the switch on, or revoking a peer's grant, also ends that peer's live place session within one registry tick (60 seconds), since the tick re-runs `admitPeerDelivery` for every live place. Until then the session can finish the turn it is on.

`refuseSpawn` today takes no arguments. It is changed to take the request, so it can see `memoryPeer`. The kill switch is read live from config on each call, never captured at boot.

**The place.** The spawn passes `memoryPlace: { kind: 'shared', placeKey: 'agent:<fp>' }`. With no `soleReaderId`, `resolveMemoryAudience` gives `{ kind: 'place', placeKey: 'agent:<fp>' }`. That reuses what a `place` audience has: a scope folder (`place-<sha256[:16]>`), the sandbox settings, the `mps_` session token, the route guard, the hook gate, digest exclusion, and the profile-injection limit. No new audience kind.

**One place per fingerprint, not per thread.** As in a Slack channel, the memory belongs to the place, and the place's threads share it. A place exists only for a peer the owner granted trust to, or paired with (the grant column above). Place folders are kept like every other place folder (parent spec section 2): no expiry, and per machine.

### 2. The thread owns a fingerprint and an audience

`ThreadResumeEntry` (and the matching `Conversation` row) gains two fields:

- `peerFingerprint`: written only from `memoryPeerFingerprint` on inbound, or on an outbound `relay-send` from the recipient fingerprint **when the send addressed a fingerprint**: either a fingerprint given directly, or a nickname resolved through the owner-curated `nicknames.json` (`nicknameResolvedFp` in `relay-send`, which is owner authority). A send forwarded from a standby machine with `resolvedFp` counts too, because a standby forwards only a nickname result. A name resolved any other way (directory, known-agents, trust-profile name) leaves the thread unowned. So an owner session that writes to a peer by its nickname gets that peer's answer back through topic linkage and its waiter, as today. It is write-once: the `ThreadResumeEntry` ↔ `Conversation` bridge carries both new fields and refuses to overwrite an existing `peerFingerprint` (a check inside `mutateSync`), so a later save cannot re-own a thread. A delete (`mutateSync(threadId, () => null)`) is allowed. The stored-messages rule below keeps a deleted thread's id from being claimed again.
- `audienceKey`: the `audienceKey()` of the session that wrote the transcript, written at spawn and at resume.

On a multi-person agent:

- **Legacy adoption.** An entry from before this version whose `remoteAgent` is exactly the authenticated sender's fingerprint is owned by that sender. The relay path stored `message.from.agent`, which there is the fingerprint, so ongoing relay threads keep their ids across the update. `claimOwner` writes `peerFingerprint` on that first authenticated message. A `remoteAgent` holding a name never matches, because names and fingerprints are different shapes. Adoption carries over the thread id and nothing else. Legacy entries have no provenance: a direct-HTTP entry's `remoteAgent` was asserted in the body, and before this version live inject accepted any sender on a thread. So an adopted thread's resume is dropped (`audienceKey` is absent), and none of its stored history from before the claim is loaded (next bullets). A forged legacy entry therefore gives the adopter nothing but an id.
- An entry with **no** `peerFingerprint` that is not adopted (an entry written under a name, or one whose recorded peer differs) is **unowned**. It is never live-injected, never resumed, and never used by the reply route.
- **A thread id the sender does not own is never reused.** If the thread id has an unowned or foreign entry, or no entry but stored messages in `MessageStore` (entries expire, stored threads do not), the router gives the sender's message a new thread id and starts a fresh entry owned by the sender. The first sender never adopts an existing thread, and the old thread's history is never loaded into its prompt.
- **Replies on a moved thread.** When a message moves to a fresh thread id, the place session's reply goes out on that fresh id with `inReplyTo` set to the sender's original message id (the field `relay-send` already carries). A peer waiter keyed only on the old thread id is not resolved by it. The peer sees a reply on a new thread pointing at its message. This is today's behaviour for the router's anti-hijack isolation, and it now applies to a thread the sender does not own. It reaches ongoing conversations only when legacy adoption does not apply.
- **History.** `buildHistoryContext` for a placed spawn loads history only from a thread whose entry is owned by the sender, and only messages stored at or after the entry's `ownerClaimedAt`. `claimOwner` writes this timestamp alongside `peerFingerprint`, and only authenticated, ownership-checked messages enter the thread from then on. Everything else gets no history.
- **Order**, for each inbound message on a multi-person agent: (1) the authenticated sender is fixed; (2) `ThreadResumeMap.claimOwner(threadId, senderFp)` atomically claims ownership or reads it, inside one `ConversationStore.mutateSync`, and returns the owner. It reads `ConversationStore` directly, not `ThreadResumeMap.get`, which returns null when a session's transcript file is missing. A thread id with stored messages but no entry counts as already owned by nobody-claimable and returns no owner; (3) if the returned owner is not the sender, the message moves to a fresh thread id and step 2 runs again for it, so a lost race between two peers on one unused id reroutes the loser before anything else happens; (4) the entry is persisted with `peerFingerprint` by that claim, before any session is spawned or receives the message; (5) history is loaded only for owned threads; (6) inject, resume or spawn follows section 3.
- An entry whose `peerFingerprint` differs from the authenticated sender is **foreign**. It is treated like an unowned entry (next bullet): the sender's message moves to a new thread id. The session holding the foreign thread is not touched, so one peer cannot end or reach another's session. The router's current exemption from the thread-owner check for `trust.kind === 'verified'` does not apply on a multi-person agent.
- A resume happens only when the entry's `audienceKey` equals the new session's audience key. An absent value means drop. This replaces reliance on `MemoryPrivacy.audienceChanged` for A2A. `audienceChanged` is keyed per place, so after the first spawn in `agent:A` it would let a second thread's pre-update owner-reach transcript resume. That gap in the parent design also affects Slack places. It is filed as a separate finding (see Left behind) rather than widened here.

### 3. Every path that puts peer text into a session

On a multi-person agent:

| Path | Today, multi-person | With this spec |
|---|---|---|
| Cold spawn `spawnNewThread` → headless `spawnSession` | refused | place lane (section 4) |
| Resume `resumeThread` (`--resume entry.uuid`) | refused | place lane. The resume is kept only under the section 2 rule |
| Warm spawn `spawnWarmThread` | refused | place lane. On a multi-person agent `preferWarmSession` is forced false at the relay handler, so the warm pool never admits a peer there. The warm pool's TTL sweep and touches skip every `msg-place-` session |
| Drain `onDrainReady` | refused | the queue is keyed by `memoryPeer` when present, and the drain callback's synthetic request rebuilds `memoryPeer` from that key. Each item carries `memoryPeer` and `threadId`. A drain spawns one place per fingerprint and writes the resume entry. Mixed fingerprints are never merged into one prompt. That is enforced in `#buildSpawnPrompt`, where the drain merges queued messages today |
| **Pipe mode** (relay Phase 2a, `PipeSessionSpawner`): raw `claude -p`, no memory plan | **runs with owner reach** | skipped; falls through to the router |
| **Listener inbox** (relay Phase 2b): an owner-reach reader | **delivered** | skipped; falls through to the router |
| **Live inject** `tryInjectIntoLiveSession` | **any sender on the thread id** | only when the entry is owned by the sender and the live session's audience is `place:agent:<fp>`. Otherwise not delivered, and the router resumes or spawns |
| **Reply waiters** (`waitForReply`, relay and local route): resolved by thread id with the peer's text | **any sender** | the waiter records the recipient fingerprint when the send addressed one. It is resolved only when the authenticated sender equals it. A waiter with no recorded fingerprint is not resolved on a multi-person agent, and the message goes to the router as a new inbound message. Under `linkedPeerReplies: 'post-only'`, read live, no waiter is resolved on a multi-person agent. The reply goes to the topic as a post if the thread is topic-linked, and always to the peer's place. The waiting call ends at its own timeout as "no reply". The relay handler's name-based waiter fallback is deleted, because it is unreachable (waiters are keyed by thread id) |
| **Topic linkage** `tryRouteReplyToTopic` (paste into, or respawn, the topic that started the thread; or forward to the machine owning it) | **any sender** | sender must own the thread. Under `linkedPeerReplies: 'post-only'`, read live before local inject, topic respawn and the cross-machine forward, there is never session input. The topic's audience, computed now, must also be `owner` or `system`. Otherwise the reply is posted to the topic as a message only (no session input) and also goes to the peer's place. The cross-machine forward carries the authenticated sender, and the receiving machine applies the same check before any session input. An older receiving machine is the parent spec's rollout gap |
| Reap recovery `ThreadlineReapRecovery` | replays the row's `peerFingerprint`, which on the local route is the thread owner's `remoteAgent` | the ThreadLog row gains the sender fingerprint plus `senderAuthenticated`. Recovery skips unflagged rows on a multi-person agent, and replays flagged rows through the router with that fingerprint |
| Telegram bridge mirror, peer homebase relay, collaboration surfacer | post the peer's words to an operator topic; start no session | unchanged. Whoever reads the topic already reads it. The next session in that topic loads them as history. If it is an `owner` session, that is the same class as topic linkage, listed under "Not closed" |

`A2AGateway` is exported but never constructed.

**These fixes do not depend on the kill switch.** The pipe/listener skip and the owner, waiter and topic checks close live gaps, so they apply on every multi-person agent with privacy on, including one that sets `refuseAgentSessions: true`. The switch only chooses refuse vs place at admission.

**The flip and the lane are decided at spawn time.** At launch, the whole section 1 admission table is applied again, with current trust and configuration, not only at admission. A request admitted while the agent was single-person that launches after the flip goes into the place if it has an authenticated fingerprint and an explicit grant. Otherwise it is refused at launch, and the drain records it like any refusal. On the flip, every running peer-origin execution without a place is ended, using the same once-only flip handling as interactive sessions: A2A spawns (`triggeredBy` `spawn-request` or `spawn-request-drain`, headless or warm), every live pipe-mode session (`PipeSessionSpawner`'s active-session list), and the listener reader. The flip handling completes only after these are gone, and a message that arrives meanwhile waits behind it like any held inbound. Today `retireSessionsForAudienceChange` skips headless lanes, so a `msg-spawn-*` session would keep owner reach and `threadline_send` after the flip.

**Topic linkage is the one place where peer text still reaches owner reach.** Only an `owner`, `system` or `open` session can start a linked thread (an `mps_` token is refused on `relay-send`, and scoped sessions have no MCP). The sender check narrows today's exposure to the peer that session chose to write to. The `owner` and `system` sessions it reaches are unsandboxed, and peer text there is untrusted input that could ask them to read a person's folder. That is listed under "Not closed" and put to Echo for sign-off.

### 4. The place lane

A scoped boundary exists only on the interactive lane (`spawnInteractiveSession` → `planMemorySession`). On a multi-person agent every placed A2A spawn uses it:

- **Only on a multi-person agent.** Everything in this section applies only when `isMultiPersonAgent()` is true at launch. Otherwise A2A spawns exactly as today.
- **One live session per place.** A new `PlaceSessionRegistry` (not `WarmSessionPool`, which caps by evicting) maps fingerprint → the place's live session. A second thread from the same peer is injected into that peer's live place session, which then serves several threads. The reply route's `--thread` and 409 rule (section 5) handles that. Only one session per peer is ever live.
- **At the cap the registry refuses, and never evicts.** At most 3 places are live at once (`globalCap`, default 3, read from `config.threadline.placeSessions.globalCap`). A new place at the cap is refused back into the `SpawnRequestManager` queue with the existing session-limit reason, and the drain retries it. No live session, whoever's, is ended to make room. One peer cannot end another's session.
- **Idle end.** A place session is ended 10 minutes after its last delivered message (`config.threadline.placeSessions.idleMs`, default 600000). It is never ended while a reply is awaited or an inject is pending. Its own 60-second tick runs whenever the registry exists, independent of the warm-A2A flag. Placed sessions take the tmux name marker `msg-place-`. At boot every `msg-place-` session is ended, because the registry is in memory and those sessions' `mps_` tokens are revoked at boot by the parent spec's retirement.
- **Atomic reservation.** The registry checks and reserves in one synchronous step: a place counts as live from reservation, not from launch. Each registry record moves atomically from `reserved` to `running` when its session appears in the running list, and is removed when the launch fails or the session ends. Two different peers can therefore never both pass the global cap. The free-slot check counts running sessions plus the records still `reserved`. A running place is counted once, as a running session. Other lanes (jobs, people) do not reserve. A placed launch racing one of them can exceed the free-slot floor briefly, by that one in-flight launch, until the next check. That is stated, not closed.
- **Host capacity.** A placed spawn is admitted only when the agent's running sessions (all lanes, as `getActiveSessions` counts them) plus place records still `reserved` are below `maxSessions - 1`. No request priority bypasses this check. `#evaluateGuarded` lets `critical`/`high` past the session limit, but that does not apply to placed requests. So with `maxSessions` 5 and default caps, peers hold at most 3 slots, and one slot stays free except for the brief race with other lanes described below. Stated plainly: placed sessions count toward the `maxSessions` check that headless jobs use, so peers can take up to `min(3, maxSessions - 1)` slots that jobs would otherwise have. On an agent with `maxSessions` of 1, placed sessions are never admitted.
- **Admission kind.** `spawnInteractiveSession` gains an `admissionKind` option, today hardcoded `'operator'`. Placed sessions pass `'automatic'`. Under overload they wait and retry like other automatic work, and never take the host-wide recovery slot reserved for the operator.
- **Cooldown** and the in-flight check in `SpawnRequestManager` are keyed by `memoryPeer` when present.
- **Spawn lock.** `conversationRefOf` maps a `memoryPlace` whose key starts with `agent:` to the lock ref `peer-place:<fp>`. This check comes before its early `return null` for `memoryPlace`. The lock wrapper in `spawnInteractiveSession` passes `memoryPlace: options?.memoryPlace` to it, which it does not do today. `TeamConfinement.place()` also calls `conversationRefOf`. For an `agent:` input it now looks up `peer-place:<fp>`, finds no confined entry, and `refuseSpawn` has already returned false for any `memoryPlace`, so nothing changes there. App refs carry no prefix, so the namespace is distinct, so `spawnInteractiveSession` serialises two spawns for one peer. `applyConversationChange` (which assumes `telegram:` or `app:` refs) never receives an `agent:` ref.
- **Lane facts the spec states:** `--session-id` / `--resume` continuity works on the interactive lane. `opts.model` and `opts.maxDurationMinutes` from the request are not honoured there. The interactive defaults apply: the configured default model, and `defaultMaxDurationMinutes` (falling back to `FALLBACK_MAX_DURATION_MINUTES`). Required-ack treats the session as `interactive` (the spawn result carries `interactive: true`), so reminders reach it.
- **Turning privacy off** takes effect at restart, as for every scoped session (parent spec section 4). Boot's `retireBoundedSessionsWhenPrivacyOff` ends placed sessions with the others.
- Any framework other than claude-code, or no working sandbox, throws `MemoryPrivacyUnavailableError`, and the spawn manager turns it into a refusal. Nothing runs unprotected.

### 5. The reply path

**Script:** `.instar/scripts/threadline-reply.sh`. It is listed in `REPLY_SCRIPTS` (`wireMemoryPrivacy.ts`) so the sandbox's `allowRead` includes it. It takes text from stdin or arguments, and `--ack <ref>` (repeatable) with a summary. It posts with the session's own `INSTAR_AUTH_TOKEN` (an `mps_` token) to `http://localhost:$INSTAR_PORT`. It names no peer and no thread unless given `--thread <id>`.

**Route:** `POST /threadline/session-reply` with body `{ text?, threadId?, ackRefs?, summary? }`.

- It is added to `MEMORY_SESSION_ROUTES` (`limit: 'any'`, the handler binds the session) and to `REPLY_ROUTE`, so `memoryReplyChannel` marks the session as replied. `Rule` gains an optional `denyPlacePrefix`, checked before the `'any'` early return. The new route has `requirePlacePrefix: 'agent:'`, and `/team/proposals` and `/feedback` get `denyPlacePrefix: 'agent:'` (section 6).
- **Hook identity, a shipping prerequisite.** `POST /hooks/events` today records `SessionStart` for the request body's `sessionId` before it binds a scoped session to its own id (`routes.ts`, hook route). The parent spec requires a scoped session to speak only for itself, and a peer now drives a scoped session. This build fixes it: for a session token, every hook side effect uses `res.locals.memorySession.sessionId`, and the body's id is ignored. A test shows an `agent:A` token cannot create or change another session's hook state.
- **Session tokens only.** The agent token is refused (owner sessions use the MCP tool). The token's record must have a `placeKey` that starts with `agent:`, or the request gets a 403. The recipient is that fingerprint, and the body cannot name one.
- **Thread.** When `threadId` is given, the entry must be owned by that fingerprint, or the request gets a 403. When it is absent, the server looks up entries whose session name is this session's **and** whose `peerFingerprint` is the place's fingerprint. Exactly one must match. None or several gives a 409 asking for `--thread`.
- **Acks.** Each `ackRef` must belong to a pending required-ack row whose peer is the place's fingerprint. Any other ref is refused one by one. Accepted refs go to the same service method `POST /threadline/ack` uses. For a placed session, `requiredAckInstruction` and `requiredAckReminder` name `threadline-reply.sh --ack <ref> "<summary>"` instead of `threadline_ack`. The text is fixed, and only server ack refs go into it.
- **Send.** It goes through the same outbound function `relay-send` uses, with the same signing, outbound gates and relay or local route. The origin is the session's tmux name. It never calls `captureOriginOnSend`, so it cannot create a topic link. It calls `requiredAck.onSessionSendAccepted(<place fp>, threadId)` for the D5 close, keyed by fingerprint.
- **No files.** `files` are refused from a session token, the same accepted cost as `POST /app/session-reply`.

The grounded A2A prompt (`ThreadlineRouter.buildPrompt`) and the warm prompt template tell a placed session to reply with the script. `userTopicHint` is omitted for placed sessions, because it names an operator topic.

### 6. What a peer can and cannot reach in its place

| | Reachable? | Why |
|---|---|---|
| Its own place folder | Yes | the place's memory, written by its earlier sessions |
| Owner memory (`.instar/MEMORY.md`, `agent-memory`, `USER.md`) | No | sandbox `denyRead` on the agent home; hooks skip them for `place` |
| Shared-memory people's memory | No | it is owner scope |
| A person's private folder, another place's folder, another peer's place | No | outside `--allowedTools`, inside the sandbox's `$HOME` deny |
| Message logs, transcripts, backups, attachments | No | agent home and `$HOME` denied; no history routes on the allow-list |
| Threadline MCP | No | `--strict-mcp-config`, no servers |
| Server routes | the allow-list, **minus** `POST /team/proposals` and `POST /feedback`, plus its own reply route | see below |
| Profile injection | name and permissions only | parent spec section 6 |
| The internet | yes, as for every scoped session | parent spec's `allowedDomains`. It can carry out only what the session can read, which is its own place |

**Two routes are closed to peer places.** `MEMORY_SESSION_ROUTES` gains a per-rule exclusion by place-key prefix. `POST /team/proposals` would show the owner a grant or invite request worded by the peer, labelled "Someone in a shared conversation" (`teamRoutes.ts` `requesterOf`). That is a direct route for social-engineering the owner. `POST /feedback` would send text worded by the peer to the maintainers under this agent's name. Both are refused for `agent:` places.

**Trust does not widen reach.** `verified`, `trusted` and `autonomous` peers all land in the same place, with the same reach. Trust keeps gating what is accepted and done for that peer: who may open a thread, rate limits, the autonomy gate, operator confirmation and credential sharing. Owner reach for a peer would need an owner decision bound to that peer. That is not in this spec.

What the peer can learn **from its place session** is whatever the agent says in that place. A person's fact reaches it from there only if someone deliberately says it there, as in a Slack channel. The one exception is a thread an owner or system session started with that peer (section 3, listed under "Not closed").

### 7. Migration and default

Agents that already have memory privacy on start accepting agent conversations after the update, inside a walled place. That loosens availability. It does not loosen any person's memory. The release-notes fragment `upgrades/next/memory-privacy-agent-places.md` says so in "What to Tell Your User", so an owner who relied on the refusal hears about it.

**Default on.** `memoryPrivacy.refuseAgentSessions: true` brings back refusal at admission (the same `refuseSpawn` reason). `migrateConfig` does not write it, and a missing value reads as false.

Shipping:
- `src/templates/scripts/threadline-reply.sh`, plus a `ThreadlineReplyRelayInstaller` modelled on `AppReplyRelayInstaller` (it replaces an absent or known-shipped copy, keeps a customised copy beside it as `.new`, and keeps a prior-SHA list). It is wired into `PostUpdateMigrator.migrateScripts`, `init.ts`, `AgentServer` and `templates-drift-verifier`.
- An awareness line in `generateClaudeMd()` (`src/scaffold/templates.ts`) and in `migrateClaudeMd`, under a content sniff on `**Agents under memory privacy**`: "On an agent with several people and memory privacy on, another agent's conversation runs in a place of its own, with that place's memory only. Its session replies with threadline-reply.sh. `refuseAgentSessions: true` in memoryPrivacy turns agent conversations off."
- `GET /memory-privacy` gains `agentSessions: 'own-place' | 'refused' | 'owner-reach'`. The value is `owner-reach` when the agent is not multi-person, `refused` with the kill switch or when no sandbox is ready, and otherwise `own-place`. `refused` also covers a framework other than claude-code. The status uses the same predicate as admission (`admitPeerDelivery`'s capability part), so the app never advertises peer conversations the agent would refuse.

**Rollback:** `refuseAgentSessions: true` is the rollback to refusal. Turning privacy off is different: after restart it restores the pre-privacy behaviour, owner reach and all, as the parent spec describes. Place folders stay where they are and are not loaded. A version downgrade ends `mps_` tokens, as in the parent spec.

### 8. App and dashboard wording

The dashboard has no text for this. The iOS turn-on sheet (Studio app repo) chooses its line from `agentSessions`:

- `own-place`: "Other agents can still talk to it, in a conversation of their own that can't see anyone's private memory."
- `refused`: keep "Agents can't start conversations with this one."
- `owner-reach` (one person): no line. Nothing about other agents changes.
- field absent (older server): keep "Agents can't start conversations with this one."

### 9. Parent spec change

In `docs/specs/memory-privacy.md` section 3, the refusal bullet becomes: "On a multi-person agent, an inbound agent-to-agent conversation runs in a place of its own, keyed by the peer's authenticated fingerprint, with that place's memory only and a session-bound reply route (memory-privacy-agent-places.md). `memoryPrivacy.refuseAgentSessions: true` restores the refusal." The section 5 allow-list table gains the reply route and the two exclusions for peer places.

## Frontloaded Decisions

1. Default on, with `refuseAgentSessions: true` as the way back (brief; Echo's lean). This is published behaviour, so it is decided here.
2. One place per authenticated fingerprint, not per thread (brief: "a place of its own").
3. Pipe and listener are skipped on a multi-person agent, not scoped. They are latency shortcuts with no memory plan, and the router covers every message they would take.
4. Topic linkage and reply waiters reach `owner`/`system` sessions only from the peer the session wrote to, and that is listed as not closed (section 3). The stricter option is post-only on a multi-person agent: the reply is posted to the topic, and the waiting session never receives it automatically. Stated accurately: `post-only` stops the immediate delivery into the waiting session only. The posted reply is still a topic message, so a later session in that topic loads it as history, the same as the mirrors in section 3. It narrows timing and removes the automatic question-and-answer loop. It does not keep peer text out of owner-reach sessions altogether. Kept as automatic delivery, narrowed to the addressed peer and wrapped as untrusted. Echo signs off at approval and may choose post-only instead, which is one setting: `memoryPrivacy.linkedPeerReplies: 'deliver' | 'post-only'`. The default is `deliver`. It is read live, and under `post-only` the topic gets the post and the peer's place gets the reply.
5. One live session per place. At most 3 places live, and the cap refuses rather than evicts. Idle end at 10 minutes. One slot is left free, apart from a brief race with other lanes (section 4). Defaults carry over the warm pool's numbers and are configurable under `threadline.placeSessions`.
6. Admission needs an explicit trust grant (`user-granted`, `paired-machine-granted`, `mutual-verified`), never `setup-default`.
7. `/team/proposals` and `/feedback` are closed to peer places.
8. The iOS lines and the `agentSessions` field (section 8). Echo lands the app side.
9. Local-route peers stay refused until local signing is enforced (section 1). It is not worked around with a name lookup.

## Symbol vs state (P20)

| Detector | Symbol | State it stands for | Corroboration | Unmeasurable |
|---|---|---|---|---|
| Peer identity | the authenticated fingerprint per entry (section 1) | the agent that sent this message | relay connection auth, verified envelope signature, or verified request signature, which the trust gate relies on | absent → refused on a multi-person agent |
| Thread owner | `entry.peerFingerprint` | the agent this thread is with | written only from an authenticated fingerprint, never from a name | absent → unowned: no inject, resume or reply |
| Transcript audience | `entry.audienceKey` | who the transcript's loaded memory was for | written by the spawn that planned that audience | absent → resume dropped |
| Multi-person | `isMultiPersonAgent()` | more than one human can reach the agent | the parent spec's detection | the parent spec's rule: last value, first-ever error counts as multi-person |
| Session in the right place | `memoryAudience === place:agent:<fp>` | the session sees only that place | its settings file and `mps_` token record, from the same spawn | no record → not delivered, spawn fresh |
| Reply recipient | the token record's `placeKey` | the peer this session serves | the server-side token map, never request input | no record or a non-`agent:` key → 403 |

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| A2A admission: refuse vs place | invariant | basis: enumerable-domain; evidence: the section 1 truth table over five inputs, every row tested; fails closed on any missing input |
| Place key and thread owner | invariant | basis: irreversible-consequence; evidence: a name-keyed place or an adoptable thread lets one agent read or redirect another's conversation, a disclosure that cannot be undone |
| Reply recipient | invariant | basis: irreversible-consequence; evidence: a reply to the wrong peer cannot be recalled |
| Resume only on equal audience | invariant | basis: irreversible-consequence; evidence: a resumed transcript holds memory loaded for its earlier audience |
| Per-message check on inject, waiters, topic linkage | invariant | basis: irreversible-consequence; evidence: peer text into a wider-reach session is the leak this feature exists to prevent |
| Pipe/listener skipped | invariant | basis: enumerable-domain; evidence: two shortcut paths, neither with a memory plan |
| Peer-place route exclusions | invariant | basis: enumerable-domain; evidence: the allow-list has 17 rules; each was assigned for `agent:` places, and two reach the owner or maintainers |
| Place caps (1 per place, 3 live, 10 min idle, 1 slot free) | judgment-candidate | floor: the existing warm-pool numbers, configurable; arbiter: the operator via `config.threadline.placeSessions`. The free slot is a floor, not tunable down |
| Explicit trust grant required | invariant | basis: enumerable-domain; evidence: four trust sources. `setup-default` is what a stranger gets. `user-granted` comes from the owner or an owner-reach session (`threadline_trust`). `paired-machine-granted` and `mutual-verified` come from pairing. `TrustBootstrap` can also write `paired-machine-granted` from DNS, directory or invitation checks, but it is not wired today; if it is ever wired, this row must be revisited |

## Threat model

**Closed:**
- A peer at any trust level asks its place session for a person's private fact from another place, by asking, by naming a path, by asking it to search, or by asking it to call a route. The sandbox and file-tool allow-list block the read, the token is refused on every memory route, and no MCP is loaded.
- A peer reuses another peer's thread id to get its text into that peer's place, to resume its transcript, or to end its session (thread ownership, section 2).
- A peer's text reaches an owner-reach pipe, listener or headless session (section 3).
- An old owner-reach transcript is resumed into the place (`audienceKey`, section 2).
- A peer spoofs a name, or replays recovery under another identity (section 1, recovery flag).
- A peer place asks the owner for access or writes to maintainers as this agent (route exclusions).
- A peer fills the agent's session slots, or ends another peer's session to make room (one session per place, refuse at the cap, one slot free apart from a brief cross-lane race).
- A stranger mints a key and opens places (explicit-grant column).
- A peer sends on another peer's expired thread id to load its history (thread ids are never reused across owners; history only from owned threads).
- A pipe or listener session that was already running at the flip keeps owner reach (ended at the flip, section 3).

**Not closed, stated:**
- **Topic linkage and reply waiters** feed a peer's reply into the unsandboxed `owner`/`system` session that wrote to that peer. Prompt injection there could reach person folders. It is narrowed to the peer that session chose, and the text arrives wrapped as untrusted. This exists today on multi-person agents. Echo signs off on keeping it (decision 4).
- What the agent says in a peer's place belongs to that peer, as in a channel. Prompt injection inside the place reaches only that place's memory, and the open internet can carry only that.
- A relay able to impersonate a peer reaches that peer's place (section 1).
- **Talking an owner session into a grant.** A peer's text reaching an owner-reach session (topic linkage, waiters, mirrors) could persuade it to call `threadline_trust` and grant that peer, or another, `user-granted`. The grant only opens a place, never owner reach, so the result is admission, not a leak. It comes under the same sign-off.
- **Peer homebase relay and collaboration surfacer** post a peer's words into an operator topic, and the next `owner` session there reads them as history. This is the same class as topic linkage and comes under the same sign-off.
- **Same-machine agents** run as the same OS user and can read `memory-scopes/` directly (fb-79e7b408-ad2, parent spec). A place adds nothing against a co-located agent, so accepting local-route peers is not a privacy guarantee against them.

## Testing

- **Unit:**
  - the admission truth table, every row;
  - `refuseSpawn` reading the switch live;
  - the place key from each entry's authenticated fingerprint, and never from a name;
  - thread unowned, foreign and owned;
  - resume kept only on an equal `audienceKey`;
  - the guard: `session-reply` allowed only for `agent:` places, `/team/proposals` and `/feedback` refused for `agent:` places and still allowed for others;
  - the place registry: one session per fingerprint, refusal at the cap, no eviction, idle end, boot cleanup of `msg-place-`;
  - the queue keyed by `memoryPeer`, with no cross-fingerprint merge;
  - ack-ref ownership;
  - the `agentSessions` status values.
- **Integration (real HTTP, real `mps_` tokens):**
  - a place token for `agent:A` replies with 200, and the recipient is A;
  - with B's thread id it gets 403, and with an ambiguous thread 409;
  - a person-place token on the route gets 403, and so does the agent token;
  - an `agent:A` token is refused on `/memory/search`, `/topic/context`, `/commitments`, `/view`, `/api/files/*`, `/team/proposals`, `/feedback`, `/threadline/relay-send`, `/slack/session-reply` and `/app/session-reply`.
- **Leak tests:**
  - Person P has a fact in P's scope folder and in owner memory. A placed session for `agent:A`, spawned through the production wiring, launches with settings whose `allowRead` and `--allowedTools` exclude P's folder and the agent home, carries no MCP config, and gets a bootstrap with no owner or person memory.
  - Live on the M5 Pro: a real scoped session is given P's folder path and asked for the fact, and must fail to read it.
  - A peer B message on A's thread is not injected, resumed, or let resolve a waiter.
  - An unflagged recovery row is skipped.
- **E2E:** production init on a multi-person agent. A relay message from an authenticated fingerprint whose profile is `user-granted` produces an interactive session with audience `place:agent:<fp>`, and a reply via the script reaches the peer.
- **Live-user-channel proof:** a throwaway multi-person agent with privacy on, a second throwaway agent as the peer over the real relay. The matrix:
  - happy path: a round trip through the real relay;
  - permission: the peer asks for a seeded person fact and gets none;
  - the kill switch refuses the peer;
  - unverified: an untrusted peer is refused;
  - failure: with the sandbox broken, the peer is refused;
  - lifecycle: a second message on the thread is injected into the same place session;
  - concurrency: a second thread from one peer is injected into that peer's live place session. A fourth peer at the cap is queued, and no live session is ended. With `maxSessions` 2 and one session running, a placed spawn is refused;
  - stranger: a first-contact relay key with a `setup-default` profile is refused;
  - thread reuse: B's entry expires, A sends on B's thread id, and A gets a new thread id and a prompt with none of B's text. Same when B's entry is still live (foreign);
  - flip with a queue: a request queued while single-person with no authenticated fingerprint, and one from a `setup-default` profile, are both refused at launch after the flip;
  - atomic cap: three peers' spawns fired concurrently with two places live yield exactly one new place and two queued;
  - legacy thread: a pre-update entry whose `remoteAgent` is the sender's fingerprint keeps its id, drops its resume and loads no pre-claim history, including when a foreign sender's text was stored on it before the update. A legacy entry recorded under a name moves to a fresh id, and the reply carries `inReplyTo`;
  - concurrent first message: two peers send on the same unused thread id at once. Exactly one owns it, and the other is on a fresh id before any history load or delivery;
  - post-only: under `post-only`, a relay waiter and a local-route waiter both stay unresolved, no local or forwarded topic session gets input, and the reply lands in the topic post and the place;
  - capacity accounting: three sequential successful place launches with `maxSessions` 5 all succeed, and the fourth is queued;
  - hook identity: an `agent:A` token posting a hook event naming another session id changes only its own session's state;
  - revocation: with a place session live, revoking the grant or turning the switch on ends it at the next registry tick, and a peer message sent before that tick is not delivered;
  - flip: a pipe session running when a second person arrives is ended before the next peer message is delivered;
  - regression: a single-person agent's A2A spawn arguments are unchanged.
- **Regression:** with privacy off, or a single person, pipe, listener and A2A spawns are byte-identical to today.

## Maturation plan

- **test-agent-live:** the live-user-channel proof matrix in Testing, on a throwaway multi-person agent with privacy on and a second throwaway agent as the peer over the real relay, run on the M5 Pro before the PR is marked ready.
- **ladder:** memoryPrivacy
- **dev-agent-live:** a development agent that already has memory privacy on, and is multi-person, takes the release. Echo's peers can reach it in their own places, and Echo checks at least one real peer round trip plus one refused stranger.
- **fleet:** follows `memoryPrivacy`, which stays off by recorded preference (`final: default-off-by-preference`). This spec changes behaviour only for agents whose owner already turned privacy on. For those agents the new admission is on by default, with `refuseAgentSessions: true` as the way back (decision 1).
- **graduation criterion:** on the dev agent, placed sessions started and replied to with no reply lost to the sandbox, no stranger admitted, and no session ended by another peer's admission, recorded through `featureEvidence` under `memoryPrivacy`.
- **dark-window:** none. The behaviour is gated by an owner's existing opt-in to memory privacy, and the switch is the dark path. If the dev rung shows a lost reply or a wrong admission, the release notes say to set `refuseAgentSessions: true`, and the default is reconsidered.

## Multi-machine posture

- **Peer place folder** (`~/.instar/memory-scopes/<agent>/place-<hash>`): machine-local.
  machine-local-justification: operator-ratified-exception — **pending ratification at this spec's approval.** The parent's scope folders are machine-local (commit 0d9bd763d, #2705), but #2705 was merged by Echo, so it is not an operator artifact. This spec's approval commit is the artifact. Reason: replicating it would copy what a peer said through a sync path built for shared state. Cost: a conversation that moves machines starts with an empty place, never a wider one. Surfaced to Echo for an explicit yes.
- **Audience and place key:** unified by construction. Each machine recomputes them from the authenticated fingerprint, which every machine gets from the relay or the local route.
- **Thread ownership and transcript audience** (`peerFingerprint`, `audienceKey`): they live in `ThreadResumeMap` / `Conversation` and follow those stores' existing posture. An entry that reaches a machine without the fields is unowned there, the strict direction.
- **`memoryPrivacy.refuseAgentSessions`:** per machine, like `memoryPrivacy.enabled`, because `config.json` is not replicated.
  machine-local-justification: operator-ratified-exception — the same per-machine config posture as `enabled`, pending the same ratification. Stated plainly: a machine without the switch accepts scoped peer conversations. Setting it on one machine does not set it on the others.
- **Place registry:** per machine. It tracks sessions running on that machine.
  machine-local-justification: hardware-bound-resource — its global cap and free slot bound the session slots and memory of the machine it runs on. Stated plainly: the one-session-per-place rule is per machine, so on N machines one peer can hold up to N place sessions, at most one on each machine that receives its messages. Threadline delivers a thread to the machine holding the agent's relay, so in practice it is one.
- **Cross-machine topic forward:** the receiving machine applies the section 3 check. An older receiver is the parent spec's stated rollout gap.
- **Notices:** none new. Refusals use the existing spawn-refusal reporting.

## Left behind (precision, routed elsewhere)

- Parent-spec gap: `audienceChanged` is keyed per place, so a second resume in the same place can carry a transcript from an earlier audience (Slack places too). This goes to the feedback queue. This spec closes it for A2A through `audienceKey`.
- The guard allows `POST /telegram/origins/operations/:id/outcome`, but the route is a `GET`. This goes to the feedback queue.

## Open questions

*(none)*
