---
title: "Dashboard New Session: choose the machine"
slug: "dashboard-new-session-machine-choice"
author: "echo"
requested-by: "Justin (Telegram topic 112490, 2026-10-18 19:13 PDT)"
parent-spec: "dashboard-door-model-controls.md"
parent-principle: "Structure beats Willpower"
parent-principle-fit: "The machine choice is written as a durable placement pin and the session is started through the router's own placement path, so routing (not a person remembering to move the topic afterwards) puts and keeps the session on the chosen machine."
eli16-overview: "docs/specs/dashboard-new-session-machine-choice.eli16.md"
review-convergence: "2026-10-19T20:18:41.461Z"
review-iterations: 9
review-completed-at: "2026-10-19T20:18:41.461Z"
review-report: "docs/specs/reports/dashboard-new-session-machine-choice-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
approved: true
approved-by: "Justin — Telegram topic 112490, 2026-10-18 21:51 PDT: \"please enter a 24 hour autonomous session until this feature is fully tested and deployed\" (pre-approval of the build and ship; convergence report delivered to the same topic)"
frontloaded-decisions: 13
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Dashboard New Session: choose the machine

> Vocabulary (from the parent spec and the session-pool spec): a **door** is an agent
> framework (Claude Code, Codex…); the **lease holder** is the one machine currently
> routing conversations and placing new topics; the **seam** is the parent's
> `sessionPoolLocalClaim` answer (`dark` / `not-authoritative` / `ready`); a **pin** is
> the durable "this topic belongs on machine X" record; **ownership** is the per-topic
> record (`placing` → `active` → `released`) that decides which machine runs it.

## 1. Problem

The dashboard New Session box picks the platform, the door (framework) and the model
for a new Telegram topic (`dashboard-door-model-controls.md`). It cannot pick WHICH of
the agent's machines runs the topic. Today a dashboard-created topic always starts on
the machine that holds the serving lease (the only machine allowed to place new topics,
§3.3 step 2b of the parent spec). To run it elsewhere the operator must create it, then
move it (`POST /pool/transfer` or "move this to <nickname>"), which spawns a session on
the wrong machine first and then closes it.

## 2. What already exists (reused, not rebuilt)

- `GET /pool` — every machine's `machineId`, `nickname`, `online`, `quotaState`, plus
  `router.holder` / `router.holdsLease`. The dashboard Machines tab already reads it.
- The placement pin: `setPinWithOneHlc` (`src/core/TopicPinMutation.ts`) — the ONE
  pin funnel that the transfer route uses; it replicates the pin when pin replication
  is live and is honored by the router on every later message.
- Ownership CAS (`SessionOwnershipRegistry.cas`) with `place` then `claim` for a target
  machine, journaled via `emitPlacement` — exactly the "place half" of
  `POST /pool/transfer` (coherence finding #5): it lets the target prove ownership.
- Router placement + forwarding: `SessionRouter.route()` places a never-seen topic on
  the machine its pin names, then `spawnOnMachine` sends that machine a signed
  `deliverMessage`; the target's owner-side bridge (`onAccepted`) spawns the session.
- Topic-profile transfer-follow (TOPIC-PROFILE-SPEC §5.3): when the target accepts its
  first forwarded message it pulls the topic's profile (door/model) from the previous
  owner named in the placement journal (`prevOwner`).

## 3. Design

### 3.1 Request

`POST /sessions/create` accepts one new optional body field:

- `machine?: string` — a machine nickname (case-insensitive) or a `machineId`.
  Absent, empty, or `"auto"` ⇒ today's behavior exactly (Automatic).

### 3.2 Validation — before anything is created

A `machine` value is a placement write, so it ADDS the `X-Instar-Request: 1` intent
requirement to the route (today the header is required only for a door/model pick;
`POST /pool/transfer` requires none — this is stricter than transfer, deliberately: a
create with a pick also creates a Telegram topic and a profile, the parent's two
intent-gated side effects, so the pick inherits the parent's gate; tightening transfer is
out of this spec's scope). The dashboard sends the header on every create. Without it ⇒ 403.

Evaluated after the name check and BEFORE the Telegram topic is created, so a refusal
creates nothing. For a REMOTE pick, the parent's creator-local door/model availability
validation is REPLACED by the target pre-flight (§3.4 step 0) — a door installed only on
the target is accepted; the creator never refuses it:

| Condition | Response |
|---|---|
| `machine` is not a string, or longer than 128 chars | 400 `machine-invalid` |
| platform resolves to anything but Telegram, or Telegram is not connected | 400 `machine-needs-telegram` |
| the parent's placement seam (`sessionPoolLocalClaim`, §3.3 2b) answers `dark` | 400 `machine-choice-unavailable` |
| the seam answers `not-authoritative` | the existing 409 `placement-not-authoritative-here` (unchanged) |
| the name/id matches no machine in the holder's capacity view | 404 `unknown-machine`, with the known nicknames (an id the holder does not know is unknown — it is never accepted on trust) |
| the machine is known but not `online` | 409 `machine-offline`, naming it — never placed elsewhere, no confirm path |
| the machine's `clockSkewStatus` is `suspect-clock-removed` | 409 `machine-clock-suspect` — the same threshold as placement (pool spec L2 removes only that status; a `divergence-detected-once` machine is still placeable, so it is still pickable) |
| the target's pre-flight (step 0) answers 401/403 — it holds a different API token | 502 `machine-unreachable`, `reason: 'peer-auth'`, nothing created (see step 0) |

Status classes follow the parent saga, not HTTP purism: every step that fails AFTER a
side effect answers 502 with `step` (the parent's `step: 'create-topic'` shape), so a
client reads `code` + `step`, never the class alone; refusals BEFORE anything is created
are 400/404/409 by cause.
| this server's start seam is not wired (`startSeamWired()` false — the boot window before the router block bound it) | 400 `machine-choice-unavailable`, `reason: 'start-not-wired'` |
| the target does not answer the signed mesh probe (step 0) | 502 `machine-unreachable`, `reason: 'mesh'`, nothing created |
| a REMOTE machine that does not advertise `seamlessnessFlags.dashboardCreateReceive` | 409 `machine-needs-update` (an older peer, or one that cannot run the owner-side branch, would start the session on its default door or not at all) |
| pin replication (`ws13PinReplicate`) is not live on this machine, or the replicated-record emitter is not wired | 400 `machine-choice-unavailable`, `reason: 'pin-replication-dark'` (a router-local pin would be lost on a lease move) |

The availability decision reads the SEAM'S ANSWER, never the presence of objects: the
router object exists on every agent with a mesh identity even when the pool is dark,
so object-presence is the fail-open inversion the parent spec names. `ready` (router
live AND placement replication on AND this machine holds the lease) is the only answer
that proceeds.

A quota-blocked target is ALLOWED (an explicit choice wins, as a hard pin does in
placement — `pinned-machine-quota-blocked`) and the response carries the notice
`machine-quota-blocked`.

Resolution is a pure function `resolveCreateMachineChoice()` in the new module
`src/core/dashboardMachineChoice.ts`, over `{ machine, selfMachineId, capacities }`,
returning `auto | self | remote | error`. It reuses `buildRelocationNicknameSet` /
`resolveSelfNickname`, the resolver behind "move this to <nickname>". Nicknames are
pool-unique (a case-insensitive collision is rejected by `MachineIdentity.updateNickname`),
so a name resolves to at most one machine; a machineId always resolves exactly. So a name that
works for a move works here. The clock and capability checks are applied by the route
on the resolved capacity.

A reused topic (a topic with the same name already exists) with ANY machine pick
⇒ 409 `topic-exists` — a machine choice never moves an existing topic.

### 3.3 Choice = this machine (`kind: 'self'`)

The parent's create saga runs unchanged (create topic → claim → seed → spawn →
register). Additionally, right after the claim placed ownership here (NEW topics only),
the topic is pinned to this machine through `setPinWithOneHlc` with
`pinnedBy: { kind: 'agent', sessionRef: 'dashboard-create' }`, so a deliberate choice
is not load-balanced away later. The pin is kept even if the spawn fails (it is the
operator's explicit intent; the next message places the topic here).

### 3.4 Choice = another machine (`kind: 'remote'`) — starts NOW, on the target

The remote path SKIPS the parent's local claim (2b's `place(self)`), local seed and
local spawn: ownership is placed straight on the target, so this machine never holds a
`placing@self` record for the topic and never writes the topic's profile.

0. **Pre-flight on the target, before anything is created.** First, ONE signed
   read-class mesh probe to the target — the existing `session-status` MeshRpc command,
   which any registered peer may issue and answer — on the SAME plane the start (3b)
   will ride. No answer within 5 s ⇒ 502 `machine-unreachable`, `reason: 'mesh'`,
   nothing created: a target reachable over HTTP but not over the mesh is refused
   here, never pinned in `unknown`. Then, when a door/model is to be
   applied (the explicit pick, else the dashboard new-topic default), this machine asks
   the TARGET to validate it: `POST <peer>/topic-profile/validate-choice`
   `{ framework, model }` (Bearer, intent header) → the target runs the parent's
   `validateDashboardProfileChoice` against ITS OWN doors and models. An explicit pick
   the target refuses ⇒ the create is refused with the target's own code and text
   (`step: 'validate-on-target'`), nothing created. A refused DEFAULT is dropped (the
   target starts on its own defaults) and the response says so
   (`notices: ['default-not-available-on-target']`). The target unreachable ⇒ 502
   `machine-unreachable`, nothing created. The dashboard's Door/Model lists for a
   remote pick come from the same machine: `GET /topic-profile/options?machine=<id>`
   proxies to the target's options (keeping this machine's new-topic default).
1. Create the Telegram topic (the parent saga's create step).
   *Note: the pin is written AFTER placement (step 3d), so an ownership reconciler that
   adopts a replicated pin can never race the placement and take the record first.*
2. Re-check the seam is still `ready` (the lease may have moved since the start). If
   not ⇒ 409 `placement-not-authoritative-here` with `topicId`, `step: 'place'` (the
   parent's shape). Nothing was placed, so the pin is written here (it cannot race a
   placement): the new lease holder places the topic's first message on the target. The
   response carries `pinned: true|false` and says so.
3. Start on the target through the new seam method
   `startTopicOnMachine(topicKey, targetMachineId, start, pin)` on the topic-profile
   context (implemented in `server.ts` next to the router, sharing its ownership
   registry, nonce stream and `emitPlacement` journaling — no new CAS site in routes):
   a. `place(target)` CAS (refused unless the record is never-seen/released ⇒ 409
      `topic-owned-elsewhere`, nothing sent).
   b. A CHECKED `deliverMessage` to the target over the signed mesh — retried with
      the SAME messageId only when the attempt THREW (transport error / timeout; up to
      2 extra attempts, short backoff), the router's own L4 discipline, safe because
      the target's receipt ledger answers `duplicate` for a copy it already recorded;
      a reply that reached the target (5xx / 408 / no ack) is not retried, since the
      target may be mid-start — with
      `ownershipEpoch` = the placed epoch and payload
      `{ dashboardCreate: { framework, model, source, machineNickname } }` and no text.
      The ONE normative acknowledgement table (`classifyDeliverReply`): `queued` (recorded
      first-seen) or `duplicate` (already recorded) = accepted — proof of durable RECEIPT,
      not of a running session; `stale-ownership`, `sender-rejected`, or a 4xx other than
      408 = rejected; a throw, timeout, 408, 5xx or no ack = unknown. Note the pre-flight
      (step 0) uses Bearer HTTP and the start uses the signed mesh: a target reachable on
      one and not the other passes the pre-flight and lands on `unknown`, which the
      response reports honestly. The pre-flight's HTTP plane is the one every pool-scope
      read already uses — `resolvePeerUrls` plus THIS machine's `authToken` sent as a
      Bearer to the peer with the `X-Instar-AgentId` header (one agent: the same id on
      every machine; the peer's auth middleware requires it), exactly as `GET /sessions?scope=pool`, `GET /guards?scope=pool`
      and the parent's `GET /topic-profile/options?machine=` reach a peer. The pool spec
      (L0) is explicit that each install holds its OWN token and that the signed mesh
      cannot be gated on a shared one; the HTTP read plane works only where an operator
      has given the pool's machines the same token (Echo's pool: every pool view answers
      `peersOk` for all three peers, measured 2026-10-19). Where tokens differ, those
      views already report the peer as `failed`, and here the pre-flight's 401/403 is a
      distinct refusal (`machine-unreachable`, `reason: 'peer-auth'`, nothing created) —
      never a start on an unchecked door. The mesh plane itself is covered by step
      0's `session-status` probe (no new command class), so a pre-flight pass means
      both planes answered; the residual half-reachable case (the mesh drops between
      the probe and the start) is named in §4. A target with no address in `resolvePeerUrls` is a local,
      definitive refusal (`rejected`, "no peer url") — the one entry in the table that
      the creator decides. (The router's own `spawnOnMachine`
      discards that result; this path does not use it and does not go through the
      router's inbound queue, so the start command can never be re-delivered later as
      a JSON string typed into the conversation.)
   c. Settle by the deliver outcome (`classifyDeliverReply`). The CREATOR performs the
      claim on the target's behalf — exactly as the router's own `confirmClaim` does for
      every first-message placement today (the target never claims for itself in the
      parent either; §2's "lets the target prove ownership" is the FSM's shape, the
      router is its driver). Every settlement CAS result is checked: the claim is
      retried once if it lost while the record still reads `placing@target`. If it
      still fails, the record is read and judged by this placement's GENERATION, not
      by machine: the `place` landed at epoch E, and the ONE transition that confirms
      it is the claim at E+1 (ours, or the router's concurrent confirm) — every
      registry CAS bumps the epoch by exactly one (`SessionOwnership` §"per-session CAS
      at ownershipEpoch+1"). Two cases:
      - **superseded** — the record is not this generation: another owner, a NEWER
        placement onto the same target (a different epoch), or `released`. The newer
        record stands. Nothing is claimed, released, pinned or posted from here — a
        late rejection can never release someone else's placement; the response is
        202 `ownership: 'superseded'` with `ownerNow` (machine, status, epoch) and,
        when the start was delivered to a different owner's target, that the target
        may also start a session (the existing duplicate reconciler closes the spare).
        The `started` field is `requested`, `unknown` or `refused` by what the target
        was told.
      - **contention within this generation** — the record still reads
        `placing@target` at E (the response carries `notices:
        ['ownership-not-confirmed']`, the same best-effort confirm the router's
        `confirmClaim` has today), or a concurrent confirm already made it
        `active@target` at E+1, which counts as settled — and on a rejected start IS
        released (it is this placement's record).
      - **accepted** (`queued`, or `duplicate` = already recorded) ⇒ `claim(target)`.
      - **rejected** (a 4xx from the target's verify/RBAC/freshness gate, or a
        `stale-ownership` / `sender-rejected` ack) ⇒ `claim(target)` then
        `release(target)`, so the record rests `released`, never `placing` (a resting
        `placing` record queues every later message as ownership contention) — and NO
        pin (3d): a target that refused an authenticated start may refuse every
        forwarded message the same way, so pinning it would strand the topic.
      - **unknown** (a throw, timeout, 408 from an intermediary, 5xx, or a missing ack — the target MAY have
        accepted and started it) ⇒ `claim(target)` and KEEP it. Releasing would deny a
        possibly-live session its ownership record; keeping it means the topic's next
        real message is forwarded to the target, which injects into the live session or
        spawns one. A transport failure is never read as "did not start".
   d. Pin the topic to the target (`setPinWithOneHlc`, `pinnedBy` as in §3.3) on an
      ACCEPTED or UNKNOWN start only, right after the claim — never after a rejection
      (released AND unpinned, so the next message is placed by the ordinary rules; the
      502 says so and the operator may pick the machine again once it accepts starts),
      never on `topic-owned-elsewhere`. The seam calls the pin before it returns, so an
      accepted or unknown start does not leave the topic owned-but-unpinned — except
      for a creator crash in the window between the claim CAS and the synchronous pin
      write (microseconds): the topic is then owned by the target and unpinned, which
      is the ordinary state of every router-placed topic (placement without a pin);
      only the explicit pick's "keep it here" is lost, and the pin is one dashboard
      tap away. A pin failure is reported (`notices: ['machine-pin-not-written']`),
      never fatal — ownership already routes the topic. An ownership change AFTER a
      successful claim and before the pin is the same lease-move window every pin
      write in the pool has; the ONE-HLC funnel orders it, and a reconciler adopting
      the replicated pin re-places by its own rules.
   e. After an accepted or unknown start, post ONE fixed-template line into the topic
      from this machine. It states only what is known — an assignment, not a running
      session:
      - accepted: `This topic is assigned to <nickname>; its session is starting there.
        Requested: <door · model>.`
      - unknown: `This topic is assigned to <nickname>. No confirmation came back that
        its session started — send a message here and it goes to <nickname>.
        Requested: <door · model>.`
      (The `Requested:` sentence is omitted when no door/model applies.) It describes
      the placement this machine (the router, the conversation's placement authority)
      just made; the target posts only corrections (4c). After a refusal nothing is
      posted (the 502 carries the whole story). The nickname goes through `safeMachineLabel` (the rename pattern, else the
      machineId); sent through the existing deterministic producer
      `topic-profile-creation-seed`, never the LLM gate; a failed send is recorded in
      `notices`, never fatal. Why not the target, which owns the topic after 4c: origin
      egress forwards only ORDINARY sends from a machine that does not hold the lease to
      the holder, so a deterministic notice from the target can sit held; the creator's
      line is the one that reliably arrives. The target's corrections ride that same
      path and, if held, surface through the existing held-send record and its single
      attention item — never silently.

   The step-3 state machine in one table (what the registry and pin store hold when the
   seam returns):

   | Deliver outcome | Ownership record | Pin | Line | Response |
   |---|---|---|---|---|
   | accepted | `active@target` | written | assigned + starting | 201 `started: 'requested'` |
   | unknown | `active@target` (kept) | written | assigned, no confirmation | 202 `started: 'unknown'` |
   | rejected | `released` | none | none | 502 `start-remote-failed` |
   | any, claim lost twice, record still THIS generation | as the registry left it (`placing@target`@E, or `active@target`@E+1 by a concurrent confirm = settled) | written unless rejected | as above | the above status plus `ownership-not-confirmed` when still `placing` (202 for accepted/unknown) |
   | any, claim lost, record is another generation (other owner, newer placement on the same target, or released) | that record, untouched | none | none | 202 `ownership: 'superseded'`, `ownerNow`, `started` = requested / unknown / refused |
   | place refused | untouched | none | none | 409 `topic-owned-elsewhere` |

   Why the target may act while the record reads `placing`: this is the router's own
   first-message choreography, verbatim — `SessionRouter.route()` does `place` →
   `spawnOnMachine` (the deliverMessage) → `confirmClaim` (src/core/SessionRouter.ts,
   the three calls in that order), so every first message on a remote machine today
   is injected or spawned by a receiver whose record the router confirms AFTER the
   delivery. The pool's "workers run only as active owners" invariant is satisfied
   the same way here: the receiver's `onAccepted` validates the envelope's epoch
   against its own view (a stale epoch is `stale-ownership`), and the claim lands
   before the response returns. No new authorisation to launch is introduced.
4. On the target (owner-side `deliverMessage` `onAccepted`, new branch, evaluated
   FIRST — before the working-set and profile-carrier pulls, which have nothing to
   pull for a brand-new topic and are skipped for this branch; the seed is the only
   profile writer). The branch fires for every command with a payload OBJECT accepted by
   `parseDashboardCreatePayload` (never a string — so no queued or typed text can trigger
   it) under a messageId `dashboard-create:<this topicId>:…`, independent of whether a
   session exists: a control command never falls through into conversational injection.
   When a live session already exists the runner audits `session-already-live` and does
   nothing else. A re-delivered command is answered `duplicate` by the receipt ledger
   before `onAccepted`, so it never runs twice. The command's durable inbound receipt is marked
   injected only AFTER the start has run (seed and spawn attempted, outcome audited, any
   failure posted in the topic), so the inbound queue never reports a completed start as
   a lost user message. When the durable inbound queue is live on the target, a crash
   mid-start leaves the receipt unsettled and it is reported through the queue's existing
   "possibly not injected" notice; when the queue is dark (its own rollout flag — the
   capability flag does not require it) the receipt is the message ledger and a crash
   mid-start is not reported. The seed is the durable half: a crash after it means the
   next message spawns on the requested door. A crash BEFORE the seed is the known gap:
   ownership rests on the target, the topic is pinned there, the creator's line stands as
   a request, and the next message starts the session on the target's default door; the
   operator re-applies the door from the session view. A durable per-command execution
   ledger with replay would close it; it is out of proportion for a dashboard create whose
   whole effect is one profile row and one spawn. It is tracked as evolution action
   ACT-127 (durable replay of an accepted start after a receiver crash, or retire this
   note with evidence; due 2026-11-02), not left as prose. Then:
   a. seed the profile with `seedTopicProfileAtCreation` (when framework is present),
      re-validated on the target (a race between pre-flight and start), with its
      disclosure suppressed (the creator posts the line at step 3e);
   b. spawn — AFTER the seed settles — with no initial message (`silentStart`) through
      the parent's `createSpawnForTopic` (the `spawningTopics` guard + binding
      registration). The whole start (seed AND spawn) is marked in a per-topic
      in-flight set from the moment the branch fires until it settles. An ordinary
      forwarded message for the same topic that arrives while the topic is in flight
      (or held by the spawning guard) waits, bounded (60 × 1 s), then: a live binding ⇒
      injected; the start finished without binding ⇒ the ordinary forwarded spawn runs
      (the message is never dropped); still in flight after 60 s ⇒ reported through the
      inbound-queue error path (`dashboard-create-start-did-not-bind`), never a second
      spawn while the first is still running. The wait runs as a detached per-message
      task, so it never blocks the deliver handler or other topics; one such task exists
      per waiting message, each bounded at 60 s, and the number of waiting tasks on
      the whole machine is capped (32); a message past the cap takes the inbound error
      path at once (`dashboard-create-start-wait-capacity`). "Reported" means the
      durable inbound queue's error path: with the queue live the message is retried
      or its loss is told to the user; with the queue dark the parent's existing
      posture applies to every forwarded-inject failure, this one included — a log
      line only. The same qualification as the step-4 crash case;
   c. corrections, posted by the owner through the same producer and audited (a
      refusal stays a refusal): the seed refused in the race (`The chosen door could not
      be applied on <nickname> (<reason>); this topic starts on its default door.`), the
      seed applied the door but the write regime dropped the model (`The chosen model is
      not applied on <nickname> (<regime>); …`), or the spawn failed (`Couldn't start
      this session on <nickname>: <reason>. Send a message here to try again.`), or the
      session started but its binding could not be registered (`The session started on
      <nickname> but could not be bound to this topic; your next message here starts a
      fresh session there.` — the orphan is named, never silent). A spawn
      answered `topic-has-session` / `topic-spawning` posts nothing — a session exists or
      is starting — and is audited only.
   The branch body is the core factory `createDashboardCreateStartRunner` (in
   `src/core/dashboardMachineChoice.ts`), so the e2e drives the same code server.ts wires.
   The branch runs regardless of the receiver's pool stage: a start the receiver already
   accepted is honored (the capability flag already excludes a dark stage at create time).
   The topic-profile context is reached through a hoisted late-bound reference (it is
   constructed after the deliver handler is wired); when it is still null the seed is
   skipped and audited, and the spawn proceeds on the target's defaults.
5. Respond 201 after an accepted start; 202 `started: 'unknown'` (same body plus an honest
   `error` line: "No confirmation came back from <nickname>, so the session may or may not
   have started there. Send the topic a message: it goes to <nickname> either way. If the
   start never arrived, it begins on that machine's default door and model.") after an
   unknown one. The 201 body:
   `{ ok: true, session: null, topicId, name, platform: 'telegram', machine: { machineId, nickname },
     started: 'requested', profileRequested: { framework, model } | null, profileValidatedOn: <machineId>, notices }`.
   `profileRequested` is what was requested and pre-validated on the target — not proof it
   was applied (the target's write regime may still drop the model; the done-bar check
   reads the running session's model from the peer).
   `session` is null because the tmux name is chosen on the target; the session shows
   in the pool sessions view (`GET /sessions?scope=pool`).

The capability flag `seamlessnessFlags.dashboardCreateReceive` is advertised only by a
machine whose pool stage is not dark AND that has Telegram configured AND whose
topic-profile context is wired — i.e. exactly when the owner-side branch can run.

Failure table for the remote path (the Telegram topic is never deleted — parent rule):

| Step that fails | What is kept | Response |
|---|---|---|
| 0 target refuses the explicit pick / unreachable | nothing | 400/409 target's code, `step: 'validate-on-target'` / 502 `machine-unreachable` |
| 1 topic create | nothing | 502 `step: 'create-topic'` (parent) |
| 2 lease moved | topic, pin (unplaced; `pinned: false` when the pin write failed, and the text then says to move it) | 409 `placement-not-authoritative-here`, `step: 'place'`, `topicId`, `pinned`; the first message starts it on the target when the pin is held |
| 3a place refused | topic (unpinned) | 409 `topic-owned-elsewhere`, `step: 'place'` |
| 3c claim lost twice, record still on the target | topic, record as the registry left it (possibly `placing`); pin unless rejected | 202 `ownership: 'not-confirmed'` (or the 502 with the notice on a rejected start), with the plain recovery: move the topic if its messages go unanswered |
| 3c claim lost, record is another generation | topic; that record untouched; no pin; no line | 202 `ownership: 'superseded'`, `ownerNow`; send a message and it goes to the current owner |
| 3b deliver definitively rejected | topic (UNPINNED); record `released`; no line posted | 502 `step: 'start-remote'`, `topicId`, `notices`: <nickname> refused to start it; the topic is not pinned — send it a message and ordinary placement starts it, or pick <nickname> again once it accepts starts; the chosen door/model was not applied |
| 3b deliver outcome unknown | topic, pin (3d); record `active@target`; the unknown line posted | 202 `started: 'unknown'` with the honest text |
| 3d pin write | topic, ownership@target | continues; `notices: ['machine-pin-not-written']` |
| 3e line send | topic, pin, ownership@target | continues; `notices: ['machine-notice-not-sent']` |
| 4 seed refused / spawn failed / session unbound on the target | topic, pin, ownership@target | the 201 already returned; the owner posts the fixed line in the topic (4c) |
| 4 target crashes before the seed | topic, pin, ownership@target; no profile | the 201 already returned; reported by the inbound queue when live, else unreported; the next message starts on the target's default door (the known gap named in step 4) |

### 3.5 Dashboard

A `Machine` select in the New Session box, below Model:

- Options: `Automatic` (default), then every machine from `GET /pool`, labelled by
  nickname. The machine serving the page gets `(this machine)` — `GET /pool` gains an
  additive `selfMachineId` field so the page compares against its own server, not the
  lease holder. Offline machines are present but `disabled` with `(offline)`; a
  `suspect-clock-removed` machine is `disabled` with `(clock out of step)` — a distinct
  label, since the remedy differs; a quota-blocked machine gets `(at usage limit)`.
- Hidden when `GET /pool` fails or lists fewer than two machines, and when the
  platform select is Slack or Headless.
- Refreshed on every open of the box; one request in flight, a late response for a
  closed box is ignored.
- The response discriminator the page reads, in order: `ownership` of `superseded`
  or `not-confirmed` ⇒ a warning toast with the server's `error` sentence (ownership
  unsettled — send a message); else `started: 'unknown'` ⇒ a warning with the
  server's `error` line; else `started: 'requested'` ⇒ `Starting "<name>" on
  <nickname>.`; else the ordinary created toast. Every 4xx/5xx shows the server's
  text verbatim in the box.
- The remote machine's door/model list replaces this machine's list only while the box
  is open on a remote pick; closing the box, creating, switching to Automatic or to a
  non-Telegram platform restores this machine's own list, so no other screen sees it.
- Server error text is shown verbatim in the box's error note (existing pattern).
  All strings are set with `textContent` / `option.text` (never HTML).

### 3.6 Agent awareness + migration

`generateClaudeMd()` gains one sentence in the Topic Profile "Dashboard door + model
controls" bullet naming the Machine choice and the `machine` body field.
`migrateClaudeMd()` patches existing agents' CLAUDE.md idempotently (inserted after the
door + model line), sniffing for `- **Dashboard machine choice**`, which is also added to
the framework shadow-slice marker list.

## 4. Safety

- No new authority surface: the remote start is the router's ordinary first-message
  path over the existing signed `deliverMessage` (RBAC: only the router holder may
  send it). The new owner-side branch only seeds a profile when none exists
  (`mutateIfAbsent`), validated locally, then spawns — what any forwarded first
  message already causes.
- Never silently elsewhere: unknown, offline, clock-suspect and not-updated machines
  are refused before anything is created; Automatic is the only path that lets
  placement choose. The refusal is a create-time check: if the target later goes dark,
  the existing owner-dark / stale-owner machinery handles the topic like any other.
- The half-reachable target (HTTP reachable, mesh not) is refused by step 0's mesh
  probe before anything is created. The residual case is a mesh that drops between
  the probe and the start (seconds): the start lands on `unknown`, the topic is pinned
  and owned there. Every later message forwards
  over the same mesh and fails the same way — which is exactly the condition the
  existing machinery reads: the owner-dark ladder posts its honest "that machine is not
  reachable — resend in a few minutes" notice for the topic, and the stale-owner release
  (U4.2) measures unreachability on EVERY owner-authenticated transport before it
  force-claims. Until one of those acts, the operator's levers are the ordinary ones:
  `POST /pool/unpin` and "move this to <nickname>". No new un-stranding mechanism is
  added, and none is claimed.
- Never moves an existing topic: a reuse with a machine pick is refused.
- Rollback: omit `machine` (the dashboard sends nothing on Automatic); reverting the
  release removes the field. Pins written by this feature are ordinary pins,
  clearable with `POST /pool/unpin`.

## 5. Tests

- Unit: `resolveCreateMachineChoice` — auto/empty/"auto"; nickname case-insensitive;
  machineId; self (also when the capacity view omits self); remote; unknown id/name
  (404 + list); offline (409); quota-blocked flag; non-string / oversized (400).
- Unit: `startTopicOnMachine` core (pure over injected ownership/deliver deps, with the
  registry and delivery outcomes scripted per test — a lost claim, a record the registry
  moved under the seam, a throw mid-deliver) —
  accepted = place→deliver→claim→pin with the placed epoch; rejected ⇒ place→claim→release
  and NO pin, record `released`; unknown ⇒ place→claim→pin, record kept `active@target`;
  a claim lost to another generation (other owner, OR a newer placement on the same
  target at another epoch) ⇒ `start-superseded`, no pin, nothing released; a claim
  lost to a concurrent confirm of THIS generation (`active@target`@E+1) on a rejected
  start is still released;
  `classifyDeliverReply` maps 4xx/stale/sender to rejected and throw/5xx/no-ack to unknown; a pre-existing record
  ⇒ refused before any send. The owner-side `parseDashboardCreatePayload` accepts only a
  well-formed object (never a string, never extra text).
- Integration (HTTP): `/sessions/create` with a fake Telegram + seam ctx — remote pick
  pre-flights the target, pins the target, calls `startTopicOnMachine` with the
  target-validated profile, never claims, seeds or spawns locally, returns
  `started: 'requested'`; target refusal of an explicit pick creates nothing; self pick
  pins self and spawns; offline / unknown / clock-suspect / needs-update / non-Telegram /
  seam-dark / pin-replication-dark / peer-auth / mesh-probe / start-not-wired refusals
  create no topic; a
  `divergence-detected-once` target is accepted; a superseded start ⇒ 202 with no pin
  and no line; `machine: 'auto'` behaves
  exactly like omission; missing intent header → 403; reuse → 409; start failure → 502
  with the record released.
- Integration (owner side): `POST /topic-profile/validate-choice` answers the parent's
  validator verdict; `GET /topic-profile/options?machine=` proxies to the peer. The
  `dashboardCreate` branch seeds, posts the owner line, spawns silently; a seed refusal
  posts the fixed line and the session still starts.
- E2E: two real AgentServers sharing one ownership registry — a holder-created topic
  runs on the target with the target-validated door/model, read from the target's
  `GET /sessions`; the start core and the owner-side runner are the real factories, the
  signed-mesh hop is a stand-in (no in-process two-server mesh harness exists). The
  shared registry is deliberate: the e2e proves the live wiring end to end; the
  orderings a split registry would exercise (a claim lost to a lease move, delivery
  outrunning placement, a receiver restart) are the scripted unit cases above, and
  journal propagation is the parent's already-tested path — a deterministic two-registry
  harness would re-test the parent, not this feature. Said plainly: the live drive
  below is the FIRST integrated traversal of journal replication plus the signed-mesh
  `dashboardCreate` hop; it is the done bar for that reason, and the graduation
  criterion keeps measuring it for a week. On a
  single-machine server the route answers `machine-choice-unavailable` (not 500); the
  dashboard HTML ships the Machine select.
- Wiring (source-parse, the composition-root convention): server.ts builds the start
  seam beside the router with a checked deliver (never `spawnOnMachine`/`queueMessage`),
  runs the owner branch first, guards seed+spawn, and advertises the capability flag only
  when the branch can run.
- Live (the done bar): create a topic on a named peer from the dashboard; that peer's
  `GET /sessions` lists a running session bound to the topic with the requested
  model — read from the peer, not inferred from `GET /pool/placement` (the ownership
  record is a symbol of the state, the running session is the state).

## Maturation plan

- **test-agent-live:** the resolver, `startTopicOnMachine`, the owner-side runner, the
  two helper routes and the `/sessions/create` branch are unit/integration/e2e-tested on
  throwaway servers from the first build (§5); no live machine is needed to exercise
  every outcome of the step-3 table.
- **dev-agent-live:** live on Echo with the release (the Machine select is additive and
  hidden on a single-machine install; the remote path needs the pool not dark, pin
  replication live and a peer advertising `dashboardCreateReceive`, all already true on
  Echo's pool). The done bar is the live drive in §5: a topic created from the dashboard
  on a named peer shows a running session for it in that peer's `GET /sessions`.
- **fleet:** with the same release. On a fleet agent whose pool is dark the select is
  hidden and a `machine` pick answers `machine-choice-unavailable`; nothing else changes.
  A peer still on an older version is refused by name (`machine-needs-update`) until it
  updates, so a mixed-version pool degrades to a clear refusal, never a wrong-door start.
- **graduation criterion:** one week on Echo with zero operator-found escapes on the
  remote path, evidenced from live state: every remote-created topic in the week has its
  `dashboard-machine-start` audit row on the target with outcome `started`, its session
  in the target's `GET /sessions` on the requested door, and no 202 `started: 'unknown'`
  whose target later showed no session.
- **dark-window:** none for this surface — it is additive and ships live; its only
  dependencies are the already-graduated pin replication and pool stage flags. The one
  named gap (a target crash before the seed, step 4) is a documented limit of the
  existing receipt machinery, not a dark feature of this spec.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Resolve the requested `machine` to auto / self / remote / refusal | `invariant` | A name lookup against the live capacity list; the operator's explicit pick is the decision, so there are no competing signals to weigh. Same resolver as `POST /pool/transfer`. |
| Refuse an offline target | `invariant` | An explicit pick of an unreachable machine has exactly one honest answer (refuse, name it); the alternative (place it anyway) is the "silently elsewhere / silently dead" failure the operator ruled out. |
| Allow a quota-blocked target | `invariant` | Mirrors the existing placement rule that a hard pin wins over quota avoidance (`pinned-machine-quota-blocked`); the operator chose the machine. Disclosed as a notice. |
| Spawn locally vs start on the target | `invariant` | Determined by the resolved pick: a session may only run on its owner, and the router places ownership on the pinned target. |
| Refuse a target lacking the capability flags | `invariant` | A capability advertisement is binary; the conservative answer (refuse, name the reason) is the only one that cannot start the session on the wrong door or strand it. |
| Settle a start by its delivery outcome: accepted ⇒ own + pin; unknown ⇒ own + pin, keep; rejected ⇒ release, no pin | `invariant` | A fixed mapping from the ONE acknowledgement table onto the ownership FSM. The conservative arm on uncertainty (keep ownership, never deny a possibly-live session its record) and the conservative arm on a definitive refusal (release and leave unpinned, never strand the topic on a machine that refused it) are each the single answer that cannot lose a session or a conversation; there is no competing signal to weigh. |
| Hold an ordinary forwarded message while a dashboard start is in flight | `invariant` | A bounded wait (60 × 1 s, detached per message, per-topic keyed, at most 32 waiting on the machine) for a binding that is being created by this machine's own start; the alternative is a guaranteed duplicate session. Timeout or the cap falls to the existing inbound error path (reported through the durable queue when live, logged when dark — the parent's posture for every forwarded-inject failure), never a second spawn while the first still runs. |
| Judge a lost claim by placement generation (epoch), not by machine | `invariant` | The registry bumps the epoch by exactly one per CAS, so "this placement's claim" is one specific epoch; any other record is someone else's placement and the conservative answer is to leave it untouched and say so. |
| Refuse a target that answers HTTP but not the signed mesh | `invariant` | The start rides the mesh; a pre-flight that only proved HTTP would pin a topic into a known-unknown. One existing read-class probe makes the pre-flight predictive. |

## Multi-machine posture

- Machine choice input (`GET /pool` list in the dashboard): `proxied-on-read` — `GET /pool` already answers from the lease holder's capacity view covering every machine.
- Placement pin: `replicated` via `setPinWithOneHlc` → `ReplicatedRecordEmitter`; a machine pick REQUIRES `ws13PinReplicate` live (else `machine-choice-unavailable`), so a successor router after a lease move holds the same pin.
- Ownership record: `replicated` via the ownership CAS + `emitPlacement` coherence journal (the same path `POST /pool/transfer` uses).
- Seeded door/model profile (remote pick): carried in the start command and written on the TARGET (its owner) — never written on the creating machine; afterwards it follows the topic by the existing TOPIC-PROFILE-SPEC §5.3 transfer-follow.
- Behaviour change on every machine: an ordinary forwarded first message for a topic the spawning guard already holds now waits (bounded, 60 s) for that spawn's binding and is injected into it, instead of spawning a second session. A dashboard start's seed→spawn interval is covered by a per-topic in-flight set.
- Known shared race (not introduced here): a real message arriving at the holder between `place(target)` and `claim(target)` — the whole deliver round trip, up to the 5 s mesh timeout — is handled by the router's existing `placing` branch (queued as ownership contention, or the existing fall-through when the queue is dark), the same window every remote first-message placement has today.
- Journal posture of a refused start: the holder's record rests `released` and the topic is UNPINNED; the release is journaled with reason `released`. A peer's ownership applier materializes journal entries as records at that epoch, so a peer may see the target at the release epoch; the router's next placement at a higher epoch supersedes it.
- The "assigned to <nickname>" line: sent once by the creating machine (the router that made the placement) after the start was handed over. Corrections: sent once by the target, the topic's owner. One voice at each point. This is the Ownership-Gated Side Effects signal the gate keeps raising: the creator posts a line about a topic the target now owns. It is deliberate — the line describes the placement the router (the conversation's placement authority) just made, and the target's own deterministic sends can sit held by origin egress (step 3e names why). Agent Carries the Loop: a refused start leaves the topic free for ordinary placement (no operator step is required for the conversation to work); the only operator action left is re-choosing a machine or re-applying a door, both single dashboard taps, and the 502/202 text names exactly which.
- The door/model option list for a remote pick: `proxied-on-read` from the target (`GET /topic-profile/options?machine=`).

## Frontloaded Decisions

1. **Remote pick starts the session immediately on the target**, by a checked `deliverMessage` (the existing signed mesh verb) carrying the door/model, with ownership placed by the router-side seam — not through the router's inbound queue. (Rejected alternative: pin-only, starting on the first message — not what the operator asked for: "select what machine the new session will be running on".)
2. **Door/model are validated on the target**, in a pre-flight before anything is created; the dashboard lists the target's doors for a remote pick.
3. **Offline target is refused, with no confirm-to-place-anyway path.** (The transfer route has a confirm path for offline targets; creation does not, because a new topic has nothing to preserve by waiting.)
4. **Quota-blocked target is allowed with a notice.**
5. **Choosing this machine also pins it** (so a deliberate choice is not load-balanced away later).
6. **Reuse with a machine choice is refused** (409 `topic-exists`), never a move.
7. **Hidden on single-machine installs and for Slack/headless.**
8. **The pin's `pinnedBy` is `{kind:'agent', sessionRef:'dashboard-create'}`** — a dashboard Bearer request cannot be told from an agent call, and a brand-new topic has no bound operator (unlike transfer, which uses one when present). `pinnedBy` is local provenance only; no precedence reads `kind`.
9. **Clock-suspect and not-updated targets are refused**, with distinct codes.
10. **`GET /pool` gains `selfMachineId`** (additive) for the `(this machine)` label.
11. **The checked deliver retries a THROWN attempt (same messageId, 2 extra, short backoff) and nothing else.** (Rejected alternative: one-shot — it left transport blips in the `unknown` band for no correctness gain; the receipt ledger makes the retry safe.)
12. **The door/model pre-flight stays on the parent's Bearer HTTP route; the mesh plane is covered by the `session-status` probe.** (Rejected alternative: a new read-class mesh `validate` command — it would leave every pool view and the parent's options proxy on Bearer and add a command class for one caller. Not built: a pool whose machines hold different tokens gets the honest `peer-auth` refusal, and every pool-scope view already fails to such a peer the same way; the day such a pool exists, every one of those views needs the same answer, which is a pool-wide change, not this feature's.)
13. **502 for post-side-effect failures, as the parent.** (Rejected alternative: 409/422 by refusal kind — the parent's clients already branch on `code` + `step`.)

## Open questions

*(none)*
