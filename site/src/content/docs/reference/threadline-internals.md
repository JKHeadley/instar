---
title: Threadline Module Reference
description: A module-by-module reference for src/threadline — what each class is for, its main methods and behaviour, and where it is wired into the server.
---

This page describes the modules under `src/threadline/` one at a time: what each is
for, what its main methods do, and where the server uses it. It complements the
[Threadline Protocol](/features/threadline/) feature page (what the protocol does for
you) and the [protocol reference](/reference/threadline-protocol/) (wire format).

Two things are worth knowing before reading the entries:

- **Not every module is wired into the running server.** Several are complete, tested
  library code that the server's boot path does not construct today. Each entry says
  which is the case, so "it exists" is never mistaken for "it is running".
- **File names and exports differ in some modules.** A few files are named like a
  class but export only functions; the entry names the real exports.

## Inbound message ids and resends

### InboundIdLedger

`src/threadline/InboundIdLedger.ts` is the receiver's two-week record of every
agent-to-agent message id it accepted. It exists so that a second copy of the same
message — a relay copy held while the agent was offline, or a peer resending — can be
recognised instead of being answered twice or silently lost.

It is a SQLite file per agent at `state/a2a-inbound-ids.<agent>.sqlite`. Each row holds
the sender key, the message id, when it was admitted, which ingress carried it
(`relay`, `relay-unknown-sender`, `threadline-http` or `relay-agent`), the thread, and a
disposition: `admitted`, `handed-off`, `handoff-failed`, `refused` or `no-reply`.

Three rules carry the design:

1. Only an outcome on an explicit list (`OUTCOME_ALLOWLIST`: listener, warm, approval,
   store, live, pipe, cold, topic) counts as a hand-off. Anything else, including a
   return shape nobody anticipated, is recorded as `handoff-failed`.
2. Only a *durable* hand-off suppresses a resend. No hand-off path is durable yet, so
   the only row that stops a second copy is a verified `no-reply`. Every other resend is
   admitted again and delivered with the fixed notice "resent copy — check this thread's
   history before replying".
3. Nothing another machine says can suppress a message.

Every failure leans toward a labelled duplicate, never a loss: a database error, a
cooldown, a full `unverified:` namespace and a message with no usable id are all
delivered without a row.

Main methods:

- `admit(request)` is the commit point. It returns `admitted` (with an
  `AdmissionTicket`), `duplicate`, `in-flight`, `unrecorded` (deliver with no row) or
  `error`.
- `AdmissionTicket` is the per-attempt handle. The attempt that owns it calls
  `recordHandoff`, `recordRouterResult` or `recordOutcome` once, then `finish()` in a
  `finally`; a ticket finished with nothing recorded writes `handoff-failed`.
- `waitForSettle` lets a relay copy wait, bounded, for an attempt already in flight.
- `lookup`, `getRow` and `read` answer "have I seen this id?" without changing anything.
- `runPruneTick` removes rows past the retention period (14 days by default, never
  under 2).
- `isOperational` reports whether the lookup can be trusted right now.

`InboundIdLedgerController` owns the ledger's lifetime against a live `enabled` flag: it
opens the file at boot when the feature is on, opens it lazily after a live off→on
flip, and closes it on an on→off flip. A file that cannot be opened leaves the ledger
dark with one degradation report.

**Wiring.** `buildInboundIdLedgerController` is called from `src/commands/server.ts` and
handed to `AgentServer`. The four ingress paths consult it: the relay socket (through
`runRelayInboundWithLedger`), the signed HTTP receive route in `ThreadlineEndpoints`,
and the same-machine `/messages/relay-agent` route in `src/server/routes.ts`. The read
surface is `GET /a2a/inbound-ids`. `threadline.inboundIdLedger.enabled`, when omitted,
follows the development-agent gate: on for a development agent, off for the fleet.

### inboundIdLedgerWiring

`src/threadline/inboundIdLedgerWiring.ts` is the glue between those ingress paths and
the ledger. It lives outside `server.ts` and `routes.ts` so the tests run the same code
production runs.

- `admitRelayInbound` performs the relay-socket commit, including the bounded wait for
  an in-flight attempt. Every fail-open answer delivers with a no-op ticket; the socket
  never refuses a message for want of a row.
- `runRelayInboundWithLedger` wraps one gate-passed relay message: the commit happens
  before any side effect, the handler runs with the ticket and the notice, and the
  ticket is finished in a `finally`. It returns `false` when the message was dropped as
  a duplicate.
- `recordDuplicateAck` records the delivery acknowledgement a duplicate implies. It
  uses the *admitted* row's thread, only counts messages sent before that row's
  `admitted_at`, and does not mark the peer as recently alive.
- `createPeerHandoffAnnotator` asks the agent's other machines whether they handed the
  same id off. At most 8 peers, 500 ms each, with a per-peer breaker. The answer only
  changes the wording of the resend notice; it can never stop delivery.
- `projectInboundRow` shapes a row for the read route, marking the thread id as
  untrusted sender text.

### backupRoutes

`src/threadline/backupRoutes.ts` holds the two decision rules for the backup delivery
routes between agents on the same machine. Both are pure functions, called from the
relay-send handler in `src/server/routes.ts`.

- `classifyFallthrough` decides, after a direct local POST that may have reached the
  receiver, whether the relay copy that follows must be marked `resend: true`. It is
  left unmarked only when non-admission is proven: no POST was issued, the POST's own
  connection was refused, the receiver answered 400, 401 or 404, or it answered 503
  with `ledger-unavailable`. Over-marking is the safe direction, because a mark on a
  copy that was not a repeat only changes the receiver's notice wording.
- `selectFingerprintTarget` and `checkFingerprintHealth` implement local-first delivery
  for a message addressed by fingerprint. The target must be exactly 32 hex characters,
  match exactly one entry in `known-agents.json` (two ports are ambiguous and go to the
  relay), and that agent's `/threadline/health` must show the same fingerprint and a
  connected relay.
- `resolveBackupRoutesEnabled` reads `threadline.backupRoutes.enabled`, falling back to
  the development-agent gate. `createBackupRouteCounters` supplies in-memory counters
  shown on the authenticated health route as evidence for graduating the feature.

### honestDeliveryWiring and relayVerdict

`src/threadline/relayVerdict.ts` defines the fixed vocabulary for what the relay said
about one message: `delivered`, `queued`, `rejected`, `expired` or `unconfirmed`, plus a
reason code (`queue-full`, `rate-limited`, `routing-refused`, `banned`, `unmapped`). The
relay's own prose never reaches an agent's context; `mapRelayReason` maps it to a code
by prefix and `clampRelayReason` strips control characters and keeps at most 200
characters for the audit log only.

`src/threadline/honestDeliveryWiring.ts` connects those verdicts to the delivery
tracker. `wireRelayVerdicts` is the single subscription that records each verdict;
`startDeliverySweep` runs every 15 minutes and relabels relay rows that never received
a usable verdict as `unconfirmed`, never `failed`. Both are started from
`src/commands/server.ts`.

### ThreadlineReplyValidation

`src/threadline/ThreadlineReplyValidation.ts` exports one function,
`isAuthenticatedThreadlineInbound`. It answers: does this `inReplyTo` id name a real
inbound message on the thread the caller claims? It accepts evidence from either of two
stores — the HMAC-signed listener inbox (`ListenerSessionManager`) or the hash-chained
per-thread log (`ThreadLog`) — because traffic is split across them while the canonical
log migration is in progress.

It fails closed on malformed input, a thread mismatch, an unconfined path, a read
error, or a missing listener manager. The listener manager is required even when the
thread log has the evidence, because it owns the claim that stops two workers answering
the same message.

**Wiring.** The `/threadline/relay-send` handler in `src/server/routes.ts` calls it
before accepting a reply that carries `inReplyTo`.

### ThreadlineReapRecovery

`src/threadline/ThreadlineReapRecovery.ts` exports `createThreadlineReapRecovery`. When
a warm reply worker is shut down mid-answer (for example by quota pressure), this gives
the shared resume queue an exact way to finish the job. It returns two functions.
`pending` says whether a queued entry still needs an answer: the inbound message must
be found in the canonical stores, with no reply claim and no recorded reply. `respawn`
takes the reply claim, routes the message back through `ThreadlineRouter`, and
transfers the claim to the new session, so the original send and the recovery worker
cannot both reply. If routing fails the claim is released.

**Wiring.** Constructed in `src/commands/server.ts`; its `pending` and `respawn`
functions are passed to the resume queue.

## Hub and Telegram surfaces

### HubIntentClassifier

`src/threadline/HubIntentClassifier.ts` decides whether a message typed in the
"Threadline" hub topic is a command — "open this" or "tie this to <topic>" — or ordinary
conversation. It replaced a whole-message regular expression that swallowed the message
before the agent saw it, so a misread ate a real message.

`classifyHubIntent` asks a model, giving it the message, a bounded window of recent
conversation, and the list of topics that can be bound. For a "tie" the model must
return a `targetTopicId` taken from that list (or `null`); `resolveEnumTopic` validates
the returned field against the list, and the model's prose is never string-matched.
`looksLikeHubIntent` is a cheap pre-check that can only skip toward pass-through.
`toHubCommand` converts a positive result into the command the hub handler runs.

It fails open: no provider, an open circuit breaker, a timeout, unparseable output, a
target not in the list, or low confidence all return "not a command", and the message
goes to the agent untouched.

**Wiring.** Called from the hub topic handler in `src/commands/server.ts`. Settings
live under `threadline.hubIntent` (`enabled`, `dryRun`, `minConfidence`, `timeoutMs`,
`contextWindowTurns`, `modelTier`); `enabled`, when omitted, follows the
development-agent gate.

### TelegramOriginAttribution

`src/threadline/TelegramOriginAttribution.ts` records who authored a Threadline message
that is posted into Telegram, so the message-origin record does not credit it to
whichever model call happened to run last in the process.

- `withThreadlineTelegramAuthor` registers the producer (`a2a-checkin`,
  `threadline-peer-relay` or `threadline-outbound-relay`), issues an automation-reply
  token bound to the exact topic and text, and runs the send inside it.
- `withThreadlineForwardedAuthor` handles mirrored traffic. An inbound peer message is
  always recorded with an unknown author, because a peer's prose must never inherit this
  agent's model attribution. An outbound mirror keeps the submitting session's own
  context when one is present.

With no origin service configured, both simply run the send.

**Wiring.** Used by `TelegramBridge`, `TopicLinkageHandler` and the check-in sender in
`src/commands/server.ts`.

### TelegramBridge

`src/threadline/TelegramBridge.ts` mirrors agent-to-agent messages into one Telegram
topic per thread so the operator can watch a conversation as it happens. It is an
observer only: it never blocks or vetoes a message. `mirrorInbound` and `mirrorOutbound`
ask `TelegramBridgeConfig` whether to post, then find or create the topic (named
`local↔remote — subject`) and send. Thread-to-topic bindings persist in
`.instar/threadline/telegram-bridge-bindings.json`; `getBindings` and
`getBindingForThread` read them.

**Wiring.** Constructed in `src/commands/server.ts`, passed to `AgentServer` and the
routes, and read by `ThreadlineObservability`.

### TelegramBridgeConfig

`src/threadline/TelegramBridgeConfig.ts` is the single source of truth for the bridge's
settings, stored under `threadline.telegramBridge` and read through the live config so
dashboard changes apply without a restart. Defaults keep noise down: the bridge is off,
it never creates a topic on its own, and it mirrors into a topic that already exists.
`shouldAutoCreateTopic` and `shouldMirrorIntoExistingTopic` are the two questions the
bridge asks; `addToAllowList`, `addToDenyList` and `update` change the settings. The
allow list wins when an agent is on both lists.

### TopicLinkageHandler

`src/threadline/TopicLinkageHandler.ts` connects a Threadline conversation to the
Telegram topic that started it. `captureOriginOnSend` runs after a successful outbound
send: it stamps the thread with the originating topic and opens a commitment that is
closed by the peer's reply. `tryRouteReplyToTopic` runs on an inbound reply: if the
thread has a live origin topic it classifies the reply with `SalienceGate`, delivers it
to that topic's session, notifies the user when the reply is user-visible, and marks
the commitment delivered. It returns `null` when there is no linkage, and the router
falls back to its ordinary thread-worker path.

**Wiring.** Constructed in `src/commands/server.ts`; called by `ThreadlineRouter` and
the relay-send route.

### SalienceGate

`src/threadline/SalienceGate.ts` decides whether a reply should also be surfaced to the
user (`user-visible`: a final answer, a request for credentials, a hard blocker) or
only delivered to the session (`agent-internal`: an acknowledgement, mid-negotiation
chatter). It never withholds the reply itself. `evaluate` runs the classifier;
`fallback` is the deterministic rule used on error or timeout — user-visible for the
first reply on a thread, agent-internal afterwards.

**Wiring.** Constructed in `src/commands/server.ts` with no classifier, so today it
always uses the fallback rule.

### ThreadlineObservability

`src/threadline/ThreadlineObservability.ts` provides the read-only views behind the
dashboard's Threadline tab. `listThreads`, `getThread` and `searchMessages` scan the
append-only inbox and outbox files, the bridge bindings and `known-agents.json`. It
never writes or gates anything. Each query is a full file scan, which is fast at the
message counts agents have today.

**Wiring.** Constructed in `src/commands/server.ts` and served by the Threadline
dashboard routes.

### ThreadlineNicknames

`src/threadline/ThreadlineNicknames.ts` stores user-editable display names for peer
agents, keyed by fingerprint, in `.instar/threadline/nicknames.json`. Each entry records
where the name came from (`user`, `haiku` or `import`). `get`, `set`, `delete` and `all`
manage entries; `resolveByName` finds a fingerprint from a name using
`canonicalizeName`, so capitalisation and spacing do not matter.

**Wiring.** Used by the relay-send handler in `src/server/routes.ts`, which resolves a
target given by name against the nickname store first and answers with a clear
"ambiguous nickname" error when two fingerprints share the name.

## Sessions that answer inbound messages

### ListenerSessionManager

`src/threadline/ListenerSessionManager.ts` manages a warm session that handles incoming
messages through a signed inbox file. The server appends HMAC-signed entries to an
append-only JSONL inbox; the session reads new entries and an ack file records which
were processed, so a crash does not lose or repeat work. `rotate` starts fresh files
when the session's context fills, and `needsRotation` says when. The class also owns
the canonical inbox and outbox readers (`readCanonicalInboxEntry`,
`readLatestCanonicalInboxForThread`) and the reply-claim ledger (`hasReplyClaim`,
`transferReplyClaim`, `releaseReplyClaim`) that guarantees one reply per inbound message.

**Wiring.** Constructed in `src/commands/server.ts` when `threadline.relayEnabled` is
set; used by the routes, `ThreadlineReplyValidation` and `ThreadlineReapRecovery`.

### WakeSocketServer

`src/threadline/WakeSocketServer.ts` is a Unix domain socket the listener daemon uses to
tell the server "a new inbox entry was written". The daemon sends one byte; the server
reacts at once instead of polling. The socket is created owner-only (mode 0600), the
connecting process's credentials are checked, and the path is resolved to its real
location to prevent symlink attacks. `start` and `stop` are its whole surface.

**Wiring.** Constructed in `src/commands/server.ts` alongside the listener.

### PipeSessionSpawner

`src/threadline/PipeSessionSpawner.ts` answers simple inbound queries with a short-lived
one-shot session that exits when done, instead of holding a long-lived session slot.
`shouldUsePipeMode` decides eligibility; `spawn` runs the session with the message
wrapped in untrusted-message tags, thread history summarised before it is included,
tools limited to read-only plus `threadline_send`, the agent's state directory always
excluded, and a 10-minute timeout that kills the whole process group.
`hasActiveSessionForThread` reports a pipe session already running for a thread, so
rapid messages on one thread do not kill each other's sessions.

**Wiring.** Constructed in `src/commands/server.ts`.

### ThreadResumeMap

`src/threadline/ThreadResumeMap.ts` maps a thread id to the session that can resume it.
It is now a view over `ConversationStore`, the single source of truth: `save` merges
into the conversation record rather than overwriting it, and a one-release fallback
still reads the old `thread-resume-map.json` on a miss. `get`, `getBySessionName`,
`getByRemoteAgent`, `listActive`, `pin`, `unpin` and `prune` are the main methods.

**Wiring.** Constructed in `src/commands/server.ts` and in the MCP stdio entry; used by
`ThreadlineRouter`, `TopicLinkageHandler` and the routes.

### RelayGroundingPreamble

`src/threadline/RelayGroundingPreamble.ts` exports `buildRelayGroundingPreamble`, which
produces the text placed in front of a message from an external agent. It reminds the
session who it is and where its boundaries are. It is behavioural guidance, not a
security boundary. `tagExternalMessage` marks peer text as external, and
`RELAY_HISTORY_LIMITS` bounds how much thread history is included.

**Wiring.** Called by `ThreadlineRouter` when it builds the prompt for a relay message.

### MessageSecurity

`src/threadline/MessageSecurity.ts` exports the framing and sanitising helpers for
incoming agent content. `frameIncomingMessage` wraps a peer message so it is read as
data from another agent and never placed in a system prompt; `isFramed` detects that
wrapping. `sanitizeCapabilityDescription` limits a capability description to 200 safe
characters, `sanitizeAgentCard` applies that to a whole card, and
`detectPotentialInjection` flags suspicious text.

**Wiring.** Used by `UnifiedTrustWiring`.

## Trust, pairing and credentials

### UnifiedTrustWiring

`src/threadline/UnifiedTrustWiring.ts` exports `createUnifiedTrustSystem`, a facade that
composes the trust pieces — canonical identity, authorization policy, trust evaluation,
`DiscoveryWaterfall`, `MessageSecurity` and `TrustAuditLog` — around the existing trust
manager, without modifying the older classes.

**Wiring.** Called from `src/commands/server.ts` once the Threadline bootstrap has
produced a trust manager; the result is passed to `AgentServer` and the routes.

### TrustAuditLog

`src/threadline/TrustAuditLog.ts` is an append-only, hash-chained log of trust and
authorization changes. Each entry stores the hash of the one before it, so a removed or
edited entry is detectable. It records decisions only, never message content, and keeps
90 days. `append` writes an entry and `verifyIntegrity` checks the chain.

**Wiring.** Constructed inside `createUnifiedTrustSystem`.

### DiscoveryWaterfall

`src/threadline/DiscoveryWaterfall.ts` finds agents in three stages, in order: local
(the agent registry, instant), relay (presence and directory search, 5-second budget),
and network (capability matching through MoltBridge, 15-second budget, which costs
money). `discover` runs the stages; `registerAdapter` plugs in a stage and
`isAvailable` reports whether one is present. Duplicates are merged by fingerprint.

**Wiring.** Constructed inside `createUnifiedTrustSystem`.

### CredentialShareGate

`src/threadline/CredentialShareGate.ts` guards the sanctioned path for sending a
credential to another agent. `evaluateOutboundCredentialShare` and
`assertCanShareCredential` refuse the send unless the recipient is `mutual-verified`
and an encrypted, signed path is available. The decision is keyed on who the peer is,
never on what the message says about itself. Any error resolving pairing state refuses.
It does not claim to stop a secret pasted into free text.

**Wiring.** Called from the relay-send route in `src/server/routes.ts`.

### PairVerifyReceipt

`src/threadline/PairVerifyReceipt.ts` handles the `pair-verify` control message: a
signed receipt a peer sends after computing the same short authentication string.
`processPairVerifyReceipt` validates the schema, checks the Ed25519 signature against
the key bound into the pending pairing, and matches the pairing id and string
fingerprint. A valid receipt only sets a "peer acknowledged" flag. It never makes a
pairing `mutual-verified`; that needs the operator's PIN.

**Wiring.** Called by `InboundMessageGate` before the trust check.

### PairingPendingStore

`src/threadline/PairingPendingStore.ts` keeps the short-authentication-string words for
pairings awaiting verification in an owner-only file,
`threadline/pairing-pending.json`. The words stay on this machine and are never
replicated; the trust profile stores only their fingerprint. `put`, `get`, `listPeers`
and `discard` manage records, and a record is discarded as soon as the pairing is
verified or fails.

**Wiring.** Constructed by `AgentTrustManager`.

## Protocol surfaces

### ThreadlineEndpoints

`src/threadline/ThreadlineEndpoints.ts` exports `createThreadlineRoutes`, the HTTP
handlers for the protocol: `GET /threadline/health`, the two unauthenticated handshake
routes, the authenticated message-receive and thread-read routes, and the blob fetch.
`resolveRelayHealth` computes the relay state shown on the health route, and
`inboundIdLedgerAdvertised` decides whether health advertises the inbound-id capability
— only while the ledger lookup is operational.

**Wiring.** Mounted from `src/server/routes.ts`.

### ThreadlineBootstrap

`src/threadline/ThreadlineBootstrap.ts` exports `bootstrapThreadline`, run at server
boot. It loads or creates the agent's Ed25519 identity keys, builds the handshake
manager, registers the Threadline MCP tools in the user's Claude Code configuration,
announces the agent for discovery, and starts the discovery heartbeat.

**Wiring.** Called from `src/commands/server.ts`.

### ThreadlineMCPServer

`src/threadline/ThreadlineMCPServer.ts` exposes Threadline to a session as MCP tools:
`threadline_discover`, `threadline_send`, `threadline_history`, `threadline_agents`,
`threadline_delete`, `threadline_pair`, and four registry tools when a registry is
available. It runs over stdio locally (no authentication) or over SSE / streamable HTTP
with a bearer token.

**Wiring.** Constructed by the stdio entry point `src/threadline/mcp-stdio-entry.ts`,
which Claude Code launches.

### MCPAuth

`src/threadline/MCPAuth.ts` manages bearer tokens for the MCP server's network
transports. A token is 32 random bytes; only its SHA-256 hash is stored, in
`threadline/mcp-tokens.json`, and the raw token is returned once at creation. Scopes are
`send`, `read`, `discover` and `admin`. `createToken`, `validateToken`, `hasScope`,
`revokeToken` and `listTokens` are the main methods.

**Wiring.** Exported from the package index and accepted by `ThreadlineMCPServer`. The
server boot path does not construct it, because the shipped stdio transport needs no
token.

## Library modules not constructed by the server today

The modules below are complete and unit-tested, but nothing in the server's boot path
constructs them. Treat them as available building blocks, not as running behaviour.

### AutonomyGate

`src/threadline/AutonomyGate.ts` decides how an inbound agent message is shown to the
user, by autonomy profile: cautious (queue for approval), supervised (deliver and
notify), collaborative (deliver silently and add to a digest), autonomous (deliver and
log). `evaluate` returns the decision; `blockAgent`, `pauseAgent`, `resumeAgent`,
`approveMessage` and `rejectMessage` are the controls. `ThreadlineRouter` accepts one,
but `src/commands/server.ts` passes `null` for it.

### ApprovalQueue

`src/threadline/ApprovalQueue.ts` holds messages waiting for the user's approval in
`threadline/approval-queue.json`. `enqueue`, `approve`, `reject`, `pendingCount` and
`pruneExpired` are its methods. It is owned by `AutonomyGate`.

### DigestCollector

`src/threadline/DigestCollector.ts` accumulates silently delivered messages in
`threadline/digest.json` for a periodic summary. `addEntry` records one,
`shouldSendDigest` checks the interval, `generateDigest` builds the text and
`markDigestSent` resets it. It is owned by `AutonomyGate`.

### SpawnLedger

`src/threadline/SpawnLedger.ts` is a SQLite compare-and-swap ledger that makes spawning
two sessions for one relay event impossible. `tryReserve` atomically claims an event id
or reports the collision, and generates a per-spawn secret used to sign heartbeats. It
enforces 1000 spawns per peer per 24 hours and prunes finished rows after 30 days.
`markStatus`, `verifyHeartbeatHmac`, `sweepStaleSpawning` and `pruneTerminal` complete
the surface.

### SpawnNonce

`src/threadline/SpawnNonce.ts` holds the relay-side helpers for the ledger.
`deriveEventId` builds a deterministic event id from the message envelope.
`prepareNonceFd`, `stdioWithNonceFd` and `withNonceFd` hand the per-spawn secret to the
new session through file descriptor 3 rather than an environment variable, because an
environment variable would be inherited by every helper process the session starts.

### HeartbeatWriter

`src/threadline/HeartbeatWriter.ts` runs inside a relay-spawned session. It reads the
per-spawn secret once (`readSpawnNonceFromFd`), then `write` signs a liveness payload
and writes it to `.instar/threadline/sessions/<threadId>.alive` by atomic rename, so a
reader never sees a half-written file.

### HeartbeatWatchdog

`src/threadline/HeartbeatWatchdog.ts` is the single one-second poller for those files.
Each `tick` reads every `.alive` file, verifies its signature against the `SpawnLedger`
row, checks the process is alive, and emits a typed signal. It only produces signals;
it never blocks, kills or retries.

### RelaySpawnFailureHandler

`src/threadline/RelaySpawnFailureHandler.ts` is the one place that decides what a
heartbeat signal means. `handle` marks the ledger row verified when the heartbeat
checks out, and on a missing, forged, dead or stale heartbeat marks it failed and saves
the message to the receiver's inbox. It never retries automatically, because an
automatic retry would let a sender amplify load.

### A2AGateway

`src/threadline/A2AGateway.ts` translates between the open A2A JSON-RPC protocol and
Threadline's internal format. `handleRequest` processes one request; each exchange is
one completing A2A task, and a `contextId` carries continuity across tasks by mapping
to a thread. A message held for approval is reported as the A2A `input-required` state.
`getMetrics`, `getAuditLog` and `runMaintenance` support operation.

### AgentCard

`src/threadline/AgentCard.ts` generates the A2A agent card served at
`/.well-known/agent-card.json` and signs it with the agent's Ed25519 key over canonical
JSON. `generate`, `getPublicCard` and `getExtendedCard` produce cards (the extended card
requires authentication); the static `verify` checks a signature and
`sanitizeDescription` cleans skill descriptions.

### ContextThreadMap

`src/threadline/ContextThreadMap.ts` maps an A2A `contextId` to a Threadline thread id
and back, stored in `threadline/context-thread-map.json`. Each mapping is bound to the
agent identity that created it: a different agent presenting the same `contextId` gets
`null` and a new thread, so one agent cannot take over another's conversation.

### ComputeMeter

`src/threadline/ComputeMeter.ts` tracks token budgets for inbound network messages:
hourly and daily limits per agent, scaled by trust level, and a global daily cap.
`check` asks whether a request fits, `record` books usage, and `incrementSessions` /
`decrementSessions` track concurrent sessions. State is stored in
`threadline/compute-meters.json`; the day resets at midnight UTC.

### SessionLifecycle

`src/threadline/SessionLifecycle.ts` tracks the state of sessions serving network
agents — active, parked, archived, evicted — so memory and cost stay bounded.
`activate`, `touch` and `transitionState` move a session between states, and
`runMaintenance` parks and archives idle ones. A parked or archived session is resumed
on demand.

### TrustBootstrap

`src/threadline/TrustBootstrap.ts` verifies an unknown agent using one of four
strategies: `directory-verified`, `domain-verified` (through `DNSVerifier`),
`invitation-only` (through `InvitationManager`), or `open`, where anyone may start a
conversation at the `untrusted` level. `verify` runs the configured strategy.

### DNSVerifier

`src/threadline/DNSVerifier.ts` proves an agent controls a domain by reading the TXT
record at `_threadline.<domain>`, expected as `threadline-agent=v1 fp=<fingerprint>`.
`verify` handles timeouts, missing domains and multiple records, and caches results for
five minutes by default.

### InvitationManager

`src/threadline/InvitationManager.ts` creates and checks invitation tokens, stored in
`threadline/invitations.json` and signed with an HMAC key the server generates. A token
can expire and can be single-use or limited to a number of uses. `create`, `validate`,
`consume`, `revoke` and `list` are its methods.

### ContentClassifier

`src/threadline/ContentClassifier.ts` is an optional outbound filter that looks for
credentials, internal data, system prompts and personal information in a message before
it is sent. It is disabled by default. `classify` returns the verdict and `getMetrics`
its counts. The server's routes import only two helpers from this file,
`detectCommitmentClass` and `commitmentNudge`, which flag an agent committing to
something in plain prose; the classifier itself is not constructed.

### OpenClawBridge

`src/threadline/OpenClawBridge.ts` adapts OpenClaw's room-and-skill model to Threadline
threads: an OpenClaw room id maps to a thread through `ContextThreadMap`, a user id to
an agent identity, and OpenClaw actions to send, discover, history and status.
`processMessage` handles one message and `getActions` lists the actions. It has no
external SDK dependency.

### OpenClawSkillManifest

`src/threadline/OpenClawSkillManifest.ts` exports `generateSkillManifest`, which builds
the manifest describing Threadline's actions and settings in the format OpenClaw's
skill registry expects.

### BackfillCore

`src/threadline/BackfillCore.ts` holds the pure helpers for the one-off script that
backfills old threads into Telegram topics: `buildTopicName`, `chunkBody`,
`groupByThread`, `pickCounterparty`, `ledgerKey` and `formatBackfillMessage`. They live
in `src/` so they are type-checked and unit-tested; the script keeps its own copies,
which must stay in step with this file.
