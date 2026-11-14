---
title: "App conversations move between machines (part 3b)"
slug: "app-conversations-in-the-pool"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "app-conversations-in-the-pool.eli16.md"
status: "draft"
approved: true
review-convergence: "2026-11-07T01:55:00.000Z"
review-iterations: 7
review-completed-at: "2026-11-07T01:55:00.000Z"
review-report: "docs/specs/reports/app-conversations-in-the-pool-convergence.md"
approved-by: "echo, under its standing grant, for Justin's words in Telegram topic 134088, 2026-11-06 14:11 PST: \"…that conversation should be able to swap machines and engines just like any other conversation.\""
---

# App conversations move between machines (part 3b)

Part 1 (#2889) lets every conversation switch engine and model. Part 2 gives every person-started session a native app conversation. Part 3a (#2894) keeps Slack conversations with their Slack connection. This part lets an app conversation, and its session, move to another machine the way a Telegram topic moves.

## 1. Problem

A Telegram move works like this:
- It starts from `POST /pool/transfer`, from the dashboard, or from the phone's Face ID `session-move`.
- It confirms with a challenge, drains the old session (`SessionDrainRunner`, closing through `terminateWithAuthority`), pins the topic to the target, and hands ownership over through `SessionOwnershipRegistry`.
- The next message is routed to the new owner by `SessionRouter`, which starts the session there.

For an app conversation none of that applies:

1. **Ownership is all-or-nothing.** The machine holding the lease serves every app conversation:
   - `AppConversationService.isOwner()` is `holdsLease()`.
   - `ownsAlias` is `holdsLease() && isAppBound`.
   - `leaseTick` binds every conversation when the lease is gained and unbinds them all when it is lost.
   - `onReplicatedEvent` and `applyCreate` bind on `holdsLease()` directly.
2. **The phone's send doesn't route.** A machine that isn't the lease holder stores the message, then answers 503 `owner-unavailable` (`mobileConversationRoutes.ts`). Emergency stop and pause act only locally and record `intercepted` regardless.
3. **The router has no app arm.** On the receiving side, `isSlackSessionKey` is "not all digits", so a forwarded `app:<uuid>` would be rebuilt as a fake Slack message.
4. **Replies are refused off the lease.** `POST /app/session-reply` answers 409 `not-owner` unless `ownsAlias`.
5. **The plumbing is numeric-only.** These all take `Number(key)`:
   - the drain seams (session lookup, idle read, close, "moved machines" notice);
   - the escalation hint;
   - the working-set kick;
   - the profile acquire on arrival;
   - the journal's placement rows (`CoherenceJournal.emitPlacement(topic: number)`, readers filter numerically);
   - pin replication (`TopicPinMutation` skips non-numbers).
6. **Many consumers read every ownership record**, and would start acting on `app:` keys once they exist:
   - the overload shed (`ownedTopics`, `drainMove`);
   - `OwnershipReconciler`;
   - `StaleOwnerReleaseEngine`;
   - `StrandedTopicSentinel`;
   - release-on-complete.

## 2. Design

The rule behind every choice below: **an app conversation changes machine only through a completed drain, or through the operator's explicit "bring it back here". Nothing in the pool places it by itself.**
- Telegram topics have several placement paths: router placement, pins, the reconciler, and re-placement after failed forwards.
- App conversations have two, and both are operator acts.

### 2.1 Who serves an app conversation

- **The record.** An app conversation's ownership is a `SessionOwnershipRegistry` record keyed `app:<uuid>`. That is the key SpawnAdmission already uses for app spawns.
- **Who serves.** `AppConversationService.serves(key)` replaces the unkeyed `isOwner()`, which is removed so no caller keeps the all-or-nothing meaning by accident. It is true when:
  - the record is `active` and names this machine; or
  - the record is absent or `released`, this machine holds the lease, and the lease gate (2.3) is open.
- **Who replies.** `AppConversationService.mayReply(key)` is `serves(key)`, or the drain's last turn.
  - **The last turn:** the record is `transferring` from this machine, and this machine's own drain runner for that key is still running.
  - **Its bound:** the window lasts as long as the runner runs. The runner itself is bounded: hand-off, then `drainBoundMs` for the turn, then the close.
  - **Why this window:** it is the window the drain waits for the turn to finish so its reply can land. `mayEmit`'s 1-second `cutoffMs` would drop that reply.
  - **Why it can't overlap:** the target's claim lands only after the drain's close, so the source's window and the target's service can't overlap.
- **The current owner.** `AppConversationService.currentOwner(key)` is true when the record is `active` or `transferring` and names this machine as owner. For an unmoved conversation it is `serves(key)`.
- **Who uses which.**
  - `/app/session-reply`, `ownsAlias` and the ports' `disclose` use `mayReply`, so the drain's "moved machines" notice, sent after the close and before the target's claim, is never dropped.
  - Spawns and starts use `serves`.
  - Emergency stop and pause use `currentOwner`, as does the owner's acceptance check (`canServe`) for a forwarded stop or pause. So a draining owner takes them (2.4).
- **Binding** is a desired-set reconcile, not a reaction to lease changes.
  - It runs every lease tick, and whenever ownership is materialised.
  - It binds every conversation for which `mayReply` holds here, and unbinds the rest. `onReplicatedEvent` and `applyCreate` bind through the same rule.
- **Losing a conversation closes its session.** When this machine has a live session for an app conversation it no longer serves, it closes that session through `terminateWithAuthority` after the draining tail. "No longer serves" means the record names another machine, or the lease moved away from an unmoved conversation.
  - **Permission to close.** On a machine that isn't the lease holder, `terminateWithAuthority` refuses ordinary closes. This close uses the runtime-private exception `localPostTransferCloseout`, with a reason beginning "topic moved". The drain's own close uses `topicTransferClose`.
  - **Retries.** A ReapGuard KEEP refusal is retried on every reconcile.
  - **Accepted, bounded:** the `open-commitment` and `active-subagent` keeps can hold a stale, unbound copy alive for longer. While held, it gets no messages and can't reply, but it can still finish tool work it had started.
  - **The `recent-user-message` keep.** `localPostTransferCloseout` doesn't lift it, so a stale copy's close can wait out that keep. This is bounded and accepted: the copy is unbound, gets no messages and can't reply, and the close is retried every reconcile.
  - This rule makes every split short-lived: a stale owner that wakes, or a holder that served an unmoved conversation during a partition, both close their copy the moment they learn.
- **Unmoved means unchanged.** A conversation never moved has no record, so the lease holder serves it exactly as today.

### 2.2 The two ways an app conversation changes machine

1. **Move,** through a completed drain (2.5).
2. **Bring it back here.** An operator Face ID action on the lease holder, for a moved conversation whose machine isn't answering.
   - It uses the registry's `force-claim` verb, today reserved for the evidence-gated stale-owner engine. Here it is taken on the operator's explicit, confirmed decision, never on a liveness guess.
   - **It writes far above the observed epoch.** The `force-claim` action gains an optional `epochMargin` (default 1, today's behaviour). "Bring it back here" passes 1,000,000, well within the applier's `maxEpochJump` (default 1e9, never overridden).
     - The far side of a partition can be a live group of machines still acting: claims, moves, aborts, releases. None of those cooperative steps can climb a million epochs.
     - So whatever the far side writes is strictly lower, and the journal's strictly-higher rule settles every machine on the holder's record.
   - **A deterministic tie rule for app rows, as a backstop.**
     - For `app:` keys, a row written by "bring it back here" carries a takeover marker. At an equal epoch the marked row wins, then the lower machine id.
     - `OwnershipApplier`'s tie-break uses that rule for app rows, and the local store may adopt the winner at an equal epoch for an `app:` key.
     - So even an equal epoch converges to one owner on every machine, and 2.1's close rule fires on the loser.
   - The confirmation says plainly: "If <machine> is actually still running this conversation, its session will be stopped as soon as it reconnects."
   - The higher epoch it writes is what 2.1's close rule acts on.

**Nothing else places an app conversation:**
- **No pins.** `/pool/transfer` writes none for an `app:` key, and `TopicPinMutation` refuses `app:` keys.
- **`OwnershipReconciler`** skips `app:` keys entirely: no pin cases, and no claim or abort in the unpinned-transfer pass. A `transferring` app record is resolved by its own owner (2.5).
- **`SessionRouter` and the queue never place an `app:` key.**
  - `route()` never calls `placeAndClaim` for one. With no record, it delivers on the lease holder (gate open) or holds it (gate closed). With an active record elsewhere, it forwards to the owner.
  - `forwardToOwner` never re-places one, and the queue's `forceReplace` skips app keys.
  - A message the owner doesn't take stays queued until the queue's limits: 30 minutes (`entryTtlMs`) or the attempt cap.
  - On expiry, the phone's request record is finished as refused, with the words "The machine running this conversation didn't answer. Bring it back here, or try again when it's back."
- **The overload shed** never picks an `app:` key.
- **Claim-on-spawn** (`ownershipFollowsLiveWork`) and the dashboard create claim (`claimDashboardCreatedTopic`) take numeric topics only, and stay that way. The app create path (part 2) never places.
- **`StaleOwnerReleaseEngine`** skips `app:` keys. It reads every record itself and would otherwise force-claim one automatically, outside its numeric-only budget and backoff.

### 2.3 The lease gate

**The hazard.** A lease holder serves conversations with no record. A lagging copy can't tell "never moved" from "moved, record not yet here", and the lease often changes hands exactly when the old holder goes dark.

**The gate.** On gaining the lease, including at boot, the holder opens the gate after a `session-status` round to every reachable machine in the pool, bounded at 30 seconds. Each answer carries its machine's `seamlessnessFlags`, so the flag is read from the answer itself. `session-status` gains a field, `appOwned: [{ key, epoch, status }]`: the app records each machine holds as current owner (`active` or `transferring`), so a lease change mid-move is seen too. Every key reported there is held, not served, until this machine's store has its record at an epoch at least the one reported. Then 2.2 routes it.

Older answers never carry `appOwned`. They come only from unflagged machines, which 2.6 handles.

**Partitions.** A flagged machine that doesn't answer within the bound is treated as owning nothing. If it does own a conversation, the holder serves that conversation as unmoved during the partition. The split is bounded by 2.1's close rule:
- when the partition heals, the owner's record (it has an epoch; the holder's service of an unmoved conversation has none) is materialised on the holder;
- the holder closes its copy;
- messages route to the owner.

A partitioned owner also can't be reached by the phone through the holder, so the two copies don't both receive the same messages.

### 2.4 Messages reach the owner

- **The phone's sends** go to the lease holder, as today. A non-holder still answers 503 `owner-unavailable`, as today, so there is no machine-to-machine relay of a phone request.
- **On the lease holder,** the send is stored first, as today, then routed:
  - **no record, or a released one:** delivered locally, once the gate is open;
  - **a record naming the lease holder:** delivered locally;
  - **an active record naming another machine:** forwarded to it over the existing router-only mesh `deliverMessage`, carrying the stored, signed `AppEvent`, not just its id;
  - **`transferring`:** held, except emergency stop and pause, which go to the current owner at once (below).
- **On the owner,** the event is ingested idempotently by `eventId`. Then the steps that run inline in today's send route run there:
  - the exact-stop check and the sentinel kill or pause;
  - `pendingContext`;
  - `sessionLinesFor`;
  - the memory person;
  - the owner name.
  
  Then the event is dispatched and acknowledged. The holder finishes the phone's request record from the acknowledgement.
  - **Crash between receipt and dispatch.** The app path uses the same `injected` marker on the owner's receipt that Telegram uses, plus owner-side boot recovery: a receipt without the marker appends an `unknown` delivery. A `duplicate` answer alone never counts as "delivered".
  - **While a send is held** (gate closed, or the conversation mid-move), the phone's request answers "waiting". If the holder restarts meanwhile, `recoverStranded`'s `unknown` may later be superseded by a delivery. The latest state wins, and nothing is lost.
- **Origin verdicts.** Same policy as the local path today: deliver on any verdict, add the signed tag only on `verified`, and record a `failed` verdict on the event. `unknown` is ordinary replication lag of the device-key ledger, so refusing on it would drop messages.
- **The sender check** has an app arm: the event's paired device.
- **Retryable refusal.** The owner may answer a new `not-yet` (mid-binding, gate closed). `DeliverAck` gains that value. `forwardToOwner` treats it as "keep queued", and never re-reads ownership into `placeAndClaim` for an `app:` key on any answer. Only flagged machines receive app forwards.
- **Emergency stop and pause** go to the conversation's current owner (`currentOwner`), including an owner that is draining it.
  - **Their own epoch rule.** The owner's `transfer` CAS raises its epoch, and the holder learns of it only through the journal (about 15 s), inside the 30 s drain. So a stop or pause forward never fails the epoch fence for being older.
    - `DeliverMessageHandler` accepts a stop or pause for an `app:` key when `currentOwner(key)` holds on the receiving machine and its epoch is at least the forwarded one, before the stale check.
    - On the holder, a stop or pause skips `dispatchOne`'s hold for `transferring` records and is forwarded at once.
    - If the forward reaches a machine that is no longer the current owner because the move just completed, the holder re-forwards it once to the new owner, by re-reading the record.
    - For a conversation with no record, while the lease gate is closed, the holder runs today's local stop, which is harmless.
  - **The per-conversation emergency flag** is bound per drain request: the runner's `emergencyStopActive` seam is given a closure over the key. It clears when that drain ends, whether aborted or completed, so later moves aren't aborted by it.
  - **"Intercepted" is true when said.** `onAccepted` runs synchronously before the handler's acknowledgement, so the stop or pause has taken effect when "intercepted" is recorded.
  - On the owner they act at once, as today. While a drain is running for that conversation, they also set a per-conversation emergency flag. The drain's `emergencyStopActive` seam reads it, as well as the machine-wide flag file. So the drain aborts (`aborted-emergency-stop`) and the conversation stays where it is.
  - The phone's request record says `intercepted` only on the owner's acknowledgement. Otherwise: "Couldn't reach the machine running this conversation; the stop hasn't taken effect yet."
  - A stop that reaches a non-holder (the phone on another route) runs today's local `emergencyStop`, which stops nothing here for a conversation running elsewhere. It answers with that same sentence, never `intercepted`.
- **The inbound queue's drain** delivers by kind: Telegram as today, app through this path, Slack through `_slackInboundDispatch` (closing the acked-then-lost gap).

### 2.5 The move

- **Preconditions.** `POST /pool/transfer` accepts a conversation reference (`telegram:N`, `app:<uuid>`, or a bare number) through `conversationKeys`. For an `app:` key:
  - the whole-pool gate holds (2.6);
  - the target advertises the flag;
  - the current owner advertises `ws12DrainReceive` and the flag. For an unmoved conversation, the current owner is the lease holder.
- **A virtual baseline for an unmoved conversation.** With no record, the planner and the confirmation challenge take the lease holder as current owner, at the record's released epoch or 0.
  - Moving it to the lease holder itself is a no-op.
  - The planner's "target offline" confirm is refused for `app:` keys.
  - The move's rate limit, which reads the pin store for Telegram, is kept per key in memory for `app:` keys, at the same rate.
  
  On the call that proceeds to drain (the confirmed call, or the only call when no confirmation is needed), the lease holder:
  1. places and claims a record for itself (two CAS steps);
  2. accepts the result only if both CAS steps it just issued succeeded and the record reads "self, active, epoch above the baseline". It treats that as the expected transition, not as `retryRequired`;
  3. drains, with the drain request's `senderObservedEpoch` set to the new epoch, not the baseline.
- **Only a completed drain moves it.**
  - The target's claim comes only from the drain runner's own claim step. The reconciler never claims an app key (2.2).
  - The route continues to `seatMoved` only on `drained` or `drained-interrupted` with `claimLanded: true`. Any other answer, a drain without its claim, a throw or a timeout gives 409 `failedNeedsRetry` and no pin. A drain whose claim didn't land is aborted back by its owner.
  - Before answering a failure, the route asks the source owner for the record, since the holder's copy lags by about 15 s. If the target's claim landed after all (a slow runner outliving a timed-out route), the route answers that the move completed. If the source can't be asked, it answers "the move may still complete; check in a moment".
  - A record that stays `transferring` (the runner died, or the route timed out after the runner's transfer CAS) is resolved by its owner. The owner aborts the transfer (`abort-transfer`) once no drain is running for it past the drain deadline, and restores the delivery ledger (`restoreDeliveryLedger`) as the runner's own abort does, so delivery isn't left fenced. The conversation stays where it was. The target never claimed, so no second session exists.
  - A self-placed record from the baseline step is released once it is `active` again.
- **The drain's seams are per-kind,** through part 1's `conversationPorts`:
  - **The session:** `session()`.
  - **Quiet and idle reads:** the session's pane.
  - **Close:** the session record found by tmux name, through `terminateWithAuthority`.
  - **The delivery-ledger hand-off:** by the app key.
  - **`notifyInterrupted`:** `disclose()`.
  - **The working-set kick:** takes the key.
  - **`epochFloorOf`:** takes the key.
  
  A live app session never reads as "nothing to close".
- **Moving back to the lease holder** is a drain to the holder. Its claim lands, then the holder releases its own record, being the active owner. The route's tail (release, then place and claim for the target) is skipped for `app:` keys.
- **Memory privacy.** A new heartbeat flag, `memoryPrivacyEnforced`, is true when memory privacy is on and its sandbox is ready.
  - A support person's conversation moves only to a machine with that flag: "That machine doesn't keep private memory, so this person's conversation can't move there."
  - A conversation's memory scope is machine-local and starts empty on the target. The move's confirmation says so.
- **Media.** The target re-derives what it can from replicated events. Pending deliveries and transcript notes that were local to the old owner are named in the move's answer.
- **Phone and dashboard.**
  - The phone's `session-move` signed line accepts the reference grammar, re-validated with real case. The allowlist widens `move` to the same pattern.
  - `summarizeControls` offers Move for app conversations, listing flagged targets only. It offers "Bring it back here" when the owner isn't answering.

### 2.6 Older machines

**The flag.** `seamlessnessFlags.appConversationsPool` means a machine runs this part.

**A machine's flag is "unknown"** until its first heartbeat after it comes online, or after the lease changes. For up to two heartbeat intervals nothing acts on it; after that, unknown counts as unflagged, for the write gate only.

**The whole-pool gate.** App records may be written only while every online machine advertises the flag. The exceptions are the enforcement steps below: the bring-home drains, releases and force-claims, and the unflagged-holder abort-then-release. Otherwise Move answers: "Your machines need the latest Instar update before app conversations can move."

**When a machine advertises the flag.** Only when its durable `LocalSessionOwnershipStore` and placement replication are both active. Without those its ownership is in memory and unreplicated, so it can't take part.

**"Unknown" applies only to the write gate.** The enforcement below acts only on machines positively seen as unflagged, so a flagged holder coming back online never triggers a release of everything.

**Enforced from the flagged side, continuously:**
- **When the lease holder is unflagged** (an older machine took the lease), every owner of a moved app conversation stops serving it: it closes its session through `terminateWithAuthority`, unbinds, and releases its record. A `transferring` record is aborted first, then released. The older holder then serves every app conversation, as older code does.
  - **The overlap.** The flag reads as unknown for up to two heartbeat intervals. During that time a moved conversation's owner may still reply while the older holder also binds it. The phone's sends reach only the holder, so the owner's session gets no new messages in that window, and only an in-flight reply can land.
- **When an unflagged machine comes online while records exist,** the lease holder brings every moved conversation home:
  - a drain to itself where the owner is flagged, then release;
  - `force-claim` where the owner is the unflagged machine itself, which is the downgrade case.
  
  It raises one attention item ("app conversations were brought home because <machine> needs the update").

**Why a downgraded owner can't split a conversation.** Older code serves app conversations only on the lease holder (`isOwner() = holdsLease()`), and refuses `/app/session-reply` elsewhere (`ownsAlias`). So an older non-holder can neither take messages nor reply. A session it still has running gets no messages and can't reply. It ends when that machine's idle reaping closes it (`unbindApp` itself stops nothing). It is harmless meanwhile.

### 2.7 Every reader of ownership, decided

- **The journal.**
  - `emitPlacement` gains a key-typed form for `app:` keys: topic absent, `data.sessionKey` the key, op key `` `${sessionKey}:${epoch}` ``.
  - `sessionKey` and the takeover marker join the topic-placement schema's known fields, `sessionKey` validated by the `app:` grammar.
  - The applier's choice of the best row among equal epochs uses the app tie rule from 2.2.
  - Equal-epoch adoption into the local store goes through its own store method (like `correctMaterializedStatus`), never a looser `casWrite`.
  - `opKeyOf` returns the string op key for those rows.
  - `OwnershipApplier`, `CoherenceJournalReader` and `StrandedTopicSentinel` read `data.sessionKey` for app rows. Older readers skip rows with no numeric topic.
- **`TopicPinMutation`:** refuses `app:` keys.
- **`DuplicateSessionReconciler`:** skips `app:` keys. Splits of app conversations are closed by 2.1's close rule, under the right key.
- **Queue entries on a holder that loses the lease.**
  - **On a planned hand-back,** the queue drains before stepping down.
  - **After an unplanned loss,** the old holder's held app entries stay there until it holds the lease again. A phone retry to the new holder recovers the message: the event's id prevents a duplicate. Nothing is lost, but such a message can wait until the retry.
- **`OwnershipReconciler`:** skips `app:` keys entirely.
- **The overload shed:** never picks `app:` keys.
- **`StaleOwnerReleaseEngine`:** skips `app:` keys (2.2). The only takeover is the operator's "bring it back here".
- **`StrandedTopicSentinel`:** words its notice for an app conversation, and offers "bring it back here".
- **Release-on-complete:** Telegram-only, unchanged.
- **`session-status`:** gains `appOwned` (2.3).
- **Pool stage dark:** no app records, forwards or moves. Exactly today.

## Constitution check

- **An Instar Agent Is Always a Multi-Machine Entity (parent).** App conversations become placeable per conversation, like Telegram topics.
- **Cross-Machine Coherence.** One owner per conversation, by the fenced registry. An app conversation changes machine only by a completed drain or by the operator's explicit "bring it back here", never on a liveness guess. The flag (2.6) keeps older machines out. The lease gate (2.3) and the close-on-loss rule (2.1) bound every split.
- **Ownership-Gated Side Effects.** Every spawn, stop, pause and disclosure asks `serves(key)`, and every reply asks `mayReply(key)`, at fire time. A non-owner forwards and never acts locally. A machine that learns it lost a conversation closes its copy (2.1).
- **Canonical Pipeline Operational Completeness.** Forwards are acknowledged only after durable ingest, and the queue's drain delivers every kind.
- **Know Your Principal.** A forwarded app message's sender is its verified signed origin.
- **No Silent Degradation.** Stop, pause, media and memory-privacy limits are said in words.
- **Occam's Razor.** This reuses the transfer route, the drain runner, the registry, the router, part 1's ports and 3a's grammar. The added code is the per-kind seams, the app arms and the flag. The capability flag and the whole-pool gate are added machinery that prevents a named failure (an older machine splitting a conversation, D4 of the round 1 review).

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Who serves an app conversation | invariant | Fenced record, else lease holder |
| App placement allowed | invariant | Whole pool flagged; target flagged |
| Forward acknowledgement | invariant | After verified durable ingest only |

## Verify the state, not its symbol

A move is "done" when the target's session list shows the conversation's session, matched on `conversationRef`. With no session yet, it is done when the ownership record names the target. A forward is "delivered" only on the owner's acknowledgement after ingest.

## Maturation plan

- **test-agent-live:** unit, integration, and a two-machine throwaway pool e2e.
- **dev-agent-live:** Echo moves one throwaway app conversation between two of its machines and back, from the simulator app.
- **fleet:** behind the session pool's existing stage and the whole-pool flag gate. An unmoved conversation behaves exactly as today.
- **graduation criterion:** Justin moves an app conversation from the phone.
- **ladder:** not applicable: placement follows the session pool's stage gate.

## Open questions

*(none)*

## Frontloaded decisions

1. An unmoved app conversation keeps today's owner, the lease holder. Only a completed drain writes a record naming another machine.
2. App conversations change machine only by a completed drain or the operator's "bring it back here". There are no pins, no router placement, no shed and no automatic takeover.
3. A new lease holder serves no-record conversations only after a `session-status` round (the lease gate). A machine that learns it lost a conversation closes its copy.
4. Phone sends keep today's rule: they go to the lease holder. There is no machine-to-machine relay of a phone request.
5. Older machines are kept out by a flag, enforced continuously from the flagged side.
6. Memory scope doesn't follow a move. A support person's conversation moves only to a machine that advertises `memoryPrivacyEnforced`.

## 4. Security

- The move is the existing Face ID `session-move`, with the reference grammar re-validated with real case.
- Forwarded app messages carry their signed event. The owner records its origin verdict and treats it exactly as the local path does today (2.4).
- "Bring it back here" is an owner-phone Face ID action, behind the same write gate as Move.
- A receiving machine checks ownership before dispatch.

## 5. Multi-machine posture

This is the multi-machine change: fenced ownership, flag-gated placement, a replicated store, and aliases derived from the conversation key (minted on demand on the target, collisions probing downward). The bind token is scoped to the alias the target mints.

## 6. Tests

- **Unit:**
  - `serves` and `mayReply` for each record state, including the draining tail, and the binding reconcile.
  - The lease gate: closed until caught up; a no-record message waits.
  - No placement path for `app:` keys: route, `forwardToOwner`, `forceReplace`, pins, reconciler and shed.
  - A failed drain answers 409 with no pin, and releases a self-placed record.
  - The continuous flag enforcement: unflagged lease holder, unflagged machine online.
  - The journal app rows: op key, schema, `opKeyOf`.
  - The `not-yet` answer.
  - The strict Slack grammar on the receiving side.
  - The per-kind drain seams, closing through `terminateWithAuthority`. A live app session is never "nothing to close".
  - The unmoved-conversation drain (place, claim, then drain).
  - The queue drain by kind.
  - The flag and whole-pool gate.
  - Each consumer in 2.6.
  - Stop and pause forwarding words.
  - The memory-privacy target rule.
  - `summarizeControls` move rows.
- **Integration:**
  - `/pool/transfer` for an unmoved and a moved app key.
  - A target without the flag is refused.
  - `/app/session-reply` per conversation.
  - A forwarded send with signed event ingest, verified and refused.
  - A stop on a non-owner.
- **E2E:** a two-machine pool on the production path. An unmoved app conversation moves; a message to it, sent through the other machine, is answered by the target; the reply is visible from the first machine; moving it back releases the record.

## 7. Agent awareness and migration parity

A new bullet, with a marker-guarded insert after part 2's: "App conversations move like Telegram topics (`POST /pool/transfer` with `app:<key>`, when all your machines are updated); Slack conversations stay with the machine that holds the Slack connection."

## 8. Rollback

Revert. Older code serves every app conversation from the lease holder again and ignores `app:` records for serving. Leftover `app:` records and pins are inert for serving, but older consumers may still read them:
- the older overload shed may try to drain one through numeric seams. There is no app session under a numeric lookup, so it finds nothing and changes nothing a person sees.
- the older stranded sentinel may raise one notice per leftover record.

On a downgraded machine that still holds local `app:` records, the older reconciler and `StaleOwnerReleaseEngine` may act on them. Older `emitPlacement(topic: number)` would also write NaN topics for them, which older readers skip.

Before a deliberate downgrade, move every app conversation back to the lease holder, which releases its record. The rollback note in the release says so.
