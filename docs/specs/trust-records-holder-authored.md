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
   one-time grants, only during the lease term that wrote it.
2. A record another machine wrote can only CLOSE, USE or NARROW, and only through effects keyed to
   ids or to a kind as a whole ("ask me first"); it never reads into a grant.
3. Order is this machine's own arrival order, never a timestamp a writer chose.

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
     withdrawn acceptance ids, used device-approval ids, dispatched action identities, and
     "ask-first" kinds (decision 4).
   Every grant-side query reads the own index only; every "is it used / closed / withdrawn" check
   also reads the narrowing set. Records are keyed by (writer, recordKey), so a peer cannot occupy a
   key this machine is about to write. The closed query table below is part of the decision.
2. **The writer is transport-derived.** The writer reaching `fold` is: this machine for its own
   stream files; for a replica, the machine the replica file belongs to, which the applier set from
   the authenticated sender (the machine asked on the pull path, `env.sender` of the signed mesh
   request on the push path). Never a payload field: today the boot union sets `receivedBy: r.origin`
   from the payload, and `ReplicatedPeerStreamReader.materialize` keeps the newest record per
   (origin, recordKey) by HLC. For the trust store only (other stores unchanged), the writer is the
   replica file's machine and the first record per (writer, recordKey) wins, as in the live fold.
   The applier refuses a replica whose sender is this machine's own id. `validateEntry` adds
   `trust-grant-record` to the origin-must-equal-sender kinds and treats a mismatch as
   `failure-callout-chunk` is treated today (`forged`: the batch stops, nothing appended, counted).
   An honest peer cannot mismatch because `journalSink` stamps `origin` from the emitter, so no
   placeholder machinery is added.
3. **Signed `journal-sync` responses, for attribution only.** The `journal-sync` MeshRpc response
   carries the serving machine's Ed25519 signature over
   `['journal-sync-response', responder, requesterNonce, kind, incarnation, fromSeq, sha256(canonical entries)]`,
   following the agent-identity verbs' signed-response pattern (`AgentIdentityAdoption.ts`); the
   request gains `requesterNonce`, which older servers ignore. The client verifies against the
   registered key of the machine it asked. A response with an INVALID signature is refused for every
   kind and counted (`journal.sync.badSignature`). A response with NO signature (an older build) is
   accepted as today; its trust records count only for narrowing, which is all a peer's records can do
   under this design anyway. There is no "signed once, always signed" ratchet: it would freeze a peer
   that rolls back, and an unsigned response risks only narrowing attributed to the wrong machine
   (denial), never a grant. Signing does not make a peer record able to grant; it keeps attribution of
   narrowing and of the counts honest.
4. **`change` records from a peer narrow a kind to "ask me first", never more.**
   - `provenLevel(kind)` and `checkAtLoad` read only own `change` records.
   - A kind for which a peer `change` record arrived after this machine's latest own `change` for that
     kind (own arrival order) is in the ask-first set: admission treats it like `hasUnreadableHistory`
     today ("Ask me first"), and the load-time proof check narrows its stored level. A later own
     `change` for the kind (the owner approved again here) clears it.
   - Direction fields in a peer `change` are ignored; nothing is recomputed.
   - So a first peer change on a kind with no own history can never lift it out of "ask", and an
     earlier holder's raises become "ask" on the new holder (decision 6).
5. **Legacy grants are own-only and die irreversibly.**
   - `legacyUnchanged(kind, self)` holds only if this machine's own legacy grant exists AND no `change`
     record for that kind from ANY writer exists other than the exact own record named by
     `afterChange`. A `change` with a missing `changeId` counts as a change. No `at` ordering.
   - The legacy import on a joining machine imports nothing from peers; a joining machine starts
     with no legacy grants, so its kinds are gated ("ask") until approved there. This narrows and is
     accepted.
6. **After a handover, earlier holders' grants are absent and are re-asked on the next attempt.** No
   migration copies them and no new record type adopts them. The owner-visible cost, stated in full:
   - each pending approval is asked again on the new holder the next time the action is attempted;
   - each channel's acceptance (chat `acceptance`, app `device-acceptance`) is asked once on the new
     holder before approvals there count;
   - trust levels and the autonomy profile raised on the earlier holder are narrowed at load on the
     new holder (the existing load-time check, whose owner line becomes "I restored N trust settings to
     ask first after moving to <machine>; I will ask you again when each comes up"), and re-asked on
     use;
   - a backup restored onto a machine with a new machine id is a handover in this sense.
   The re-ask and re-accept lines name both machines ("I moved from <old> to <new>, so I need your OK
   again here"). They use the existing flows: no new authority and no new prompt type. A request the
   earlier holder issued is not answerable on the new holder: the owner's reply to it gets "That
   request was made on <old>; I will ask again here when it next comes up", and nothing changes.
7. **One-time grants are valid only in the term that wrote them.** On every lease acquisition
   (including a hand-back A -> B -> A), the new holder writes `request-status: superseded` for its own
   open requests and an own record listing its unused `action-approval` and `device-approval` ids
   written before this acquisition, which marks them used. A `dispatch` from any writer marks every
   known approval for the same `actionIdentity` used (the field is already on `dispatch` records), so
   a hand-back can never run one yes twice.
8. **Denial by a peer is told honestly.** When the owner's real reply hits a request a peer closed or
   marked used (a non-own `consumption` or `request-status`), the reply is "Another of my machines
   closed that request, so nothing was approved; I will ask again when it next comes up", never
   "already approved". `applyOutcome` is read only for own consumptions.
9. **Visibility, counts only.** Peer grant records kept but not counted are counted by (type, writer),
   de-duplicated by (writer, recordKey) so a boot refold does not re-count, and shown on
   `GET /trust/summary` as `peerGrantsIgnored`, with the ask-first kinds caused by peer changes. No
   forgery alarm: whether a peer was in charge when it wrote cannot be established (round 1, three
   reviewers), so the design does not judge it. The maturation evidence rows come from the same counts.
10. **Asking again after a handover is not asking the same yes twice.** *Trust Is Earned by Work* says
    the same yes is never asked twice. On the new holder the earlier yes is a record another machine
    wrote, which it cannot tell apart from a forgery; it is asking for a yes it can verify for the
    first time. The cost is bounded to the list in decision 6, and handovers are rare (hand-back is
    off by default). Lift condition: the identity work's signed owner record (piece 2, topic 144636)
    lets an owner-signed grant verify on any machine; this re-ask then goes away.
11. **Rollout and switch.** `trustJourney.peerGrants`: `"ignore"` (this spec) or `"fold"` (today).
    Resolved through `resolveDevAgentGate` with no config default written by the migrator: development
    and throwaway agents resolve `"ignore"` from merge; the fleet resolves `"fold"` until the fleet
    rung, then the default becomes `"ignore"` by a reviewed code change. No shadow mode: the rule only
    removes trust, and a watch-only mode would leave the forgery open while it watches (*A Dark Feature
    Guards Nothing*). An explicit or resolved `"fold"` on a multi-machine agent logs at every boot:
    "Trust records written by other machines are being honoured (N grants from other machines are live
    now)". Single-machine agents see no change at any setting.
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
| `request` | answerable request (own index) | none (a peer request never enters the own index) |
| `request-status` | closes own request | closes the named request id |
| `receipt` | first-hand receipt (part 1) | none |
| `acceptance-sent` | precondition for an acceptance | none |
| `acceptance` | account path accepted | none |
| `acceptance-withdrawn` | removes an acceptance | removes the named acceptance id |
| `consumption` | records an approve; backs a raise at load | marks the request id and receipt id used |
| `change` | proven level, load check, legacy validity | kind enters ask-first (decision 4); invalidates legacy (decision 5) |
| `legacy-grant` | own legacy behaviour (`machine` = this machine) | none; never imported |
| `action-approval` | proceed-once (current term only) | none |
| `dispatch` | marks approval used | marks the approval id and every approval for its `actionIdentity` used |
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
| `deviceAcceptance`, `currentDeviceAcceptances`, `deviceAcceptanceWithdrawn`, `unusedDeviceApprovals` | own index minus narrowing |
| `deviceAcceptanceHistory` | all records, each marked own or "from <machine>, not counted here" |
| `changeLog`, `lastChange` | own changes in own arrival order |
| `legacyGrants`, `legacyKeys`, `unchangedLegacyKeys`, `legacyUnchanged` | own legacy grants; decision 5 |
| `unusedActionApproval` | own, current term, minus narrowing |
| `hasUnreadableHistory` | unchanged, plus the ask-first set |

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A replicated record grants on this machine | invariant; basis: irreversible-consequence; evidence: a proceed-once runs a governed action and a device acceptance lets a device approve raises, neither undone before it takes effect | Grants only from own writes |
| A peer record narrows on this machine | invariant; basis: enumerable-domain; evidence: the closed narrowing column of the record-type table | Refusing a narrowing would leave authority in place |
| A peer `change` puts a kind in ask-first | invariant; basis: irreversible-consequence; evidence: an ungated level runs actions without asking, while "ask" is undone by one owner yes | Conservative side of the only two outcomes |
| Legacy grant validity | invariant; basis: enumerable-domain; evidence: the grant's own `afterChange` and the set of change records for the kind | No ordering by writer-chosen time |
| One-time grants limited to the current term | invariant; basis: irreversible-consequence; evidence: a proceed-once used twice runs an action the owner approved once | Hand-back safety |
| Writer identity of a record | invariant; basis: external-constraint; evidence: the authenticated sender (asked machine on pull, signed `env.sender` on push) and the replica file's machine | Never a payload field |
| `journal-sync` response signature | invariant; basis: external-constraint; evidence: the registered Ed25519 machine key; invalid -> refuse; absent -> narrowing-only, which is every peer record's ceiling | No ratchet |
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
  build drives a lease handover, a forged `action-approval`, a forged first `change` on an unused
  kind, a reused `requestId` with a `cardMessageId`, a forged `legacy-grant`, an owner reply to the old
  holder's open request, a device re-accept on the new holder (decision 13) and a hand-back with an
  unused approval; each must give the verdict the tests name, seen in `/trust/summary`.
- **dev-agent-live:** `"ignore"` on the development agent's machines from merge. Evidence rows in
  `logs/feature-evidence.jsonl`: one per newly counted ignored peer grant (type, writer, and whether
  the writer is a machine this one has seen hold the lease) and one per handover re-ask with its
  outcome (answered and the next attempt admitted, or not).
- **fleet:** default `"ignore"` after review of the dev-agent rung.
- **graduation criterion:** at least one real lease handover on the development agent; every ignored
  peer grant from a writer this machine has seen hold the lease (others listed for the review); every
  re-ask answered and the next attempt admitted; both channels (chat acceptance and app device
  re-accept) observed live or proven on the test-agent rung. A period with zero handovers is not a
  pass.
- **dark-window:** at most 21 days from merge to the fleet decision; if the criterion is not met by
  then, the reason and a new date are recorded on the maturation track.
- **ladder:** trustJourney.peerGrants

## Honest residuals

- **A compromised machine can take the lease** through the medium and grant during its own term. That
  needs the owner's device signature on every grant: identity piece 2 (topic 144636). Dependency, not
  closed here.
- **Denial**: a peer can close a request, mark an approval used, or put kinds into ask-first. It never
  grants, it is counted, and the owner is told honestly (decision 8).
- **Unsigned responses from older builds** let a network impersonator of that peer's URL inject
  narrowing (denial only) until the peer updates.
- **Registry integrity**: machine keys and URLs come from the machine registry (SEC-042 / identity
  piece 2).
- **Own stream on disk**: `.instar/state/` is not git-synced. Backups hold own and peer streams; a
  restore onto a new machine id turns own grants into peer records (re-asked, decision 6).

## Open questions

*(none)*

## Rollback

Set `trustJourney.peerGrants` to `"fold"` and restart, or revert the release. Either way every peer
grant kept as evidence becomes live again on that boot (that is what "fold" means); the boot warning
says how many. No record format changes; the signature and `requesterNonce` are additive fields older
builds ignore. A mixed-version pool replicates in both directions; older builds keep first-wins on
`recordKey` and fold peer grants, which is today's behaviour on those machines.

## Tests

- Unit (store): every row of both tables, own vs peer; a peer request reusing an own `requestId` with
  a `cardMessageId` never replaces the own request; a peer first `change` on an unused kind leaves it
  "ask"; a peer change with a reused or missing `changeId` and a far-future `at` never re-validates a
  legacy grant; peer legacy grants are never imported; a peer `consumption` gives the honest denial
  line; a boot refold does not re-count `peerGrantsIgnored`.
- Unit (applier): an invalid response signature is refused and counted; an unsigned response is
  accepted with trust records narrowing-only; an origin mismatch is `forged`; a replica claiming this
  machine's id is refused; the trust store's boot union takes the writer from the replica file and
  first-wins per (writer, key).
- Unit (handover): grants from A are absent on B; `admit()` on B starts a fresh request with the
  decision 6 line; the owner's reply to A's request on B gets the "made on <old>" line; levels raised
  on A are narrowed at load on B with the restore line; A -> B -> A supersedes A's old open requests
  and unused approvals, and a `dispatch` on B for the same `actionIdentity` marks A's approval used.
- Integration: two-machine fixture over the real `journal-sync` route; a forged `action-approval` from
  the non-holder never yields proceed-once; `/trust/summary` shows the counts.
- E2E (alive): production boot path on a two-machine fixture; `"fold"` restores today's behaviour with
  the boot warning.
- Wiring: `fold` receives a non-empty writer and the local machine id on every path (boot, own commit,
  pull, push).
