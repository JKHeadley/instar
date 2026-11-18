---
title: Agent messages reach the session that holds the role now, across restarts and machines, and a session sender learns when they don't
slug: messages-reach-renamed-sessions
tier: 2
eli16-overview: docs/specs/messages-reach-renamed-sessions.eli16.md
tracked: CMT-1940 (topic 144503), fb-c85b50ad-29e, fb-2e23f5e5-209, fb-7b53d8fd-c44, fb-4a1f5549-5ca
review-convergence: "2026-11-18T14:16:09.519Z"
review-iterations: 6
review-completed-at: "2026-11-18T14:16:09.519Z"
review-report: "docs/specs/reports/messages-reach-renamed-sessions-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 6
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
approved: true
approved-by: "echo-chief-of-staff (maintainer approval, msg 251e0733, 2026-11-18 06:20 PT; not a constitution change)"
---

# Agent messages reach the session that holds the role now

## Problem (observed Nov 16-18 2026, causes verified in code)

Same-agent messages (`POST /messages/send` with `to.session`) name a tmux session.

1. **Renamed after restart or respawn.** Sessions come back as `echo-echo-<role>` or `echo-topic-N`. Three places add the `<projectDir basename>-` prefix unconditionally: the interactive spawn path (`SessionManager.ts:~8202`), the triage path (`~9060`), and `plannedTmuxSessionName`. Senders hold whichever name worked last. `deliverSameAgentLocal` marks a target that isn't running as terminally `failed`.
2. **The failure reaches nobody.**
   - The HTTP reply says `phase: failed`, but scripts and launchd helpers rarely read it.
   - A session sender is never told when a queued message is later dead-lettered. Dead-lettering happens inside `DeliveryRetryManager` (`:215`, `:241`), not where the sender would see it.
   - The throughput session's 10-item access report (msg 8e3d2861, Nov 18 05:23Z) was dead-lettered this way. So were Chief of Staff handoffs to `echo-instar-desktop-app` at 13:25Z.
3. **Cross-machine session messages never worked.** Verified 2026-11-18, fb-4a1f5549:
   - **Wrong path.** `relayToMachine` posts to `<peer>/messages/relay-machine` (`MessageRouter.ts:887`). The receiver mounts only `/api/messages/relay-machine` (`machineRoutes.ts:1355`, moved 2026-08). The M5 answers the old path with 404 and the new one with 401 (unsigned probe).
   - **No delivery on arrival.** `MessageRouter.relay()` (`:271-325`) verifies, dedups and stores, and never types into a session.
   - **Nothing drains the fallback queue.** `~/.instar/messages/outbound/<machine>/` is not read by anything: `GitSyncTransport` is never constructed by the server, and the folder is not in a git-synced tree. The Studio holds 112 envelopes there, the oldest from Nov 6.
   - **The sending machine's own copy is retried locally.** That copy of a cross-machine message stays `queued` in the sender's store. `queryInbox` filters only on `to.agent`, so `DeliveryRetryManager` retries it into a local session with the same name. Each TTL expiry then dead-letters it.
   - **Peers with no saved address are skipped.** A peer that has endpoints but no `lastKnownUrl` is never tried.

## Design

### A. Resolver: who holds this role now

New pure module `src/messaging/sessionAddressResolver.ts`:
`resolveSessionTarget(target, ctx) → { kind: 'exact'|'redirected'|'ambiguous'|'none', session?, candidates?, via?, reason? }`.

**Inputs** (all already on the machine):
- running sessions and history from `StateManager.listSessions()` (memoized, 1s TTL);
- the topic registry, through a new public `SessionManager.sessionNameForTopic` that caches the parsed file and reloads it when its modified time changes;
- the project prefix;
- a cut-off time `asOf`: the message's `createdAt` for local sends. For relayed messages it is `arrivedAt − age`. `age` is how long the message had existed when the attempt was made, measured on the sender's clock and stamped into each signed attempt (D.3). `arrivedAt` is measured on the receiver's clock. Two machines' clock readings are never compared, and a message that waited hours in a backlog is still judged by when it was written.

**Candidates** are running sessions that started at or before `asOf` (the freshness filter, applied to every rule before counting), excluding sessions whose conversation is standing down (the existing per-conversation `standDownRefusal(conversationId)` in `deliverToConversation.ts`). A message written before a session existed is never typed into it, by name or by inference.

**The first rule with one or more candidates decides.** One candidate delivers. Two or more is `ambiguous`, which refuses with the candidate names. No later rule is consulted after an ambiguous rule.

1. **exact**: `tmuxSession === target`.
2. **topic identity**: the topic the target names. That is either the alias `<prefix>-topic-N`, or the `telegramTopicId` of the target's newest historical record (`pickSessionByTmux` semantics: a running record first, then the newest `startedAt`). The holder is the session the topic registry names. Only when the registry has no running binding does a candidate whose `telegramTopicId` is that topic count.
3. **same name, topic-less roles only**: when the target's newest record has neither a topic nor a `jobSlug`, a candidate whose stored `name` equals that record's `name`.
4. **prefix-equivalent**: collapse one repeated leading `<prefix>-` on both tmux names, so `echo-echo-x` and `echo-x` compare equal. This applies only when all session records (any status) that claim the normalized form belong to one role: the stored name with one leading `<prefix>-` removed, plus its topic or job. The old and new records of one role (`echo-x` and `echo-echo-x`) therefore count once. Two roles that share a name only by prefix (`chamber` and `echo-chamber`) are indistinguishable by name, which is why E refuses to let them share a tmux name at all. Session records are kept for the life of the state directory today; if they are ever pruned, the prune keeps one record per distinct tmux name, so this check stays sound.

**Refusal reasons:**
- **`topic-not-held-here`**: the newest record has a topic but no candidate holds it. When the placement record names another machine, the reason is `topic-held-on <machine>` (D.7); nothing is forwarded.
- **`role-respawned-after-message`**: the only holder, or the exact-name session, started after `asOf`.
- **`job-run-ended`**: a record with a `jobSlug` and no topic resolves only by rules 1 and 4.

### B. Delivery and retries are pinned to one session

`deliverSameAgentLocal` acts only on envelopes whose `to.machine` is this machine's id, the literal `'local'`, or unset.
- **`exact` or `redirected`**: deliver. Before typing, the pin is written to the envelope's `DeliveryState` (new optional fields `resolvedSession` (tmux name), `resolvedSessionId` (the `Session.id`) and `resolvedVia`). Typing happens only after that write, so any later recovery or retry is held to that same session id. Then the transition reason `delivered to <session> (via <rule>)` is recorded.

  `to.session` is never rewritten. A first-attempt failure (such as an unsafe foreground process) leaves the envelope `queued` with the pin in place.
- **`ambiguous` or `none`**: terminal `failed` with the candidates or the reason, then C.

**`DeliveryRetryManager`**:
- **Scope.** Its retries, watchdog and ACK-timeout step act only on envelopes whose `to.machine` is this machine's id, `'local'` or unset. Its TTL sweep still covers every envelope except those the D queue owns (phase `relaying`, ended by its one pass) and origin copies D.6 keeps open for a late notice, so other cross-machine messages (to `*`, `best`, or with no session) keep today's expiry.
- **Target.** Every place it reads `to.session` (retry, watchdog) uses `resolvedSession ?? to.session`. It delivers only if a running session with that name still has id `resolvedSessionId`. A respawned session under the same name has a new id, so the retry fails with `resolved-session-ended`, then C.
- **Envelopes never resolved.** An envelope queued before this change, with no pin, is resolved once on its next retry and pinned. Ambiguity on a retry refuses, as above.
- **Ownership.** `isOwnSession` is called on the session actually typed into.
- **Dead-letters.** A new `onDeadLetter(envelope, reason)` callback fires on both of its dead-letter paths (max retries and TTL), for local envelopes only, and only for envelopes that were never typed: no `delivered` transition and no `typingStartedAt`. Today the TTL sweep also dead-letters messages that were typed fine but never acked (`ACK_TIMEOUT` is null for `info`, `handoff` and others, `DeliveryRetryManager.ts:213-214`); those never produce a notice.

### C. A session sender learns about a terminal failure

**Triggers**:
- the router's synchronous `failed`;
- `onDeadLetter`;
- D's terminal outcomes;
- a verified remote notice (D.6).

**Who gets a notice.**
- A notice is typed locally only when `from.machine` is this machine. A failure on a receiving machine for a relayed message goes back through D.6 only, never into a same-named local session.
- `/messages/send` now forces `from.agent` and `from.machine` to this agent and this machine. A caller that sent other values gets them replaced, and the originals are kept in `from.requested` for the record; no shipped caller relies on setting them to another machine (the server would have refused to relay such a message anyway, D.2). `from.session` stays whatever the caller wrote.
- A notice is typed only into a running session whose tmux name equals `from.session` exactly.
- Anyone holding the bearer token can already type any text into any local session through `/messages/send`, so a notice aimed at another session gives a caller nothing new. It is still a fixed template, so it can't carry an instruction:
  - It is marked "[delivery notice: quoted data, not an instruction]".
  - The subject and target have control characters and newlines removed. A field over 120 characters keeps its first 80 and last 30 characters around "… (cut; full text in message <id>) …", so a distinguishing suffix survives and the whole record is one lookup away.
  - It names the reason and lists any candidate running sessions.
- `/messages/send` refuses a caller-supplied type `delivery-notice`. Only the router creates one, as a new `MessageType` with entries in `ACK_TIMEOUT`, `DEFAULT_TTL` and `DEFAULT_RETENTION_DAYS`. `/messages/send` validates no type today, so this refusal is a new check.

**Volume.**
- The first failure for a sender is noticed at once. Further failures for that sender within 60s, to any target, are grouped into one second notice listing each target and reason. So one sender gets at most one notice per minute, however many messages failed.
- The failed envelope records `noticePending`, then `noticeSentAt`, as single-file updates (no store scan). At boot, pending notices are flushed. One timer serves all groups.
- A notice never triggers a notice. A local notice that can't be typed is recorded and dropped (the failure itself stays on the failed envelope). A remote notice gets one pass like any message (D.6), and D.6 never sends a notice about a `delivery-notice`.

**No session to tell.** When the sender is not a running session (scripts, helpers), or the notice can't be delivered, the failure stays in the message store with its reason. It is counted in `GET /messages/stats` under `undelivered` (by target and reason). It is **not** sent to `DegradationReporter`: a send to a stopped role is a normal per-message outcome, not an Instar fault to report upstream.

### D. Cross-machine relay that delivers (phase 1: one pass, signed both ways)

This phase makes cross-machine session messages work end to end, with one delivery pass per message and a clear outcome. Durable retries for a machine that is away, and following a topic that moved, are phase 2 <!-- tracked: CMT-1940 -->. Phase 1 reports both cases plainly to the sender instead of handling them.

1. **Path.** The sender posts to `/api/messages/relay-machine`, and both sides import one exported constant. The receiver also keeps the old path `/messages/relay-machine` as a permanent alias with the same machine auth, so an older sender whose caller set `from.machine` correctly reaches an updated receiver. The stale bearer exemption for the old path (`middleware.ts:374`) is removed; the alias is a machine-auth route, mounted with the others before bearer auth.

2. **Arrival.** Before storing, the receiver refuses with a coded non-2xx answer when any of these checks fails:
   - `to.machine` is this machine;
   - `from.agent` is this agent;
   - `from.machine` equals the envelope signer (`transport.signedBy`), `relayChain[0]`, and the machine that signed the request headers (the machine-auth middleware's verified id).

   Receivers never forward, so those three are always the same machine. The same checks apply on the second arrival path, `pickupGitSyncMessages` in `server.ts`, which is currently inert; that path skips the clock check, so messages arriving by it are stored and never typed (D.3).

   **Duplicates** are answered only after these checks and the signature check pass. Today `relay()` acknowledges a known id before verifying (`MessageRouter.ts:~278`); that order is reversed. A duplicate id is acknowledged with its stored outcome and never typed. The duplicate check looks in `dead-letter/` as well as `store/` (`deadLetter()` moves the file), and an envelope already past its type's TTL on arrival is refused (`nack` code `expired`).

   **Storing.** The receiver writes the complete record, with `deliveryPending: true` and `arrivedAt`, to a temp file and `link()`s it into the id's store path. That one step both claims the id and stores the whole record, so:
   - two copies arriving at once can't both proceed;
   - a crash can't leave a claimed but empty record.

   **Typing.** A message with `to.session` set then goes through `deliverSameAgentLocal` (A and B, with `asOf` as A defines it for relayed messages). B writes the pin and `typingStartedAt` just before typing, and clears `deliveryPending` at the terminal outcome.

   **Boot recovery.** At boot, the retry manager picks up local envelopes still marked `deliveryPending`:
   - **No `typingStartedAt`:** nothing was typed, so the envelope goes through B, held to the pinned session id if there is one.
   - **`typingStartedAt` set:** it is never typed again. It ends `failed` with the reason `outcome unknown: the machine stopped while delivering`, and the sender is told (C).

   So a message is typed at most once, and recovery runs only at boot, never because a duplicate arrived.

   **The answer.** The ack is sent right after the record is stored; typing into the session happens after the answer, so a slow typing step never turns a stored message into `unconfirmed`. Success carries a **signed relay ack**: a domain-separated signature `relay-ack-v1|<receiverMachineId>|<messageId>|<reqNonce>` made with the receiver's machine key, following the existing `mesh-ack-v1` pattern in `machineAuth.ts`. The ack means "durably accepted by the intended machine", not "typed". Refusals are signed the same way: `relay-nack-v1|<receiverMachineId>|<messageId>|<reqNonce>|<code>`. A verified refusal proves the intended machine answered and refused.

3. **Addresses.**
   - **Source.** The router gets a new dependency, read at call time as `() => _resolvePeerUrls?.() ?? []`. The mesh block in `server.ts` assigns `_resolvePeerUrls` after the router is built, and leaves it unset when the mesh is off.
   - **Guard.** `_resolvePeerUrls().ropes` is unfiltered (`resolveMeshPeerCandidates`), so each rope is passed through `isPeerUrlAllowedForCredentials` (`peerUrlGuard.ts`) with the configured `peerUrlAllowlist`, and only the ropes that pass are used. The resolver already includes `lastKnownUrl`, and it gets the same guard. The list is built before the "no URL known" check.
   - **Per attempt.** Each attempt re-signs the envelope with a fresh `transport.timestamp` and the message's current `age` on the sender's clock. `age` is added to `SignedPayload` so the signature covers it. The request headers are signed afresh with `signRequest`, and the outcome feeds `PeerEndpointResolver.recordResult`.
   - **On arrival.** The receiver clamps `age` to between 0 and the type's TTL, and uses `asOf = arrivedAt − age − 2W`, where `W` is the relay's existing signature window, `CLOCK_SKEW_TOLERANCE['relay-machine']` (5 minutes, `types.ts:357`). The receiver already refuses any envelope whose fresh signed timestamp differs from its own clock by more than `W` (`Math.abs(...) > tolerance`, `MessageRouter.ts:~835`). So for an accepted attempt, transit plus the two clocks' difference is under 2W whichever clock runs fast, and subtracting 2W covers it: a session that started while the message was on its way is refused. The cost is that a session started within 10 minutes before a message was written may be refused too; the sender is told and can resend. An older sender sends no `age`, and its messages use `asOf = arrivedAt − 2W`. The git-sync arrival path skips the clock check, so a message arriving that way is stored but never typed into a session.

4. **What an answer means.**

   | Answer | Meaning | Action |
   |---|---|---|
   | 2xx with a valid `relay-ack-v1` from the target machine for this message id | stored by the intended machine | stop: `received` |
   | a non-2xx with a valid `relay-nack-v1` from the target machine | the intended machine refused it, with its code | stop: `failed` with the code, then C |
   | anything else: an unsigned answer of any status, an ack or nack that doesn't verify, a connect-class failure, a timeout | no proof of which server answered | try the next address |

   After the last address, the envelope ends `failed` with reason `<machine> not reachable now (resend later)`. The reason lists every address with its outcome. Two readings are named in it, without being treated as proof:
   - If any address answered 2xx without an ack: `a server stored it without confirming (an older version of <machine>, or something in between)`.
   - If any attempt timed out: the reason begins `unconfirmed: may have arrived`, because a timed-out request can still land.

5. **Timing: one sender queue per machine, one pass.**
   - **Up-front checks.** `/messages/send` keeps today's `isMachineActive` check: an unknown machine fails at once, and an empty-string `to.machine` counts as unset. If cross-machine delivery isn't configured, it now fails at once with `cross-machine not enabled` instead of queueing.
   - **Queueing.** The message is then stored as `relaying`, and the send returns at once.
   - **The queue.** One queue per target machine takes envelopes in order, and makes one request at a time with the existing 10s timeout per address. Each envelope gets one pass over the addresses and then ends `received` or `failed`. No envelope waits on a backoff, so nothing can hold up the queue past one pass, which is at most 10s times the number of addresses.
   - **Boot.** Queues start after the mesh block in `server.ts` has run. Any envelope still `relaying` gets its one pass then. An empty address list fails the envelope at once with `no usable address for <machine>`.
   - **Phases and transitions.** `relaying` is added to `DeliveryPhase`. New in `VALID_TRANSITIONS`: `sent→relaying` and `relaying→received|failed`. `sent→failed` and `received→delivered|queued|failed` already exist.
   - **Scope.** The retry manager's ACK-timeout step gets the same local-only scope as its other steps. A received envelope with `deliveryPending` uses the message type's existing `DEFAULT_TTL`.
   - **No more outbound files.** A cross-machine session message is never written to `~/.instar/messages/outbound/` again. Other users of that folder are unchanged.

6. **Remote failure notices.**
   - **Sending.** When a relayed message fails on the receiving machine (refused by A, freshness, `outcome unknown`, or a dead-letter), the receiver sends a signed `delivery-notice` back to the signer machine. It goes through that machine's queue, as one pass. Notices are grouped per (origin machine, sender) over 60 seconds, like local notices.
   - **Acceptance.** The origin accepts a notice only if it names a message id in its own store that it sent to the notice's signer. A notice can arrive before the ack does, while the envelope is still `relaying`; it is accepted then too (`relaying→failed`). An ack is applied only to an envelope still in `relaying` (a compare-and-set), so a later ack never overwrites a failure. Accepting moves that origin envelope from `relaying` or `received` to `failed`, with reason `refused on <machine>: <reason>`, whether or not a session notice can be typed. A notice is delivered by rule 1 only.
   - **If the notice can't get back.** If the origin can't be reached on that one pass, the receiver keeps the failure in its own store and counts it in `undelivered`. The origin's envelope stays `received`, meaning "accepted by that machine". `GET /messages/:id` on the origin says that in plain words. Phase 2 adds retries for notices <!-- tracked: CMT-1940 -->.
   - **The origin's TTL sweep** skips `received` cross-machine envelopes until the `delivery-notice` TTL has passed, so a late notice can still land.

7. **A topic held on another machine.** The receiver never forwards. When A returns `topic-not-held-here` and this machine's placement record names another machine:
   - **Local send.** The message fails with reason `topic-held-on <machine>`, and the sender's notice tells it to send there.
   - **Relayed message.** The origin gets the same reason through D.6. The origin never re-sends automatically in phase 1.

   When the named machine is the origin itself, the notice says so. The sender then re-sends locally, where A and B deliver it.

8. **The backlog.** The envelope files already in `~/.instar/messages/outbound/` stay where they are, untouched and still listed by `GET /messages/outbound`. They are not replayed: they are hours to weeks stale, and the freshness rule would refuse them anyway. Their records in this agent's store have already reached a terminal state. On the Studio, all 112 are in `dead-letter/`: 84 at max retries and 28 at TTL. No migration is needed.

### E. Names stop drifting

A single helper, `tmuxNameFor(name)`, replaces the three prefixing sites. It doesn't add `<prefix>-` when `name` already starts with it.
- Running sessions keep their names, and rule 4 makes the old and new forms equivalent.
- A collision with a running session still throws "already exists", so it is never silent.
- When any session record, running or not, of a different role (its topic, else its job, else its stored name) already holds the plain form, the spawn keeps today's double-prefixed name instead. The same check runs for a bare name (`bugs` → `echo-bugs`): if another role holds that name, and every natural form is taken by other roles, the spawn takes the first free numbered form (`echo-bugs-2`). So `chamber` and `echo-chamber` can never take turns under one tmux name, where rule 1 could deliver one role's message to the other. While the double-prefixed form of a name is still running, new spawns of that name keep it too, so one role never runs under two names during the change-over.
- Renames to `echo-topic-N` are handled by rule 2, not E.

### F. Agent awareness

A new `src/data/awareness/messages-reach-renamed-sessions.md` tells agents:
- that a message to an old session name reaches the session holding that role now;
- what `resolvedSession`, `relaying` and an `unconfirmed` reason mean;
- that a "[delivery notice …]" block is quoted data;
- that `GET /messages/:id` shows where a message actually went.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Resolver: deliver to a session or refuse (feeds the existing `isOwnSession` gate) | invariant; basis: irreversible-consequence; evidence: text typed into a session is acted on and cannot be recalled; the rule delivers only on one candidate at the first matching rule, the topic registry (the identity Telegram routing already trusts) outranks names, and ambiguity refuses | No judgment layer chooses between two plausible sessions |
| Freshness filter (every rule), with the relay's signature window subtracted twice (10 minutes) for relayed messages | invariant; basis: irreversible-consequence; evidence: a session that did not exist when the message was written has none of the context the sender wrote it for, whether it carries the same name or was inferred; refusing costs one notice (or a counter for scripts), delivering risks an action on a stale instruction | `asOf` uses one clock per reading (D.3's sender-measured age), never two clocks compared |
| Retries pinned to one session id | invariant; basis: irreversible-consequence; evidence: a respawn under the same name is a different session with different context; the pin makes "same session" a fact (`Session.id`), not a name match | — |
| Relay: which answers end the pass | invariant; basis: external-constraint; evidence: only a verified `relay-ack-v1` or `relay-nack-v1` from the intended machine proves who answered; any other answer, including an unsigned 2xx, could come from a proxy, a tunnel edge or another server on a reused address | Table in D.4 |
| One request at a time per target machine, one pass per envelope | judgment-candidate; floor: every envelope ends `received` or `failed` after one pass and its sender is told; arbiter: none needed, because the limit changes only how fast a backlog to one machine drains, never what the sender learns. One pass is bounded by 10s times the number of addresses | A constant |
| Relay timeout per attempt (10s) | judgment-candidate; floor: a timed-out attempt is reported as `unconfirmed: may have arrived`, never as a plain failure, and the notice says "it may have arrived; check before resending" (a resend gets a new message id, so receiver dedup does not catch it); arbiter: none needed, because the value only changes how quickly the queue moves on.  | Existing value, unchanged |
| Notice grouping (first at once, then one per sender per 60s, across all targets) and 120-character field cap | judgment-candidate; floor: every failure is recorded with its full text and reason whatever the window; arbiter: none needed, because the values only change how many notices are typed | A constant |
| Topic held elsewhere | invariant; basis: enumerable-domain; evidence: in phase 1 every case refuses with the holder's name when placement names one; nothing is re-sent automatically, so no loop exists to bound | Re-sending is phase 2 |

## Signal vs authority

The resolver is a lookup. The only authority, refusing to type into a session that isn't this agent's own, already exists. Redirects choose only among this agent's own running sessions. The receiver's new arrival checks refuse only envelopes that claim to be from another agent or machine than the one that signed them. Notices, counters and relay retries add no blocking.

## Multi-machine posture

- **A and B: proxied.** Each machine resolves against its own running sessions, where the target lives. A topic held on another machine is refused with the holder's name (D.7); a message sent to that machine runs A and B there on arrival (D.2).
- **C: proxied.** A local sender is told locally. A remote sender's origin machine is told through a signed notice that moves its envelope to `failed` (D.6).
- **D: unified.** It reads the replicated machine registry, the mesh's guarded ropes, and the shared `PeerEndpointResolver`.
- **E: machine-local.** `machine-local-justification: hardware-bound-resource`. A tmux name belongs to a process on that machine's own tmux server; every machine runs the same naming helper, and cross-machine addressing goes through A on the machine that holds the session.

## Risks and answers

- **Wrong-session delivery.** Guarded by:
  - the first-deciding-rule order, with the topic registry outranking names;
  - the single-claimant prefix rule;
  - the freshness filter;
  - session-id pins on retries;
  - excluding standing-down sessions;
  - the retry manager touching only local envelopes;
  - the receiver refusing envelopes not addressed to it.
- **Notice abuse.** Notices have a fixed template, sanitized and capped fields, and exact-name targets. The type can't be created by a caller, and remote notices must name a message the origin actually sent to that signer. The bearer-token holder already has a stronger channel, so a notice adds no new capability.
- **Plain-http LAN exposure.** Only the mesh's admissible ropes are used, and refused ropes never.
- **Duplicates across addresses.** Prevented by receiver dedup by message id; a duplicate is answered with the ack and never typed twice. Tested.
- **Mixed versions.**
  - An old receiver answers 2xx without an ack; the pass moves on, and the final reason names it.
  - An old sender reaches a new receiver through the permanent alias path, but its `from` is whatever its caller wrote, so the new arrival check refuses it unless that was the exact sending machine id. The old sender then falls back to its own outbound folder, as it does today, where nothing reads it: a known mixed-version cost until that sender is updated. Old senders are fixed by updating them; the alias only helps an old sender whose caller set `from.machine` correctly.
  - An old receiver stores a message as `received` and never types it (its retry manager retries only `queued`), so "a server stored it without confirming" is the accurate reading for it.
  - An old origin that receives a `delivery-notice` stores it as `received` with a type it doesn't know; it is harmless there and expires with that store's defaults.
  - Old agents on the same machine may keep writing to the outbound folder; this change neither reads nor moves it.
- **Rollback.** Revert the change.
  - The new optional fields and type are ignored by old readers. A `relaying` envelope left at rollback is not in the old TTL sweep's skip list (read-terminal phases only, `DeliveryRetryManager.ts:214`), so it is dead-lettered at its TTL like any non-terminal phase.
  - Reverting E strands nothing.
  - The old outbound folder was never touched.

## Tests

- **Unit, resolver:**
  - every rule on both sides;
  - the first rule decides, with no fall-through after an ambiguity;
  - topic beats name;
  - a topic held nowhere gives `none`, and the reason is `topic-held-on <machine>` when placement names another machine (no forwarding);
  - the `chamber` / `echo-chamber` pair is `ambiguous`;
  - job records give `job-run-ended`;
  - standing-down sessions are excluded;
  - freshness is filtered before counting;
  - relayed messages use `arrivedAt − age`, including a session that started while the message was in transit.
- **Unit, router and retry:**
  - a message that is redirected, queued and then retried is typed exactly once, including a watchdog tick;
  - a respawn under the same name fails `resolved-session-ended`, with one notice;
  - the sender machine's copy of a cross-machine message is never retried and never expires into a notice;
  - `onDeadLetter` fires on both paths;
  - grouping is leading-edge, and a pending notice is flushed after a restart;
  - a caller-typed `delivery-notice` is refused;
  - `from.machine` and `from.agent` are forced.
- **Unit, relay:**
  - the path constant is shared;
  - the alias path is served;
  - arrival refuses a wrong `to.machine`, `from.agent` or `from.machine`;
  - a verified ack stops the loop;
  - an ack-less 2xx moves on, and is named in the final reason;
  - a 404, a 502, a Cloudflare 530, a coded 409 and a bad ack move on to the next address;
  - a last-attempt timeout gives `unconfirmed`;
  - a fresh signature on every attempt;
  - a peer with endpoints and no `lastKnownUrl` is tried;
  - refused ropes are never used;
  - the queue runs one request per machine at a time, one pass per envelope, and `/messages/send` makes no inline request;
  - envelopes still `relaying` at boot get their one pass; an empty address list fails at once;
  - a signed nack ends the envelope `failed` with its code; an unsigned 4xx/5xx moves on;
  - freshness subtracts twice the 5-minute signature window: a session that started while the message was in flight is refused, even with the sender's clock up to 5 minutes fast;
  - a remote notice for a message never sent to that signer is refused, and a valid one moves the origin envelope to `failed`;
  - a timeout on one address followed by a rejection on another still reads `unconfirmed`;
  - `topic-held-on` fails with the holder's name, and names the origin itself when that is the holder;
  - the origin's TTL sweep leaves a `received` cross-machine envelope open until the notice TTL, and a late notice moves it to `failed`;
  - with cross-machine delivery switched off, a cross-machine session message fails at once with `cross-machine not enabled`.
- **Integration:**
  - two in-process servers, with the sender's real `relayToMachine` posting to a mounted `createMachineRoutes`: the message is stored on the receiver, typed into the named session, and acked;
  - a send to a renamed session over `/messages/send` is `delivered` with `resolvedSession`;
  - an unknown role is `failed`, and the exact-name sender gets the notice.
- **E2E (alive):**
  - the production wiring passes real resolver dependencies, the late-bound peer-URL closure (router built before the mesh block), and the `onDeadLetter` hook;
  - a send to the double-prefixed alias of a running session is delivered.
- **Live proof, two-machine throwaway pair** (`~/.instar/test-deploys/team-2b-proof`, Studio + M5):
  1. A Studio session messages an M5 topic session, and the message is typed into it.
  2. The M5 session is respawned under the other name form, and a message to the old name is delivered.
  3. A message to a stopped M5 role returns a notice to the Studio sender, and the Studio envelope reads `failed`.

  A single-machine throwaway proves the renamed-session send and the dead-letter notice.

## Maturation plan

- **test-agent-live:** the live proof in Tests. A single-machine throwaway runs a renamed-session send and a dead-letter notice. The two-machine throwaway pair (`~/.instar/test-deploys/team-2b-proof`, Studio + M5) runs a Studio-to-M5 topic session delivery with a signed ack, a stopped-role refusal with a notice back to the Studio sender, and a `topic-held-on` refusal.
- **dev-agent-live:** live on Echo (Studio, M5, Mini) from the release that carries it. For one week, read `GET /messages/stats` (`undelivered`, by target and reason) and the count of envelopes with `resolvedVia` set, daily.
- **fleet:** the same release, ungated. It only turns silent failures into deliveries or notices; revert is the rollback (Frontloaded Decisions).
- **graduation criterion:** over the dev-agent week, three things hold.
  - At least one cross-machine session message reaches `received` with a verified ack, and its target session shows it typed.
  - At least one message to a renamed session is delivered with `resolvedVia` set.
  - No envelope is typed into a session whose `startedAt` is after its `asOf`, checked by a script over the store.

  A zero count of cross-machine deliveries is not a pass.
- **dark-window:** none; the change is live on release. If the criterion isn't met within 14 days of the release, the reason and a new date are recorded on CMT-1940.
- **ladder:** not applicable: no flag, ships live on every agent (revert is the rollback)

Phase 2 (durable retries, automatic re-send) starts after graduation <!-- tracked: CMT-1940 -->.

## Frontloaded Decisions

- **Redirects:** happen within A's rules. `to.session` is kept, and the pin is added.
- **Ambiguity:** always refuses. In a respawn handoff, the freshness filter and the stand-down exclusion leave one holder or none. When the only holder started after the message, the message is refused: a session sender gets a notice, a script sees `phase: failed` and the `undelivered` counter. That is the accepted cost of never typing a stale instruction.
- **Retries:** pin a session id and never re-resolve once pinned.
- **Senders:**
  - `from.agent` and `from.machine` are forced at send.
  - Notices go to an exact-name running sender only.
  - Callers can't create the `delivery-notice` type.
  - Failures with no session sender are counted locally and not reported upstream.
- **Relay:**
  - one path constant, plus a permanent alias for older senders;
  - a signed relay ack;
  - only a signed ack or nack ends a pass early; an ack-less 2xx is not proof;
  - no inline attempt: one queue per machine makes every request, one pass per envelope; retries for a machine that is away are phase 2 <!-- tracked: CMT-1940 -->;
  - a last-attempt timeout is reported as `unconfirmed`.
- **Topics held on another machine:** refused with the holder's name; receivers never forward; automatic re-send is phase 2 <!-- tracked: CMT-1940 -->.
- **The backlog:** the folder is left untouched and nothing is replayed; its store records are already dead-lettered.
- **Rollout:** ships live, with no config switch. Revert is the rollback.
- **Headless one-shot sessions** (`claude -p` on the M5): keep today's `deliverToSession` behaviour. Whether a paste reaches them is that delivery layer's concern <!-- tracked: CMT-1940 -->.

## Open questions

*(none)*

## Carriers

> **CMT-1940** — "Machine stewardship designs the fixes: triage the 10 items, spec the structural ones through spec-converge, and report the plan in topic 144503." (pending, owner agent; ledger `docs/specs/carriers/messages-reach-renamed-sessions.json`). It carries phase 2 of this spec (durable retries, notice retries, automatic re-send) and Design 2 (restart and lock continuity).

## Out of scope (tracked)

Restart continuity for sessions and machines (items 1, 2, 7 and 8 of the same report) is Design 2 <!-- tracked: CMT-1940 -->.
