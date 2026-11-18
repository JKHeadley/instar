---
title: "Topic-bound agent spawns are placed by load, like a new conversation (placement Step 2)"
slug: "topic-spawns-placed-by-load"
author: "echo (machine stewardship, topic 144503)"
tier: 2
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
parent-principle-fit: "Most of the load the agent puts on the Mac Studio is spawns it starts for a conversation (18 of 23 sessions measured on 2026-11-17). Step 1 placed only topicless helpers; until topic-bound spawns can start where there is room, one machine still carries most of the agent's own work while peers sit idle."
eli16-overview: "docs/specs/topic-spawns-placed-by-load.eli16.md"
review-convergence: "2026-11-18T21:47:44.177Z"
review-iterations: 7
review-completed-at: "2026-11-18T21:47:44.177Z"
review-report: "docs/specs/reports/topic-spawns-placed-by-load-convergence.md"
approved: true
approved-by: "echo-chief-of-staff (msg a8f9ad3f, 2026-11-18, with 3 fold-ins)"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Topic-bound agent spawns are placed by load, like a new conversation (placement Step 2)

## Problem statement

This is Step 2 of `docs/specs/agent-sessions-placed-by-load.md`, tracked as CMT-1936 (review 2026-11-25). Step 1 (PR 3382) does two things. It logs, in shadow, where every `/sessions/spawn` would go. And it places, live and opt-in, only spawns with no `topicId`. Its `travelBlocker` returns `topic-bound` for any `topicId`, so a spawn for a conversation always starts on the machine that received the call.

Those are most of the load. On 2026-11-17 the Studio held 23 running sessions while the Laptop held 0. 18 of the 23 were topic-bound sessions the agent had started itself: stewardship runs, review runs, spec rounds, builder sessions. A user's new conversation is already placed by load (conversation placement through `startCheckedTopicOnMachine`). An agent-started conversation is not.

Feasibility, checked against the PR 3382 code on 2026-11-18 (`.instar/stewardship/step2-placement-feasibility.md`): the fenced start protocol already starts a topic session with a caller-supplied prompt on a peer. It does this for conversation-graph delegation (`graphDelegationRequest` + `graphDelegationLaunch {name, prompt, model, framework}`), but only for a child of a bound parent session holding a graph lease. Step 2 adds an ungated sibling of that payload for an agent's own topic spawn.

## Proposed design

### What is placed

A `/sessions/spawn` request is placed by this step when ALL of these hold:
- it carries `placement: "auto"` and a `topicId`;
- the topic has **no live owner**: `readOwnership(topicId)` returns no record, or a `released` one (the check `startCheckedTopicOnMachine` already makes);
- it carries none of the fields that cannot travel: `jobSlug`, `ultracode`, `spawnRole`, `topicName`, `requireTopicBinding`, `targetMachineId`, the `x-instar-bind-token` header, or `workWeight: "heavy"` (heavy topic work keeps Step 1's heavy-route rules and is not placed by this step), or an explicit `model` or `framework` (a placed spawn starts with the topic's own profile on the target, so a request that names its own model or framework stays local, exactly as today, with `reason: "options-do-not-travel"`);
- it does not carry `X-Instar-Placed: 1`;
- the memory-audience refusal the local route applies passes on the origin (a refused spawn is refused here, before any claim, exactly as today);
- its brief fits one replicated record (see "Size" below);
- this machine holds the pool lease. `deliverMessage` is router-only: `checkCommandRBAC` refuses it with `not-router` from any other sender (`MeshRpc.ts:563-568`), the same rule the graph path follows (`ConversationGraphDelegationRemoteRuntime.ts:69`). A machine without the lease starts locally with `reason: "not-router"`. The lease holder is the machine conversations arrive at, so this is where the load is;
- this machine is busy, and Step 1's peer filter leaves at least one peer, and that peer advertises the receiving change: its capacity heartbeat carries the flag `agent-brief@1` in `seamlessnessFlags`, the per-heartbeat flag set that travels with each beat (`MachinePoolRegistry.ts:147,327-341`), so a downgraded peer stops advertising it. A peer without the flag would frame the brief as a person's message, so it is not eligible. That filter is `heavyHeadroom`, not memory-short, quota not blocked, reservations counted.

**When this machine counts as busy.** The busy test is a floor with judgment above it, not a single cliff:
- **Floor (deterministic).** A fresh `saturated` or `impaired` verdict, or own `memoryPressured`, always counts as busy. A missing or stale verdict means placement is not considered: the spawn stays local, today's behaviour. No fixed load number blocks placement.
- **Judgment (above the floor).** Otherwise Step 1's `PlacementExecutor.decide` weighs this machine's load against the eligible peers' heartbeats (load, headroom, reservations) and places only when a peer is less loaded by Step 1's margin, so a healthy machine at 0.6 can still hand work to an idle peer. Re-tuning comes from Step 1's shadow log.

**A topic owned by a peer gets one answer, whenever it is found, on every topic-bound spawn** (only when `topicBound` resolves on; with it off, today's behaviour is unchanged on every agent). If the route's own check, or the protocol's check at claim time, finds any ownership record that is not `released` naming another machine, the route answers `409` with `placementOutcome: "topic-owned-elsewhere"` and the owner's machine, and starts nothing. Today's local route spawns into a topic owned elsewhere and only logs "possible duplicate copy" (`routes.ts:14006-14019`). That puts a second session in a topic whose messages go to the peer, so with `topicBound` on it is refused for every topic-bound `/sessions/spawn`, with or without `placement: "auto"`. The ownership check is the same read-only one the placed path makes, so this adds no new spawn path; it only stops the blind spawn. The caller reaches the existing session by messaging it. If the owner machine is currently unreachable, the 409 says so (`ownerReachable: false`), and the caller does not wait on a session it cannot reach; failover moves the topic if that machine is gone. A request without `placement: "auto"` into a topic with no live owner, or owned by this machine, keeps today's behaviour unchanged.

Every other request starts locally, exactly as today, through today's route. The "never duplicated" guarantee below is for the placed path. A local start keeps today's behaviour, which this step neither adds to nor changes. The reason is logged in Step 1's shadow log (`reason: "options-do-not-travel"`, `"not-busy"`, `"no-eligible-peer"`, `"router-not-wired"`, `"prompt-too-large"`, `"brief-not-replicated"`).

### How it is placed: the existing path for a person's first message

After rounds 1 to 5 of review, every design that added a new start payload, with a target-side launch arm and its own state machine, kept producing new race and recovery cases. This step therefore **reuses the existing receiving path**, with no separate launch arm or state machine; the only receiving changes are the three small ones named below (brief framing, authorship, media id). An agent's topic spawn is placed exactly the way a person's first message is placed when their new conversation goes to a peer.

The route calls `startCheckedTopicOnMachine(deps, sessionKey = topicId, target, pin)` through the `graphDelegationPlacement` deps. The steps are place → one checked deliver → settle. The claim is fenced by the lease epoch, and an `unknown` outcome keeps the claim. The delivery is an ordinary forwarded message:

```
payload: { text: <brief framed as below>, authorship: { kind: "agent", originMachineId, session } }
messageId: agent-spawn:<topicId>:<nonce>
```

On the target this lands in the existing forwarded-message arm (`server.ts:~29708-29830`). That arm already has nearly everything this step needs:
- with no live session for the topic, it starts one through `spawnSessionForTopic`, applying the target's topic profile as for any topic (`server.ts:~1818-1925`). One receiving change is needed here. Today the arm passes forwarded text as the person's latest message: `spawnSessionForTopic` frames it as "The user's latest message: [telegram:N] ..." under a "the user has been talking to you" preamble (`server.ts:1666, 1814-1819`). For a verified agent message (`agent-spawn:` messageId, `authorship.kind: "agent"`, origin equal to the signed sender, see below), the arm instead passes the text as a new `spawnOpts.agentTask` (the parameters are positional, so the arm adds `undefined, { agentTask }` after `movedContext`, `server.ts:1604-1636`). `agentTask` frames the text as "Task started by the agent: do this now", and it skips both the restart wording of the existing carried-brief block (`TopicSpawnBriefStore.ts:110-119`) and the hand-off continuation instruction (`server.ts:1835-1837`, `handoffContinuation.ts:58,64`). Those two tell a resumed session to wait silently when nothing is in flight, and they would leave a brand-new task idle. The session reads the brief as its own fresh task, not a person's words. The topic's history pull still runs; for a new topic it is empty, and that is harmless;
- a message arriving while a start is in flight waits on `_dashboardStartsInFlight`/the spawning registry (`:29798-29826`), bounded, and is never dropped and never spawns twice;
- delivery is deduplicated by the receipt, survives restarts through the inbound queue, and reports a failed inject (`markRemoteInjected` / `reportPeerInjectError`);
- the pool-stage gate (`_sessionPoolStage() === 'dark'` → not served) and the team-person check run as for any forwarded message.

**Media lookup.** The arm uses the messageId as the platform message id for media lookup (`platformMediaForSession.ts:461`). For an `agent-spawn:` messageId it passes `null` instead, because an agent brief has no platform message.

**Who wrote it, structurally.** The payload carries `authorship: { kind: "agent", originMachineId, session }`. The forwarded-message arm reads `payload.text` and today ignores other keys, so the only receiving change is one step: when `authorship.kind` is `"agent"` and `originMachineId` equals the signed envelope's sender (a pool member), the arm treats the message as agent-authored: it uses the fresh-task framing above, and the audit row records the author as the origin machine's session. The brief is not written into the topic's message history, because it never came from the messaging platform. History stays the record of what people and the agent actually said in the conversation. The team-person check judges a person. A forwarded message with no `senderEnvelope` already skips it (`server.ts:29722-29727`), which is the case for an agent brief, and the agent's own machine is the author.

A message claiming `agent` whose `originMachineId` does not match the signed sender is refused and not injected. The text also starts with a header, `[Agent task started by <session> on <origin nickname>]`, but the header is only a label for readers and grants nothing: authority comes from the signed sender and the structural field, never from text a person could type.

**Older peers.** The receiving change (carried-brief framing, agent authorship, null media id) exists only on builds that advertise `agent-brief@1`. A capability flag is used rather than a version comparison, because version comparison breaks for development builds and rollbacks.

**Size.** There is no separate size number. The brief must fit in one replicated record, and the replicated journal already enforces that on the actual serialized record: `REPLICATED_RECORD_MAX_ENTRY_BYTES` = 80 KB including envelope and JSON escaping (`CoherenceJournal.ts:439`). The emit happens before any claim. If the journal refuses it as oversize, the spawn starts locally (`reason: "prompt-too-large"`), as today. Anything that fits one record is also under the `TopicSpawnBriefStore` cap (`TopicSpawnBriefStore.ts:33`) and the 12 MB JSON body limit (`AgentServer.ts:2042`).

**Profile.** The target resolves the topic profile itself, as it does for any first message. The profile store is replicated, so this is the same profile the origin's local route would have resolved. Requests with an explicit `model` or `framework` never travel (see "What is placed"), so no caller override is lost.

**Reservations.** A placed topic spawn records an `agentSessionReservations` entry on its target at Step 1's standard weight (0.25 per core, 3 minutes), so successive topic spawns spread across peers. Topic sessions live longer than helpers, so Step 1's shadow-log review re-tunes that weight for topic rows separately.

### What the caller gets back

- `202` with `placedOn: { machineId, nickname }`, `placementOutcome: "peer-accepted"`, `topicId`, and `tmuxSession: null` (the target names the session through its own topic naming, so the name is not known yet), when the deliver settles `accepted`. Reconciliation finds the session bound to `topicId` on the target and stores its real name in the placement store. From then on, output reads proxy to that name, looked up by topic, and the caller can read the real name from `GET /sessions` on the target or from the placement store. `peer-accepted` is not a confirmed start, unlike Step 1's `201 peer`, and the awareness entry says so.
- `202` with `placementOutcome: "unconfirmed"` when the outcome is `unknown`. The claim is kept and nothing starts locally. If the target is reachable, reconciliation reads its sessions for the topic. If no session appears within the window, Step 1's attention item names the topic, the machine and the held claim, and a person decides whether to release and re-issue. The inbound queue on the target also reports a delivered-but-not-injected message on its own. The origin never starts the work locally by itself after `unknown`, because a delayed delivery could still land.
- `409 topic-owned-elsewhere` with the owner's machine, as above.
- local start with `placementOutcome: "local-fallback"` and the reason, when the protocol refuses before the claim or the deliver is `rejected`. The fallback does not use the local route's blind spawn. It first claims the topic for this machine with the dashboard's existing local claim, `createDashboardPoolClaimOps` (place on self, confirm locally, release on failure; `server.ts:32451-32457`). If that claim is lost, the answer is `409 topic-owned-elsewhere` and nothing starts here. If it is won, the route spawns through `ctx.topicProfile.spawnForTopic`, which gains an optional task argument passed through to `spawnOpts.agentTask`, so the brief gets the same fresh-task framing as a placed one, and answers `201` only when that spawn returns a running session. A spawn failure answers as today's route does.

Step 1's reconciliation reads the target's `GET /sessions` (3 times over 15 s in the request, then on the 30 s pool tick for up to 10 minutes). It upgrades `peer-accepted` to `live` when it sees a session bound to the topic. Step 1's placement store records topic placements too, keyed by requested name with `topicId` added. A same-name retry is read-only, exactly as in Step 1.

### Later messages reach the session

The topic's ownership record names the target, so the existing router sends later messages in that topic to the target's session, as for any placed conversation. Output reads and kill answers follow Step 1: reads are proxied, and a kill answers `409 placed-on-peer`.

### The origin's copy of the brief

### The brief on every machine

Before the deliver, the origin records the brief with `spawnBriefs.record(topicId, name, prompt)`, plus a new optional `placedOn` field in the `TopicSpawnBriefStore` row (an optional string, which older readers ignore). It also emits the brief as a replicated record of a new kind, `topic-spawn-brief`, registered through the existing `ReplicatedKindRegistry` (`ReplicatedRecordEnvelope.ts:470`) and sent by `ReplicatedRecordEmitter`, the same path that replicates commitments and preferences to every pool machine. The record key is the topic id. The fields are `topicId`, `name`, `prompt`, `placedOn`, `originMachineId` and `createdAt`; the prompt is credential-redacted before emit, as the preference pool does. When the placed session ends, whichever machine sees it complete emits an update to that record with `status: "completed"` and `completedAt`. Nothing is tombstoned or deleted by this step, so the task context stays readable on every machine; the record's retention follows the journal's existing policy.

If the emit is refused (rate cap, lock-out, oversize), the placement does not happen and the spawn starts locally (`reason: "brief-not-replicated"` or `"prompt-too-large"`).

What an accepted emit proves, and what it does not: the record is durable in the origin's journal, and the deliver carries the brief to the target, so at placement it is on two machines. Every other member receives it on its next replication sync; an emit is not proof that every member already holds it. Recovery therefore reads it from any machine that has synced since, and the reconciliation attention item reports which members' replication cursors have passed the record (`held by`, from the existing reconciler's per-peer applied position) and which have not (`not yet`, never assumed). A member that was unreachable gets the record when it returns. The replicated copy goes only to this agent's own pool machines, which already receive its commitments, preferences and topic history; it does not leave the agent.

### Gating and order

The live path is behind `multiMachine.placement.agentSessions.topicBound`, an omitted boolean resolved by `resolveDevAgentGate`: live on a development agent, dark on the fleet. It is listed in `DEV_GATED_FEATURES` and has its own ladder entry. It also requires Step 1's `multiMachine.placement.agentSessions.enabled`. Step 1's shadow log already records topic-bound would-place rows, and that log sized this step: 18 of 23 sessions were topic-bound. Many agent spawns go into a topic that already exists, which this machine may already own. This step places only topics with no live owner, so it moves only part of those 18. To measure that honestly, this step adds the topic's ownership state (`none`, `released`, `self`, `peer`) to every topic-bound shadow row, and the expected benefit is restated from that data at the dev-agent review. Releasing a topic this machine owns but no longer runs, so that it can be placed, is a separate decision for a later step if the data shows it matters.

## Alternatives considered

- **Pull-based work stealing:** idle peers pull agent work from a shared queue, so a busy origin never pushes. That removes the claim, `unknown` and launch-record handling from the push side. It is not chosen because the agent has no shared work queue today, and topic ownership, message routing and failover are all built around the fenced push protocol that person conversations already use. A second placement model for agent spawns would split one conversation model in two.

## Decision points touched

- **Whether a topic-bound `/sessions/spawn` with `placement: "auto"` starts on a peer.** — judgment-candidate. Floor: never duplicated (the fenced claim holds; an `unknown` outcome keeps the claim; the existing forwarded-message arm makes a racing message wait on an in-flight start; the local fallback is itself a checked claim; a spawn into a topic owned by a peer gets a 409). No silent failure (the inbound queue reports an undelivered or un-injected message; reconciliation plus Step 1's attention item cover an unconfirmed placement, where recovery may need a person to re-issue the work). A topic with a live owner is never re-placed. Arbiter: Step 1's `PlacementExecutor.decide` over Step 1's pre-filtered peers. No new threshold.
- **Brief size (fits one replicated record).** — invariant. basis: external-constraint; evidence: the replicated journal refuses a serialized record over `REPLICATED_RECORD_MAX_ENTRY_BYTES` = 80 KB (`CoherenceJournal.ts:439`), and the brief must be one record to reach every machine. It is the existing `TopicSpawnBriefStore` cap, so both brief copies are complete, and it is far below the 12 MB body limit. It decides only where a spawn starts, never whether: a larger prompt starts locally, exactly as today.
- **"This machine is busy" and the 10-minute reconciliation window.** — judgment-candidate. Floor: a `saturated`/`impaired` verdict or own memory pressure is always busy; a missing or stale verdict stays local; no fixed load cutoff. Arbiter above the floor: Step 1's `PlacementExecutor.decide` over peer heartbeats. Re-tuned from Step 1's shadow log, which records topic-bound rows. The window decides only when a person is told, never what is true. This step adds no threshold of its own.
- **Whose topic profile applies.** — invariant. basis: enumerable-domain; evidence: the target's forwarded-message spawn resolves the topic profile itself (`server.ts:~1818-1925`), and the profile store is replicated, so there is one profile per topic; the only other source, a request override, is excluded by keeping explicit `model`/`framework` requests local. So the target resolves the topic's replicated profile, which is the profile the origin would have used. Requests with an explicit `model` or `framework` stay local, so no override is lost.

## Frontloaded Decisions

- **Opt-in per call.** Nothing changes unless the caller sends `placement: "auto"` with a `topicId`. Making placement the default is a separate decision.
- **A placed topic belongs to the target.** After a `202`, the topic's later messages go to the target. That is the point of placing a conversation, and a placed user conversation already behaves this way.
- **`202`, not `201`, for a placed topic spawn.** The target never confirms the spawn synchronously. This is stated in the awareness entry.
- **Enablement.** `multiMachine.placement.agentSessions.topicBound` omitted → dev-gated. `migrateConfig` writes no default.

## Maturation plan

- **test-agent-live:** the two-machine throwaway rig (Studio + M5) exercises a topic spawn with `placement: "auto"` while the origin reads busy. Cases:
  - accepted: the session runs on the peer with the brief as its first input, recorded as agent-authored;
  - a forwarded `agent` message whose `originMachineId` does not match the signed sender is refused and not injected;
  - the session reads the brief as a fresh task (`agentTask` framing) and starts working, never as "the user's latest message" or a resume to wait on;
  - a busy machine that does not hold the lease starts locally with `reason: "not-router"`;
  - a peer that does not advertise `agent-brief@1` is never chosen;
  - a `workWeight: "heavy"` topic request stays local;
  - a request with an explicit `model` stays local;
  - a topic message sent during the hand-over waits and reaches the one session;
  - `unknown` keeps the claim, nothing starts locally, and the attention item names the claim;
  - a topic owned by a peer answers `409 topic-owned-elsewhere`, including when the owner is unreachable;
  - a rejected deliver falls back to a checked local claim plus a direct spawn (`201` only on a running session), and a lost local claim answers `409` with nothing started;
  - a retried deliver is deduplicated by the receipt and starts nothing;
  - a brief the journal refuses as oversize starts locally (`prompt-too-large`), including one whose JSON escaping pushes it over;
  - a placed brief is readable from a third machine's replicated copy, and a refused emit keeps the spawn local (`brief-not-replicated`);
  - the brief record is marked `completed` (not deleted) when the placed session ends;
  - a topic-bound spawn WITHOUT `placement: "auto"` into a peer-owned topic gets 409 when `topicBound` is on, and is unchanged when it is off;
  - load 0.6 with an idle peer can place; a `saturated` verdict at load 0.5 is busy; a stale verdict stays local; an equally loaded peer is not chosen;
  - the attention item lists holders from replication cursors and marks the rest `not yet`;
  - a same-name retry is read-only.

  Recorded as a PASS/FAIL matrix in the PR.
- **dev-agent-live:** on Echo once the rung passes, for the stewardship, review and spec-round spawns whose prompts are location-independent.
- **fleet:** only after the maturation-board review; until then `topicBound` stays dev-gated.
- **graduation criterion:** a maturation-board judgment weighing the inputs below. The counts are inputs to that judgment, not gates.
  - live topic placements on Echo;
  - duplicates (a topic with two live sessions, checked 10 minutes after each placement on every pool machine);
  - topic messages that went to the wrong machine;
  - `unconfirmed` outcomes, each of which holds a topic for a person to decide;
  - failed-start notices;
  - the change in Studio session count while peers had room.

  Early-review triggers: any duplicate, any misrouted message, more than 3 `unconfirmed` outcomes in a week, or 50 live topic placements.
- **dark-window:** if neither the rung nor 50 placements happen by 2026-12-15, the board entry records why and a new date.
- **ladder:** multiMachine.placement.agentSessions.topicBound

## Multi-machine posture

**Why local stays the default.** A topic spawn travels only when its caller sends `placement: "auto"`. Only the caller can know that its prompt is location-independent, meaning it names no local file and expects no local result. A default that moved spawns whose prompts point at local files would silently break them. This is the same reason Step 1 is opt-in, and making placement the default is a separate decision once callers have migrated (Frontloaded Decisions).

**Single-machine survivability.** With one machine, or no pool, every spawn is local, exactly as today. If the target machine goes away after it has accepted the topic, the topic is an ordinary owned conversation there, and the existing session-pool failover re-places a topic whose owner machine is gone, the same way it does for a person's conversation.

The work itself must survive that too. The brief is replicated to every pool machine before the deliver (see "The brief on every machine"), so if the target is lost, any surviving machine holds the brief, the topic id and the target machine. The attention item from Step 1's reconciliation names them, so the work can be issued again from any machine's copy, even after the origin and the target are both lost. The topic's own message history carries the conversation, as for any failed-over topic. What is lost is only the target session's unsaved in-flight state, which is the same loss as when a machine running a person's conversation dies today.

**unified decision.** The decision reads the pool's capacity heartbeats on whichever machine receives the request, and the claim is the shared topic-ownership record, so the decision is consistent across machines. The placed session is an ordinary topic session on the target. The audit rows are per machine by design, as in Step 1.

## Tracked follow-through

Step 4 (CMT-1938) stays as tracked in the parent spec. Nothing new is deferred by this step.

## Accepted conformance flags

- **Judgment Within Floors**: resolved at approval (Chief of Staff fold-in 2) and re-check. The size is the journal's own enforced record limit on the serialized record, with no separate number. The busy floor is only verdict and memory, and Step 1's `decide` judges load above it, with no fixed load cutoff. The 10-minute window only decides when a person is told, never what is true.

- **An Instar Agent Is Always a Multi-Machine Entity**: resolved at approval (Chief of Staff fold-in 1). The brief is replicated to every pool machine as a `topic-spawn-brief` record. Accepted remainder from the re-check: an emit is not all-member receipt. At placement the brief is on the origin and the target; other members hold it after their next sync. The attention item reports actual holders from replication cursors, never assumes them. Blocking placement on all-member receipt would let one sleeping laptop stop all placement.
- **Judgment Within Floors** (re-check, size): a brief larger than one replicated record could in principle travel as several records. Accepted: that needs a new multi-record assembly protocol with its own partial-receipt cases, and a larger brief loses nothing, because it starts locally exactly as today. Splitting is for Step 4's review if the shadow log shows large briefs being kept local often (the shadow row records `prompt-too-large`).
  - Reviewers may overrule this. A replicated brief store is the alternative, at the cost of that spread.

## Rollback

Set `multiMachine.placement.agentSessions.topicBound: false` and restart, or revert. Topics already placed stay on their machines, as any placed conversation does. Callers that never send `placement: "auto"` with a `topicId` are unaffected.

## Open questions

*(none)*
