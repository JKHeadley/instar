---
title: The lease holder trusts only trust grants it wrote itself (SEC-088, part 2)
slug: trust-records-holder-authored
eli16-overview: trust-records-holder-authored.eli16.md
status: draft
approved: false
author: echo
created: 2026-11-18
parent-principle: "Signal vs. Authority"
supersedes: trust-journey-record-provenance (convergence failed at round 6; not built)
---

# The lease holder trusts only trust grants it wrote itself (SEC-088, part 2)

## Why this exists

The trust journey's store (`src/core/trustJourney/TrustJourneyStore.ts`) replicates every record to
the agent's other machines, and `applyCommitted` -> `fold` adds each one to the holder's state with
no idea who wrote it. Part 1 (PR 3403, merges first) stopped the holder from PROCESSING a peer's
receipt of the owner's reply. The folded state still creates authority from any paired machine:

| Record type | Effect when written by a compromised peer | Severity |
|---|---|---|
| `action-approval` | `unusedActionApproval` -> `admit()` returns proceed-once for the named governed action | critical |
| `change` (any direction) | a first `change` on a kind with no history makes `provenLevel` return the local level instead of "ask" (`TrustJourneyRuntime.ts` ~329, `AdaptiveTrust` default `log`) | critical |
| `change` + `legacy-grant` | `legacyUnchanged` compares the last change's id (ordered by the payload `at`) with the grant's `afterChange`, so a reused or missing `changeId` with a far-future `at` re-validates a legacy grant -> admission `legacy` | high |
| `legacy-grant` | a joining machine imports `unchangedLegacyKeys()` from every machine | high |
| `request` reusing an own `requestId` | the `requests` map is keyed by `requestId` and a record with a `cardMessageId` replaces the earlier one, so the owner's real reply to the holder's card approves the peer's change | high |
| `device-acceptance`, `device-approval` | a device counts as accepted, or a new device as approved | high |
| `acceptance`, `consumption` + `change` raise | skips the acceptance step; restores a raise at load (`checkAtLoad`) | medium |
| `consumption`, `request-status`, `apply-outcome` | a real approve is swallowed, a request closed, or an outcome shown falsely | denial |

An earlier design (trust-journey-record-provenance) tried to prove that a peer's record was written
while that peer really held the lease. Six review rounds showed that this cannot be proven cheaply
here (self-asserted timestamps, self-signable lease records, rewritable history), and it was stopped
at the round cap. Its report recommended this simpler design. Source of the go-ahead: the Chief of Staff's brief to
the security session (session `echo-chief-of-staff`, Mac Studio, delivered into session
`echo-echo-instar-security` on the Mac M5 Pro, topic 143781, 2026-11-18 01:45 PST), decision 2, in its
own words: "SEC-088 part 2: APPROVED to proceed with your simpler design (holder trusts only grants
it wrote; earlier holders' grants treated as absent after a handover and re-asked on next attempt;
narrowing and used-markers count from any authenticated machine; keep signed delta responses, origin
binding, per-writer keys). Write it up, converge it with your normal process, then build. Cost
accepted: owner re-approves pending items after a rare lease handover." (The attribution trace is
off on this agent, so the brief is quoted from the delivered message itself.) That approval covers
proceeding; the exceptions in decision 14 still need the operator.

## The rule

1. A record that GRANTS something counts on a machine only if that machine wrote it, and, for
   one-time grants, only in the lease term (epoch) that wrote it.
2. A record another machine wrote can only CLOSE, USE or WITHDRAW something by id, or end a legacy
   grant; it never reads into a grant.
3. No rule depends on the order records arrived in or on a timestamp a writer chose.

After the lease moves, the new holder therefore sees none of the earlier holder's grants; the normal
approval flow asks the owner again the next time the action is attempted.

## Frontloaded Decisions

1. **Two indexes, one per side.** `fold(writer, recordKey, record)` keeps every record (evidence), and
   builds:
   - an **own index** from records whose writer is this machine: every existing derived map
     (`requests`, `acceptances`, `acceptanceSent`, `consumptions`, `consumptionByRequest`,
     `changes`, `legacy`, `deviceAcceptances`, `deviceApprovals`, `actionApprovals`, `outcomes`,
     `receiptsByKey`), unchanged in shape;
   - a **narrowing set** from every writer: closed request ids, used receipt ids, used approval ids,
     withdrawn acceptance ids, used device-approval ids, and legacy-ending kinds (decision 5).
   Every grant-side query reads the own index only; every "is it used / closed / withdrawn" check
   also reads the narrowing set. Records are keyed by (writer, recordKey), so a peer cannot occupy a
   key this machine is about to write. Every set is a pure function of the records present, so the
   boot refold and the live state are always the same. The closed query table below is part of the
   decision.
2. **The writer is transport-derived.** The writer reaching `fold` is: this machine for its own
   stream files, provided the records' stamped `origin` equals this machine's current id (the
   journal sink stamps it; records in the local-file sink, used only when the journal is off and
   therefore on a single machine, carry no origin and are own: with no other machine there is no
   peer to confuse them with, and a new-id restore of such an agent is covered by the same-id
   restore residual) (a restored
   stream from another machine id is foreign: its records are treated as a peer's, never as own; the
   payload `origin` can only take ownership away, never grant it); for a replica, the machine the
   replica file belongs to, which the applier set from
   the authenticated sender (the machine asked on the pull path, `env.sender` of the signed mesh
   request on the push path). Never a payload field: today the boot union sets `receivedBy: r.origin`
   from the payload, and `ReplicatedPeerStreamReader.materialize` keeps the newest record per
   (origin, recordKey) by HLC. For the trust store only (other stores unchanged), a new reader method
   returns every record with its writer taken from each entry's `machine`, which `validateEntry`
   already binds to the sender (replica file names are sanitised ids, not raw ids), and the first record per (writer, recordKey) wins, as in the live fold.
   The applier refuses a replica whose sender, compared after the same sanitising, is this machine's
   own id. Each machine serves only its own stream (no relaying), which origin binding relies on. `validateEntry` adds
   `trust-grant-record` to the origin-must-equal-sender kinds and treats a mismatch as
   `failure-callout-chunk` is treated today (`forged`: the batch stops, nothing appended, counted).
   An honest peer cannot mismatch because `journalSink` stamps `origin` from the emitter, so no
   placeholder machinery is added.
3. **Signed `journal-sync` responses, for attribution only.** The `journal-sync` MeshRpc response
   carries the serving machine's Ed25519 signature over
   `['journal-sync-response', responder, requesterNonce, kind, incarnation, fromSeq, sha256(canonical entries)]`,
   following the agent-identity verbs' signed-response pattern (`AgentIdentityAdoption.ts`); the
   request gains `requesterNonce`, which older servers ignore (the handler reads only `kind` and
   `fromSeq`), and older clients ignore the added `sig`. The client verifies against the registered
   key of the machine it asked. A response with an INVALID signature has its `trust-grant-record`
   entries refused and counted (`journal.sync.badSignature`); other kinds are handled as today, so a
   key rotation the registry has not caught up with never stops other replication. A response with NO
   signature (an older build) is accepted as today. There is no "signed once, always signed" ratchet:
   it would freeze a peer that rolls back. Honest limit: an on-path attacker can strip the signature
   and land on the unsigned path, so signing protects attribution against mistakes, not against an
   attacker; under this design that attacker can still only narrow (denial), never grant.
4. **Trust levels and the autonomy profile are this machine's own.** `AdaptiveTrust`
   (`state/trust-profile.json`) and `AutonomyProfileManager` (`state/autonomy-profile.json`) are
   machine-local today, and this spec keeps them so (it does not create that locality). The reason it
   is kept, not just inherited: a raised level may only be honoured where a grant that machine can
   verify backs it, and a grant one machine can verify on another needs the owner-signed record of
   identity piece 2. Unifying levels is tracked as its own item, blocked on piece 2, and is approver
   item 14c. A `change` record describes the level of the machine that wrote it. So
   `provenLevel(kind)`, `changeLog`, `lastChange` and the load-time proof check read only own `change`
   records, and a peer's `change` never affects this machine's levels in either direction ("levels"
   excludes legacy admission, which decision 5 governs: a peer's real owner change does end this
   machine's legacy grant for that kind). A kind with
   no own `change` keeps today's rule ("no recorded grant means Ask me first").
   - One exception keeps the owner's narrowing from being lost on a hand-back: a peer `change` keyed
     at epoch W whose source is not automatic (not `revoked` or `default`) puts the kind on "ask me
     first" on this machine unless an own `change` for that kind is keyed at an epoch above W. So if
     A raised a kind, the owner lowered it on B, and the lease returns to A, A asks rather than acting
     on its older raise. It is order-free (epochs, not arrival), an honest standby's automatic restore
     never triggers it, pre-build peer changes (no epoch) never trigger it, and a forger gains only
     denial. It is checked after an own unused one-time approval in admission, with its own reason
     ("changed on <machine> since I last had your OK"), so approving one action still works. The round-2 "ask-first" state
   (order-dependent, triggered by honest standbys) is gone; the one exception below is epoch-based.
5. **Legacy grants are own-only and end on any change except a machine's own automatic narrowing.**
   - `legacyUnchanged(kind, self)` holds only if this machine's own legacy grant exists AND no `change`
     record for that kind exists other than the record(s) whose `changeId` equals `afterChange` (from
     any writer: today's `afterChange` may name a peer's change, so existing legacy grants keep their
     anchor at upgrade; a peer reusing that id adds nothing, because the rule can only end), counting own
     changes of any source and peer changes of any source EXCEPT the closed list of sources only a
     machine's own automatic process writes: `revoked` (the load-time restore and the automatic
     incident drop, `AdaptiveTrust.ts` ~192 and ~282) and `default`. So `user-explicit`, `earned`,
     `config`, the autonomy observer's `route`, a missing source and any unknown value all end it,
     which is today's behaviour for those; an honest standby's restore does not. A `change` with a
     missing `changeId` counts. Pre-build `change` records (no epoch in the key) are judged by
     today's rule among themselves (the latest of them must be the anchor), so history already
     incorporated at import never ends a grant; every epoch-keyed change outside the automatic-source
     list ends it, with no ordering.
   - A peer can end a legacy grant by forging a change: denial, permanent for that kind until the
     owner approves the kind on this machine. Listed under residuals and shown on `/trust/summary`.
   - The legacy import's "another machine already imported" check (`othersImported`) reads a new
     evidence query, `legacyImportedAnywhere()`, over every writer's `legacy-grant` records; it only
     decides that this machine is a joining machine, never grants. The legacy import on a joining
     machine imports nothing from peers; a joining machine starts
     with no legacy grants, so its kinds are gated ("ask") until approved there.
   - Note that `admit()` lets a non-holder admit a `legacy` verdict itself (today's behaviour,
     unchanged); with own-only legacy grants that is now each machine's own record.
6. **After a handover, earlier holders' grants are absent and are re-asked on the next attempt.** No
   migration copies them and no new record type adopts them. The owner-visible cost, stated in full:
   - each pending approval is asked again on the new holder the next time the action is attempted;
   - each channel's acceptance (chat `acceptance`, app `device-acceptance`) is asked once on the new
     holder before approvals there count;
   - trust levels and the autonomy profile were always per machine (decision 4): what the owner
     raised on the earlier holder was never applied on the new holder, so the new holder asks when the
     action comes up (unchanged by this spec, now stated);
   - a machine that joined after the legacy import has no legacy grants, so if it becomes holder its
     formerly legacy kinds are gated until approved there;
   - a backup restored onto a machine with a new machine id is a handover in this sense: its own
     stream becomes foreign (decision 2: at load, `checkAtLoad` scans the journal directory for
     `*.trust-grant-record*.jsonl` own-stream files named with another machine id, and own-file
     entries whose `origin` is not this machine; such entries are read as unattributed, id-keyed
     narrowing only), and because levels are only checked against own changes,
     any trust level or autonomy profile wider than the default for which this machine has no own
     change and no own legacy grant is narrowed to the default at load, with the restore owner line
     (this applies only when a foreign own-stream was detected, so single-machine agents and ordinary
     handovers are unaffected);
   - on a multi-machine agent, one-time approvals and open requests written before this build are
     asked again once after the upgrade (decision 7).
   The re-ask and re-accept lines name both machines ("I moved from <old> to <new>, so I need your OK
   again here"). They use the existing flows: no new authority and no new prompt type. A request the
   earlier holder issued is not answerable on the new holder: the owner's reply to it gets "That
   request was made on <old>; I will ask again here when it next comes up", and nothing changes.
7. **One-time grants and requests are valid only in the term that wrote them.** A *term* is this
   machine's run of lease epochs with no other holder in between. The trust runtime keeps two own
   local values in `state/trust-term.json`: `lastForeignEpoch` (the highest epoch known or presumed
   held by another machine) and `lastSeenEpoch` (the last epoch this machine observed). Rules:
   - On every observation of the coordinator's current lease (each poll via `currentLease()` and each
     `onEpochAdvance`): if another machine holds epoch E, `lastForeignEpoch = max(lastForeignEpoch,
     E)`; if this machine holds epoch E and `E > lastSeenEpoch + 1`, an epoch passed that this
     machine did not see, so `lastForeignEpoch = max(lastForeignEpoch, E - 1)`. A same-machine lapse
     re-acquire is exactly +1 (acquisition always writes the current epoch + 1, `FencedLease.ts`), so
     it never moves the boundary and pending approvals survive sleep or a restart past the lease time
     limit (`seamlessness.leaseTtlMs`). Then `lastSeenEpoch = max(lastSeenEpoch, E)`.
   - Same-epoch contests: any peer lease the coordinator observes (every effective-view fold,
     received broadcasts, and the contested branch where `splitBrainState` is `contested`) at an epoch
     N equal to or above this machine's own counts as foreign at N: `lastForeignEpoch = max(.., N)`.
     The coordinator gains one observer hook for this (`onPeerLeaseObserved(epoch, holder)`), called
     from those paths. So a woken holder that re-acquires at the same epoch as the peer that took over
     kills its own approvals for that epoch and earlier (denial at worst, never a double run).
   - Neither value is ever lowered. The file is not in the backup set; when it is missing or
     unreadable, `lastForeignEpoch` starts at `currentEpoch - 1` (only current-epoch records count).
     A stale copy restored by other means is caught by the gap rule, because its `lastSeenEpoch` is
     old.
   - The record key carries the epoch it was written in: `tj:action-approval:e<epoch>:<id>`,
     `tj:device-approval:e<epoch>:<id>`, acceptances and their withdrawals
     (`tj:acceptance:e<epoch>:<id>`, `tj:device-acceptance:e<epoch>:<id>` and the two withdrawal
     types), `change` records (`tj:change:e<epoch>:<id>`), and every request key form (the base request is written with
     an explicit `tj:request:e<epoch>:<id>` key instead of today's random or `tj:request:<id>` key; the
     own index keeps each request's epoch so its `:card` record is written as
     `tj:request:e<epoch>:<id>:card`; when they differ the earlier epoch governs). Keys are free-form
     strings and nothing parses `tj:` keys today, so no field or type changes.
   - An own record keyed `e<N>` counts if and only if N > `lastForeignEpoch`. An own request from an
     earlier term is answered like decision 6's "made earlier" case.
   - Single machine is decided by the machine registry (the pool lists only this machine), never by
     whether a coordinator exists. Single machine: epoch 0, the term never changes, nothing changes
     for the owner. More than one machine and the coordinator missing, failed or its epoch unknown
     (not yet loaded at boot): fail closed, no own one-time grant counts and `admit()` asks; nothing
     is written in that state.
   - Records written before this build carry no epoch in the key. On a multi-machine agent they do
     not count as one-time grants (one re-ask at upgrade, listed in decision 6); on a single machine
     they count as today.
   - Fresh view after wake: `admit()` grants proceed-once only if the lease view was refreshed (a
     poll, fold or broadcast observed) after the last wake or restart; otherwise it asks. This closes
     the window after a wake before a same-epoch peer lease is seen.
   - Admission recheck: after the `dispatch` write and before returning proceed-once, `admit()`
     re-reads `holdsLease()` and the current term; if either changed during the write, it returns
     "ask" (the approval is then used up, which is the safe side).
   - A peer can end a term only by actually holding the lease at a higher epoch (or by making this
     machine miss epochs, which fails closed), which is the residual "a compromised machine can take
     the lease"; a lease view the coordinator does not accept never reaches it.
8. **Denial by a peer is told honestly.** When the owner's real reply hits a request a peer closed or
   marked used (a non-own `consumption` or `request-status`), the reply is "Another of my machines
   closed that request, so nothing was approved; I will ask again when it next comes up", never
   "already approved". `applyOutcome` is read only for own consumptions.
9. **Visibility: counts, plus one provable case.** Peer grant records kept but not counted are counted by (type, writer),
   de-duplicated by (writer, recordKey) so a boot refold does not re-count, and returned by
   `GET /trust/summary` in a new `trustJourney` block (`peerGrantsIgnored`; each kind whose legacy grant
   a peer change ended, with writer and source; and `peerNarrowingOfCurrentTerm`, peer records that
   closed or used an own id from the current term, which an honest peer never does because only the
   holder consumes and dispatches), returned even when adaptive trust is absent (today that route
   404s without it). No forgery alarm: whether a peer was in charge when it wrote cannot be
   established, so the design does not judge ordinary peer grants. One case IS provable: a peer
   record that closes or uses an own id from the current term (`peerNarrowingOfCurrentTerm`), because
   during this machine's term no other machine consumes, dispatches or closes its requests. The
   notice fires only when the record arrived in a signature-verified `journal-sync` response or a
   signed push (decision 3), and only after re-reading the lease confirms this machine still holds it
   and that writer has not held it at or after the record's term (so an older-build or `"fold"` peer
   that took the lease and honestly consumed a request never triggers it); unsigned cases are counted
   only. The notice is also suppressed while `splitBrainState` is `contested`. The build enumerates
   every writer of `request-status`, `consumption` and `dispatch` with its lease guard (today all sit
   behind `holds()` / `onReceipt` or the holder-only admission path) and keeps that list in a test.
   `codeTaken` reads every writer's requests (it only blocks a code, never grants), so a new
   holder never reuses an id an earlier holder issued. The first such record from a given writer in a term sends the owner one plain notice through the existing
   owner channel (`notifyOwner`): "<machine> closed or used a request I made while I am in charge,
   which it should never do. Nothing was approved. If you do not recognise this, remove <machine> from
   my computers." It is a security-class signal, so it is sent at once (there is nothing to heal:
   the narrowing already only denied), at most once per writer per term, and every occurrence is
   counted and logged. Legacy grants ended by a peer change are not provable forgery (an earlier
   holder's real change also ends them) and stay a count.
10. **Asking again after a handover, and the standard it strains.** *Trust Is Earned by Work* says
    the same yes is never asked twice unless the person chooses to keep being asked. On the new holder
    the earlier yes is a record another machine wrote, which it cannot tell apart from a forgery, so it
    asks for a yes it can verify for the first time. In substance the owner is still asked again, and
    no wording change makes that their choice for acceptances already given, so this is stated as an
    exception for the approver to accept or refuse, not argued away. It is bounded to the list in
    decision 6 and to lease handovers; the handover count for the development agent's last 30 days is
    measured from the lease coordinator's acquisition records (each acquisition logs its epoch and holder) and put in the approval request. Lift condition: the identity
    work's signed owner record (piece 2, topic 144636) lets an owner-signed grant verify on any
    machine; the re-ask then goes away. That lift is tracked as a dated commitment opened with the
    build.
11. **Rollout and switch.** `trustJourney.peerGrants`: `"ignore"` (this spec) or `"fold"` (today).
    Resolution: an explicit `"ignore"` or `"fold"` wins; anything else (absent, or an invalid value,
    which is logged) resolves to `"ignore"` when `resolveDevAgentGate(undefined, config)` is true or
    `config.throwawayAgent` is set, else `"fold"` on the fleet until the fleet rung, after which the
    fallback becomes `"ignore"` by a reviewed code change. No config default is written by the
    migrator. No shadow mode: the rule only removes trust, and a watch-only mode would leave the
    forgery open while it watches (*A Dark Feature Guards Nothing*). A resolved `"fold"` on a
    multi-machine agent logs at every boot: "Trust records written by other machines are being
    honoured (N grants from other machines are live now)". Single-machine agents see no change at any
    setting. *A Dark Feature Guards Nothing* applies to the fleet window: the spec's approval request
    asks the approver to record acceptance of the fleet running today's behaviour (`"fold"`, the
    manual fallback being the owner's own review of approvals) for at most the dark window below, or
    to choose `"ignore"` fleet-wide from merge instead. The approval record is that acceptance.
12. **Merge order.** Part 1 (PR 3403) merges first; this build rebases on it and replaces its
    "send it again" wording only where decision 6 says so.
13. **Device re-accept on the new holder is proven before the fleet rung.** Phone pairings are per
    machine. The test-agent rung proves whether a phone paired to the old holder can re-accept on the
    new holder with the existing flow. If it cannot, approvals on the new holder use the chat channel
    until the owner opens the new holder in the app once (the existing pairing flow), and the re-accept
    line says so. No app change is in scope; if one turns out to be needed it is filed with the app
    owner as its own item, and the fleet rung waits on it.

14. **Two items the approver decides, named in the approval request:** (a) decision 10's exception to
    *Trust Is Earned by Work* (re-ask after a handover until identity piece 2 lands); (b) decision
    11's fleet window; (c) decision 4's per-machine trust levels, an operator-ratified exception to
    *An Instar Agent Is Always a Multi-Machine Entity* until identity piece 2. The approver is the
    operator (Justin), not the Chief of Staff, because (a) and (c) are exceptions to constitutional
    standards and (b) is a dark-window acceptance. Both answers to (b)
    are buildable without further review: accepting the window builds decision 11 as written;
    choosing "ignore" fleet-wide makes the fallback resolve to `"ignore"` everywhere and the fleet rung
    collapses into merge. Refusing (a) or (c) sends the spec back to review. Neither is an open question for
    the build.
### Record-type table (closed: every value of `TRUST_RECORD_TYPES`)

| Type | Own writer (grant side) | Any writer (narrowing side) |
|---|---|---|
| `request` | answerable request (own index, current epoch) | none (a peer request never enters the own index) |
| `request-status` | closes own request | closes the named request id |
| `receipt` | first-hand receipt (part 1) | none |
| `acceptance-sent` | precondition for an acceptance | none |
| `acceptance` | account path accepted | none |
| `acceptance-withdrawn` | removes an acceptance | removes the named acceptance id; a peer withdrawal keyed at epoch W also ends every own acceptance for the same `principal|adapter` whose key epoch is W or lower (pre-build acceptances count as lower). Order-free; a re-acceptance at a later epoch survives, and it reaches an acceptance the withdrawing machine never saw |
| `consumption` | records an approve; backs a raise at load | marks the request id and receipt id used |
| `change` | proven level, load check, legacy validity | ends this machine's legacy grant for the kind unless its source is `revoked` or `default` (decision 5); nothing else |
| `legacy-grant` | own legacy behaviour (`machine` = this machine) | none; never imported |
| `action-approval` | proceed-once (current term only) | none |
| `dispatch` | marks approval used | marks the named approval id used |
| `device-acceptance` | device may approve | marks its `approvalId` used |
| `device-acceptance-withdrawn` | removes a device | removes the named acceptance id; a peer withdrawal keyed at epoch W also ends every own acceptance for the same `deviceId` (the field the record already carries) keyed at W or lower (same rule) |
| `device-approval` | approves a new device (current term only) | none |
| `apply-outcome` | outcome of an own consumption | none |
| any type, unreadable (unknown field or `minReader`) | today's unreadable handling for own records | only the id-keyed narrowing of its type (used, closed, withdrawn); never `unreadableKeys` |

### Query table (closed: every read the store exposes)

| Query | Reads |
|---|---|
| `codeTaken` | every writer's requests (blocks a code only, never grants) |
| `request`, `openRequests`, `allRequests`, `requestByCode`, `requestByCard` | own index, status from the narrowing set; the device listing, `propose()` de-duplication and `MAX_OPEN_REQUESTS` go through these, so peer requests are never shown, never suppress an ask and never fill the cap |
| `receipt`, `receiptConsumed` | own receipts; consumed from the narrowing set |
| `acceptance`, `acceptanceStatementSent` | own index minus narrowing withdrawals |
| `consumption`, `consumptionOf`, `requestConsumedOrPending`, `applyOutcome` | own index; `requestConsumedOrPending` is also true when the narrowing set has the request used |
| `deviceAcceptance`, `currentDeviceAcceptances`, `deviceAcceptanceWithdrawn` | own index minus narrowing |
| `unusedDeviceApprovals`, `deviceApproval` | own, current term, minus narrowing (`deviceApproval` returns null for a peer or earlier-term approval) |
| `deviceAcceptanceHistory` | all records, each marked own or "from <machine>, not counted here" |
| `changeLog`, `lastChange` | own changes in own journal sequence order |
| `legacyGrants`, `legacyKeys`, `unchangedLegacyKeys`, `legacyUnchanged` | own legacy grants; decision 5 |
| `legacyImportedAnywhere` (new) | every writer's legacy grants, evidence only: decides joining-machine status for the import, never grants |
| `unusedActionApproval` | own, current term, minus narrowing |
| `hasUnreadableHistory` | own unreadable `change` records only; an unreadable peer record keeps only its id-keyed narrowing (see the record table) |

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A replicated record grants on this machine | invariant; basis: irreversible-consequence; evidence: a proceed-once runs a governed action and a device acceptance lets a device approve raises, neither undone before it takes effect | Grants only from own writes |
| A peer record narrows on this machine | invariant; basis: enumerable-domain; evidence: the closed narrowing column of the record-type table | Refusing a narrowing would leave authority in place |
| Legacy grant validity | invariant; basis: enumerable-domain; evidence: the grant's own `afterChange`, own changes, and peer changes outside the closed automatic-source list (`revoked`, `default`) from `TrustSource` | No ordering; honest standby restores do not end it |
| Levels read only from own changes | invariant; basis: external-constraint; evidence: no grant one machine can verify on another exists before identity piece 2 | A peer change describes the peer's level; approver item 14c |
| One-time grants and requests limited to the current term | invariant; basis: irreversible-consequence; evidence: a proceed-once used twice runs an action the owner approved once | Counts iff epoch > lastForeignEpoch; unknown epoch fails closed |
| Narrowing raised levels after a new-id restore | invariant; basis: irreversible-consequence; evidence: a restored raised level with no own record behind it would run actions unproven here | Only when a foreign own-stream is detected |
| Pre-build one-time records on a multi-machine agent | invariant; basis: irreversible-consequence; evidence: their term cannot be known, and a hand-back before the upgrade would let one yes run twice | One re-ask at upgrade |
| Invalid `trustJourney.peerGrants` value | invariant; basis: enumerable-domain; evidence: the two valid values | Logged; resolves as absent |
| Admission recheck after the dispatch write | invariant; basis: irreversible-consequence; evidence: a handover during the write would admit on an obsolete term | Returns ask; the approval stays used |
| Own stream ownership | invariant; basis: external-constraint; evidence: the stamped origin compared with this machine's current id | Origin can only remove ownership |
| Owner notice on a peer closing or using a current-term own id | invariant; basis: enumerable-domain; evidence: during this machine's term only it consumes, dispatches and closes its own requests; only signature-verified records from a writer that has not held the lease since | Once per writer per term, sent at once by the holder |
| Peer non-automatic `change` at epoch W -> ask-first unless own change above W | invariant; basis: irreversible-consequence; evidence: an owner lowering on another holder would otherwise be lost on a hand-back | Order-free; checked after an own unused approval |
| Peer withdrawal at epoch W ends own acceptances of the subject at W or lower | invariant; basis: irreversible-consequence; evidence: a revoked device approving again after a hand-back | Order-free; later re-acceptance survives |
| Proceed-once needs a lease view refreshed since wake | invariant; basis: irreversible-consequence; evidence: a same-epoch peer lease unseen after wake could allow a double run | Asks until refreshed |
| Honest denial line (decision 8) | invariant; basis: enumerable-domain; evidence: the request was closed or used by a non-own record | Never "already approved" |
| Writer identity of a record | invariant; basis: external-constraint; evidence: the authenticated sender (asked machine on pull, signed `env.sender` on push) and the replica file's machine | Never a payload field |
| `journal-sync` response signature | invariant; basis: external-constraint; evidence: the registered Ed25519 machine key; invalid -> trust records refused; absent -> accepted, narrowing-only, which is every peer record's ceiling | No ratchet |
| Origin mismatch on a trust record | invariant; basis: enumerable-domain; evidence: the existing `forged` verdict used for `failure-callout-chunk` | Batch stops, nothing appended |
| Re-ask and re-accept lines after a handover | invariant; basis: enumerable-domain; evidence: the existing approval and acceptance flows, worded per decision 6 | No new prompt or authority |
| Boot warning under `"fold"` | invariant; basis: irreversible-consequence; evidence: peer grants become live on that boot | Tells the operator the protection is off |
| Fleet default of `trustJourney.peerGrants` | judgment-candidate; floor: `"fold"` on the fleet until the reviewed change; arbiter: the recurring maturation review (two independent readings) | Maturation Path |
| Dark window before the fleet decision (21 days) | judgment-candidate; floor: if the criterion is unmet the reason is recorded and an extension needs the operator's renewed acceptance; arbiter: the maturation review and the operator | A review deadline, never an automatic flip |
| Graduation criterion | judgment-candidate; floor: the measurable conditions in the maturation plan; arbiter: the maturation review | Thresholds raise, the review decides |

## Multi-machine posture

Unified. Every trust record replicates to every machine through the existing `trust-grant-record`
journal and is kept everywhere; every machine applies the same narrowing set. What differs per
machine is only which records count as grants, which is the rule itself (a grant counts where it was
written), not a machine-local store. `GET /trust/summary` reports this machine's counts; no pooled
read is added because only the lease holder acts on approvals.

## Maturation plan

- **test-agent-live:** a throwaway two-machine agent (the standing two-machine route), `"ignore"`: the
  build drives a lease handover, a forged `action-approval`, a forged `change` on an unused kind, a
  reused `requestId` with a `cardMessageId`, a forged `legacy-grant`, a standby's load-time restore, an
  owner reply to the old holder's open request, a device re-accept on the new holder (decision 13)
  and a hand-back with an unused approval; each must give the verdict the tests name, seen in
  `/trust/summary`.
- **dev-agent-live:** `"ignore"` on the development agent's machines from merge. Evidence rows in
  `logs/feature-evidence.jsonl`: one per newly counted ignored peer grant (type, writer) and one per
  handover re-ask with its outcome (answered and the answer honoured, or unanswered).
- **fleet:** default `"ignore"` after review of the dev-agent rung.
- **graduation criterion:** at least one real lease handover on the development agent; every ignored
  peer grant listed for the review with its writer; every re-ask answered and the answer honoured (a
  "no" honoured counts); the re-ask count per handover and handovers per week reported to the review
  (lease flapping multiplies re-asks); both channels (chat acceptance and app device
  re-accept) observed live or proven on the test-agent rung. A period with zero handovers is not a
  pass.
- **dark-window:** a review deadline of 21 days from merge to the fleet decision. If the criterion is
  not met by then, the reason is recorded and extending the fleet's `"fold"` window needs the
  operator's renewed acceptance (decision 14b), never only a new date.
- **ladder:** trustJourney.peerGrants

## Honest residuals

- **A compromised machine can take the lease** through the medium and grant during its own term. That
  needs the owner's device signature on every grant: identity piece 2 (topic 144636). Dependency, not
  closed here.
- **Denial**: a peer can close a request, mark an approval used, withdraw an acceptance by id, or end
  a legacy grant with a forged change of any non-automatic source (permanent for that kind until the
  owner approves it here). It never grants, it is counted, and the owner is told honestly (decision 8).
- **Same-id restore**: restoring a backup onto the same machine id brings back approvals dispatched
  after the backup was taken (single machine, and multi-machine because the applier refuses replicas
  claiming its own id). That is today's behaviour, unchanged.
- **Split brain**: during a partition two machines can briefly both believe they hold the lease; if
  A never learns of B's term, A's earlier approvals stay current. Part of the lease-medium residual.
- **Own journal rotation**: `trust-grant-record` keeps no rotated files (`rotateKeep: 0`); records
  lost to rotation are lost today too. Unchanged by this spec; filed through the feedback system as its own item when the build starts.
- **Unsigned or stripped responses** let a network impersonator of a peer inject narrowing (denial
  only).
- **Registry integrity**: machine keys and URLs come from the machine registry (SEC-042 / identity
  piece 2).
- **Own stream on disk**: `.instar/state/` is not git-synced. Backups hold own and peer streams; a
  restore onto a new machine id turns own grants into peer records (re-asked, decision 6).

## Open questions

*(none)*

## Rollback

Set `trustJourney.peerGrants` to `"fold"` and restart, or revert the release. Either way every peer
grant kept as evidence becomes live again on that boot (that is what "fold" means); the boot warning
says how many. No record type or field changes: the epoch is part of the record key, and the signature and
`requesterNonce` are additive wire fields older builds ignore. An older build reads an epoch-keyed
approval as an ordinary approval (today's behaviour). A mixed-version pool replicates in both directions; older builds keep first-wins on
`recordKey` and fold peer grants, which is today's behaviour on those machines.

## Tests

- Unit (store): every row of both tables, own vs peer; a peer request reusing an own `requestId` with
  a `cardMessageId` never replaces the own request; a peer `change` on a kind with no own change leaves
  it "ask"; a peer change with a reused or missing `changeId` and a far-future `at` never re-validates
  a legacy grant; peer changes of sources `user-explicit`, `earned`, `config`, `route`, missing and
  unknown end it, and `revoked` and `default` do not; peer legacy grants
  are never imported; a peer `consumption` gives the honest denial line; a peer consumption of a current-term own request sends one owner notice and a second does not; a boot refold gives the same
  state as the live fold for any file enumeration order and does not re-count `peerGrantsIgnored`.
- Unit (applier): an invalid response signature is refused and counted; an unsigned response is
  accepted with trust records narrowing-only; an origin mismatch is `forged`; a replica claiming this
  machine's id is refused; the trust store's boot union takes the writer from the replica file and
  first-wins per (writer, key).
- Unit (handover): grants from A are absent on B; `admit()` on B starts a fresh request with the
  decision 6 line; the owner's reply to A's request on B gets the "made on <old>" line; A -> B -> A
  leaves A's earlier-term approvals and requests dead; a restart of the same holder keeps them; a
  lapse re-acquire past the lease limit (sleep) with no other holder keeps them; an unknown epoch at
  boot asks; a lost `trust-term.json` counts only current-epoch records; a missed foreign term (A down
  while B held, A re-acquires two epochs later) is caught by the gap rule; a woken holder that
  re-acquires at the same epoch as the peer that took over treats that epoch as foreign; `lastForeignEpoch` never
  decreases; a multi-machine agent with no coordinator asks; a withdrawal on B removes A's acceptance
  for the same subject after a hand-back even when A's acceptance never replicated to B, and a
  re-acceptance on A at a later epoch still counts; an existing legacy grant whose `afterChange` names a peer
  change survives the upgrade; a new-id restore narrows raised levels with no own record; A raises, the owner lowers on B, hand-back to A asks; a pre-build history C1, C2 with a grant anchored to C2 survives the upgrade; a joining machine with no own grants still detects that another machine imported; admit right after a wake asks until the view refreshes; a handover
  during the dispatch write returns ask; a restored stream from another machine
  id is foreign; an unreadable peer `change` never puts a kind into unreadable history; a
  single-machine agent (epoch 0) is unchanged; a standby's boot after a handover changes nothing on
  the holder.
- Integration: two-machine fixture over the real `journal-sync` route; a forged `action-approval` from
  the non-holder never yields proceed-once; `/trust/summary` shows the `trustJourney` block with and
  without adaptive trust.
- E2E (alive): production boot path on a two-machine fixture; `"fold"` restores today's behaviour with
  the boot warning.
- Wiring: `fold` receives a non-empty writer and the local machine id on every path (boot, own commit,
  pull, push).
