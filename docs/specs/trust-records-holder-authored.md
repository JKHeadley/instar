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
at the round cap. Its report recommended this simpler design, which the Chief of Staff approved on
2026-11-18 01:45 PST with its cost accepted.

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
   stream files; for a replica, the machine the replica file belongs to, which the applier set from
   the authenticated sender (the machine asked on the pull path, `env.sender` of the signed mesh
   request on the push path). Never a payload field: today the boot union sets `receivedBy: r.origin`
   from the payload, and `ReplicatedPeerStreamReader.materialize` keeps the newest record per
   (origin, recordKey) by HLC. For the trust store only (other stores unchanged), a new reader method
   returns every record with its writer taken from the applier's per-peer meta (replica file names are
   sanitised ids, not raw ids), and the first record per (writer, recordKey) wins, as in the live fold.
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
   machine-local files; a `change` record describes the level of the machine that wrote it. So
   `provenLevel(kind)`, `changeLog`, `lastChange` and the load-time proof check read only own `change`
   records, and a peer's `change` never affects this machine's levels in either direction. A kind with
   no own `change` keeps today's rule ("no recorded grant means Ask me first"). There is no peer-driven
   "ask-first" state (round 2: it was order-dependent and honest standbys triggered it).
5. **Legacy grants are own-only and end on any owner-governed change.**
   - `legacyUnchanged(kind, self)` holds only if this machine's own legacy grant exists AND no `change`
     record for that kind exists other than the exact own record named by `afterChange`, counting own
     changes of any source and peer changes whose `source` is `person` (a change the owner approved).
     A `change` with a missing `changeId` counts. No ordering is used. Peer changes of other sources
     (a standby's load-time restore, a route, a default) describe that machine's own levels and do not
     end this machine's legacy grant, so an honest standby never removes one.
   - A peer can end a legacy grant by forging a `person` change: denial, permanent for that kind until
     the owner approves the kind on this machine. Listed under residuals and shown on `/trust/summary`.
   - The legacy import on a joining machine imports nothing from peers; a joining machine starts
     with no legacy grants, so its kinds are gated ("ask") until approved there.
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
   - a backup restored onto a machine with a new machine id is a handover in this sense.
   The re-ask and re-accept lines name both machines ("I moved from <old> to <new>, so I need your OK
   again here"). They use the existing flows: no new authority and no new prompt type. A request the
   earlier holder issued is not answerable on the new holder: the owner's reply to it gets "That
   request was made on <old>; I will ask again here when it next comes up", and nothing changes.
7. **One-time grants and requests are valid only in the lease epoch that wrote them.** The record
   key carries the epoch: `tj:action-approval:e<epoch>:<id>`, `tj:device-approval:e<epoch>:<id>`,
   `tj:request:e<epoch>:<id>` (keys are free-form strings today; no field or type changes, so older
   builds read them unchanged). An own approval or request counts only when its key's epoch equals
   the current lease epoch; an own request from an earlier epoch is answered like decision 6's "made
   earlier" case. The epoch is the lease coordinator's epoch, unchanged across a restart of the same
   holder, so a restart never drops pending approvals; with no lease coordinator (single machine) it
   is the constant 0, so single-machine agents see no change. Records written before this build carry
   no epoch in the key and count only while the epoch is still the one current at the first boot of
   this build (recorded once in the trust runtime's state). No record is written at acquisition and
   there is no race with `admit()`: the check is a comparison at read time. A hand-back A -> B -> A
   moves to a new epoch, so A's approvals from its earlier term are dead.
8. **Denial by a peer is told honestly.** When the owner's real reply hits a request a peer closed or
   marked used (a non-own `consumption` or `request-status`), the reply is "Another of my machines
   closed that request, so nothing was approved; I will ask again when it next comes up", never
   "already approved". `applyOutcome` is read only for own consumptions.
9. **Visibility, counts only.** Peer grant records kept but not counted are counted by (type, writer),
   de-duplicated by (writer, recordKey) so a boot refold does not re-count, and returned by
   `GET /trust/summary` in a new `trustJourney` block (`peerGrantsIgnored`, and the kinds whose legacy
   grant a peer `person` change ended), returned even when adaptive trust is absent (today that route
   404s without it). No forgery alarm: whether a peer was in charge when it wrote cannot be
   established, so the design does not judge it; a real forgery is therefore only a count nobody is
   pushed to read, which the approver should know.
10. **Asking again after a handover, and the standard it strains.** *Trust Is Earned by Work* says
    the same yes is never asked twice unless the person chooses to keep being asked. On the new holder
    the earlier yes is a record another machine wrote, which it cannot tell apart from a forgery, so it
    asks for a yes it can verify for the first time. In substance the owner is still asked again, and
    no wording change makes that their choice for acceptances already given, so this is stated as an
    exception for the approver to accept or refuse, not argued away. It is bounded to the list in
    decision 6 and to lease handovers; the handover count for the development agent's last 30 days is
    measured from the lease history and put in the approval request. Lift condition: the identity
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
14. **Two items the approver decides, named in the approval request:** (a) decision 10's exception to
    *Trust Is Earned by Work* (re-ask after a handover until identity piece 2 lands); (b) decision
    11's fleet window. Neither is an open question for the build: the build ships decision 10 as
    written and decision 11 with the window; a refusal of either sends the spec back to review.
12. **Merge order.** Part 1 (PR 3403) merges first; this build rebases on it and replaces its
    "send it again" wording only where decision 6 says so.
13. **Device re-accept on the new holder is proven before the fleet rung.** Phone pairings are per
    machine. The test-agent rung proves whether a phone paired to the old holder can re-accept on the
    new holder with the existing flow. If it cannot, approvals on the new holder use the chat channel
    until the owner opens the new holder in the app once (the existing pairing flow), and the re-accept
    line says so. No app change is in scope; if one turns out to be needed it is filed with the app
    owner as its own item, and the fleet rung waits on it.

### Record-type table (closed: every value of `TRUST_RECORD_TYPES`)

| Type | Own writer (grant side) | Any writer (narrowing side) |
|---|---|---|
| `request` | answerable request (own index, current epoch) | none (a peer request never enters the own index) |
| `request-status` | closes own request | closes the named request id |
| `receipt` | first-hand receipt (part 1) | none |
| `acceptance-sent` | precondition for an acceptance | none |
| `acceptance` | account path accepted | none |
| `acceptance-withdrawn` | removes an acceptance | removes the named acceptance id |
| `consumption` | records an approve; backs a raise at load | marks the request id and receipt id used |
| `change` | proven level, load check, legacy validity | `source: person` ends this machine's legacy grant for the kind (decision 5); nothing else |
| `legacy-grant` | own legacy behaviour (`machine` = this machine) | none; never imported |
| `action-approval` | proceed-once (current term only) | none |
| `dispatch` | marks approval used | marks the named approval id used |
| `device-acceptance` | device may approve | marks its `approvalId` used |
| `device-acceptance-withdrawn` | removes a device | removes the named acceptance id |
| `device-approval` | approves a new device (current term only) | none |
| `apply-outcome` | outcome of an own consumption | none |

### Query table (closed: every read the store exposes)

| Query | Reads |
|---|---|
| `request`, `openRequests`, `allRequests`, `requestByCode`, `requestByCard`, `codeTaken` | own index, status from the narrowing set; the device listing, `propose()` de-duplication and `MAX_OPEN_REQUESTS` go through these, so peer requests are never shown, never suppress an ask and never fill the cap |
| `receipt`, `receiptConsumed` | own receipts; consumed from the narrowing set |
| `acceptance`, `acceptanceStatementSent` | own index minus narrowing withdrawals |
| `consumption`, `consumptionOf`, `requestConsumedOrPending`, `applyOutcome` | own index; `requestConsumedOrPending` is also true when the narrowing set has the request used |
| `deviceAcceptance`, `currentDeviceAcceptances`, `deviceAcceptanceWithdrawn` | own index minus narrowing |
| `unusedDeviceApprovals` | own, current epoch, minus narrowing |
| `deviceAcceptanceHistory` | all records, each marked own or "from <machine>, not counted here" |
| `changeLog`, `lastChange` | own changes in own arrival order |
| `legacyGrants`, `legacyKeys`, `unchangedLegacyKeys`, `legacyUnchanged` | own legacy grants; decision 5 |
| `unusedActionApproval` | own, current epoch, minus narrowing |
| `hasUnreadableHistory` | unchanged |

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A replicated record grants on this machine | invariant; basis: irreversible-consequence; evidence: a proceed-once runs a governed action and a device acceptance lets a device approve raises, neither undone before it takes effect | Grants only from own writes |
| A peer record narrows on this machine | invariant; basis: enumerable-domain; evidence: the closed narrowing column of the record-type table | Refusing a narrowing would leave authority in place |
| Legacy grant validity | invariant; basis: enumerable-domain; evidence: the grant's own `afterChange`, own changes, and peer changes with `source: person` | No ordering; honest standby restores do not end it |
| Levels read only from own changes | invariant; basis: external-constraint; evidence: trust and autonomy levels live in machine-local state files | A peer change describes the peer's level |
| One-time grants and requests limited to the current lease epoch | invariant; basis: irreversible-consequence; evidence: a proceed-once used twice runs an action the owner approved once | Read-time key comparison; restart keeps the epoch |
| Honest denial line (decision 8) | invariant; basis: enumerable-domain; evidence: the request was closed or used by a non-own record | Never "already approved" |
| Writer identity of a record | invariant; basis: external-constraint; evidence: the authenticated sender (asked machine on pull, signed `env.sender` on push) and the replica file's machine | Never a payload field |
| `journal-sync` response signature | invariant; basis: external-constraint; evidence: the registered Ed25519 machine key; invalid -> trust records refused; absent -> accepted, narrowing-only, which is every peer record's ceiling | No ratchet |
| Origin mismatch on a trust record | invariant; basis: enumerable-domain; evidence: the existing `forged` verdict used for `failure-callout-chunk` | Batch stops, nothing appended |
| Re-ask and re-accept lines after a handover | invariant; basis: enumerable-domain; evidence: the existing approval and acceptance flows, worded per decision 6 | No new prompt or authority |
| Boot warning under `"fold"` | invariant; basis: irreversible-consequence; evidence: peer grants become live on that boot | Tells the operator the protection is off |
| Fleet default of `trustJourney.peerGrants` | judgment-candidate; floor: `"fold"` on the fleet until the reviewed change; arbiter: the recurring maturation review (two independent readings) | Maturation Path |
| Dark window before the fleet decision (21 days) | judgment-candidate; floor: the reason and a new date are recorded if the criterion is unmet; arbiter: the maturation review | A review date, never an automatic flip |
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
  "no" honoured counts); both channels (chat acceptance and app device
  re-accept) observed live or proven on the test-agent rung. A period with zero handovers is not a
  pass.
- **dark-window:** at most 21 days from merge to the fleet decision; if the criterion is not met by
  then, the reason and a new date are recorded on the maturation track.
- **ladder:** trustJourney.peerGrants

## Honest residuals

- **A compromised machine can take the lease** through the medium and grant during its own term. That
  needs the owner's device signature on every grant: identity piece 2 (topic 144636). Dependency, not
  closed here.
- **Denial**: a peer can close a request, mark an approval used, withdraw an acceptance by id, or end
  a legacy grant with a forged `person` change (permanent for that kind until the owner approves it
  here). It never grants, it is counted, and the owner is told honestly (decision 8).
- **Own journal rotation**: `trust-grant-record` keeps no rotated files (`rotateKeep: 0`); records
  lost to rotation are lost today too. Unchanged by this spec; noted for the trust journey's owner.
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
  a legacy grant; a peer `person` change ends it and a peer restore change does not; peer legacy grants
  are never imported; a peer `consumption` gives the honest denial line; a boot refold gives the same
  state as the live fold for any file enumeration order and does not re-count `peerGrantsIgnored`.
- Unit (applier): an invalid response signature is refused and counted; an unsigned response is
  accepted with trust records narrowing-only; an origin mismatch is `forged`; a replica claiming this
  machine's id is refused; the trust store's boot union takes the writer from the replica file and
  first-wins per (writer, key).
- Unit (handover): grants from A are absent on B; `admit()` on B starts a fresh request with the
  decision 6 line; the owner's reply to A's request on B gets the "made on <old>" line; A -> B -> A
  leaves A's earlier-epoch approvals and requests dead; a restart of the same holder keeps them; a
  single-machine agent (epoch 0) is unchanged; a standby's boot after a handover changes nothing on
  the holder.
- Integration: two-machine fixture over the real `journal-sync` route; a forged `action-approval` from
  the non-holder never yields proceed-once; `/trust/summary` shows the `trustJourney` block with and
  without adaptive trust.
- E2E (alive): production boot path on a two-machine fixture; `"fold"` restores today's behaviour with
  the boot warning.
- Wiring: `fold` receives a non-empty writer and the local machine id on every path (boot, own commit,
  pull, push).
