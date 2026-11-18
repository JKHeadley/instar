---
title: The lease holder trusts only trust grants it wrote itself (SEC-088, part 2)
slug: trust-records-holder-authored
eli16-overview: trust-records-holder-authored.eli16.md
status: approved
approved: true
approved-by: "echo-chief-of-staff (Mac Studio), message 942dabd9 in the M5 store, 2026-11-18 03:24 PST: 'If that round concurs, tag review-convergence + approved per the gate and commit.' Operator items a-c (decision 11) go to Justin in the 07:30 status before merge."
author: echo
created: 2026-11-18
parent-principle: "Signal vs. Authority"
supersedes: trust-journey-record-provenance (convergence failed at round 6; not built)
review-convergence: "2026-11-18T11:41:15.141Z"
review-iterations: 8
review-completed-at: "2026-11-18T11:41:15.141Z"
review-report: "docs/specs/reports/trust-records-holder-authored-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# The lease holder trusts only trust grants it wrote itself (SEC-088, part 2)

> **Cut form (2026-11-18, round 7).** The six-round design added a special hand-over path (a
> foreign-epoch tracker, a gap rule, a same-epoch contest hook, a wake check, and peer-epoch rules
> for withdrawals and changes). Round 7, the one extra round the Chief of Staff authorized, found new
> design blockers in exactly that path (four of five reviewers; one lets a forged record bring back
> an ended legacy grant). Under the Chief of Staff's cut rule this spec is now the smallest safe
> form: the holder trusts only grants it wrote itself in its current run of the lease; after any
> hand-over every earlier grant is absent and is asked again the next time it is needed; there is no
> special hand-over path. The convergence report records the cut. A scoped round 8 on the cut text
> (same five reviewers) found no peer-grant path and two reopened holes, both fixed and concurred:
> foreign epochs (decision 3) and withdrawals that name every machine's acceptance ids.

## Why this exists

The trust journey's store (`src/core/trustJourney/TrustJourneyStore.ts`) replicates every record to
the agent's other machines, and `applyCommitted` -> `fold` adds each one to the holder's state with
no idea who wrote it. Part 1 (PR 3403, merges first) stopped the holder from PROCESSING a peer's
receipt of the owner's reply. The folded state still creates authority from any paired machine:

| Record type | Effect when written by a compromised peer | Severity |
|---|---|---|
| `action-approval` | `unusedActionApproval` -> `admit()` returns proceed-once for the named governed action | critical |
| `change` (any direction) | a first `change` on a kind with no history makes `provenLevel` return the local level instead of "ask" (`TrustJourneyRuntime.ts` ~329) | critical |
| `change` + `legacy-grant` | `legacyUnchanged` compares the last change's id (ordered by the payload `at`) with the grant's `afterChange`, so a reused `changeId` with a far-future `at` re-validates a legacy grant -> admission `legacy` | high |
| `legacy-grant` | a joining machine imports `unchangedLegacyKeys()` from every machine | high |
| `request` reusing an own `requestId` | the `requests` map is keyed by `requestId` and a record with a `cardMessageId` replaces the earlier one, so the owner's real reply to the holder's card approves the peer's change | high |
| `device-acceptance`, `device-approval` | a device counts as accepted, or a new device as approved | high |
| `acceptance`, `consumption` + `change` raise | skips the acceptance step; restores a raise at load (`checkAtLoad`) | medium |
| `consumption`, `request-status`, `apply-outcome` | a real approve is swallowed, a request closed, or an outcome shown falsely | denial |

Source of the go-ahead: the Chief of Staff's brief to the security session (session
`echo-chief-of-staff`, Mac Studio, delivered into session `echo-echo-instar-security` on the Mac M5
Pro, topic 143781, 2026-11-18 01:45 PST), decision 2: "holder trusts only grants it wrote; earlier
holders' grants treated as absent after a handover and re-asked on next attempt; narrowing and
used-markers count from any authenticated machine; keep signed delta responses, origin binding,
per-writer keys ... Cost accepted: owner re-approves pending items after a rare lease handover." The
cut rule is from the same session's brief of 2026-11-18 02:35 PST: "the holder trusts only grants it
wrote itself; after any hand-over every earlier grant is treated as absent and re-asked when next
attempted; no special hand-over path." Pointers: the 02:35 brief is message
`5f3d8972-0688-4ccf-abd6-41590752668e` in the M5 machine's message store (subject "Re 02:25 handoff:
one more round authorized, with a cut rule"); the 01:45 brief was typed into the session directly and
has no store record, so it is quoted from the delivered text (the attribution trace is off on this
agent). That approval covers proceeding; decision 11 lists what still needs the operator.

## The rule

1. A record that GRANTS something counts on a machine only if that machine wrote it during its
   current run of the lease (defined in decision 3).
2. A record any machine wrote can CLOSE, USE or WITHDRAW something by its id. That is all it can do.
3. No rule reads an epoch, an order or a timestamp from a record another machine wrote.

After any hand-over the new holder sees none of the earlier holder's grants, and the earlier holder,
if it takes the lease back, sees none of its own from before. The normal approval flow asks the owner
again the next time the action is attempted.

## Frontloaded Decisions

1. **Two indexes.** `fold(writer, recordKey, record)` keeps every record (evidence), and builds:
   - an **own index** from records whose writer is this machine: every existing derived map,
     unchanged in shape, each entry also holding the epoch from its key (decision 3);
   - a **narrowing set** from every writer: closed request ids, used receipt ids, used request ids,
     used approval ids, withdrawn acceptance ids, used device-approval ids. Exactly the id-keyed
     effects `fold` already applies, nothing else.
   Every grant-side query reads the own index, filtered to the current run; every "is it used /
   closed / withdrawn" check also reads the narrowing set. Records are keyed by (writer, recordKey),
   so a peer cannot occupy a key this machine is about to write. Every set is a pure function of the
   records present, so the boot refold and the live state are the same. The closed tables below are
   part of this decision.
2. **The writer is transport-derived** (origin binding). The writer reaching `fold` is: this machine
   for its own stream, provided each record's stamped `origin` equals this machine's current id
   (records in the local-file sink, used only when the journal is off and so only on a single machine,
   carry no origin and are own); a stream restored from another machine id is foreign, and the payload
   `origin` can only take ownership away, never grant it. For a replica it is the machine the replica
   file belongs to, which the applier set from the authenticated sender (the machine asked on the pull
   path, `env.sender` of the signed mesh request on the push path). Never a payload field. For the
   trust store only, a new reader method returns every replicated record with its writer taken from
   each entry's `machine` (which `validateEntry` binds to the sender), first record per
   (writer, recordKey) wins. Own-ness comes only from the own stream: the boot reader skips a
   replica file named with this machine's id and drops a replica entry whose `machine` is this
   machine. The applier refuses a replica whose sender, after the same sanitising, is this
   machine's own id. `validateEntry` adds `trust-grant-record` to the
   origin-must-equal-sender kinds and treats a mismatch like `failure-callout-chunk` today
   (`forged`: batch stops, nothing appended, counted).
3. **The current run.** On a multi-machine agent every grant record this build writes carries the
   lease epoch it was written in, in its key: `tj:<type>:e<epoch>:<id>` (keys are free-form strings,
   nothing parses `tj:` keys today, so no field or type changes). The trust runtime keeps one own
   local file, `state/trust-held-epochs.json`: the epochs at which this machine was seen holding the
   lease. An epoch is added whenever `holdsLease()` is true together with the epoch it holds (one
   read of the coordinator's view, so the pair is consistent), at every admission, every trust write
   and on a five-second tick (so a same-machine N -> N+1 -> N+2 between trust activity is seen). The
   first observation (the upgrade, a lost file, a first take of the lease) starts a run. Under
   `"fold"` none of this runs (no tracker, no recheck, no profile narrowing). The pair is read
   consistently: an epoch that moves during the read counts as contested.
   - **Foreign epochs.** An epoch at which the coordinator names another machine as holder, or
     reports a contest, or for which it emits its same-epoch split-brain detection, or which any
     peer's own lease in the coordinator's machine-authenticated peer observations shows that peer
     held (live or expired: an expired lease at N still proves the peer held N, which covers a tie
     the loser gave up first), is recorded as foreign in the same file, and no run spans a foreign
     epoch. The list is pruned by value only (epochs below the oldest held range can never lie inside
     a counting span); if it still outgrows its bound, every run ends (fail closed). So a same-epoch tie ends the run of
     both machines even after the coordinator resolves it (round 8). This reads only the
     coordinator's view, never a record. The **current run** is: this machine holds the lease now, at epoch N, and
   the held set contains every epoch from e to N. An own grant keyed `e<e>` counts only inside the
   current run. A grant record a machine writes while it does not hold the lease (several trust
   routes have no holder guard today) is keyed `s<N>` instead of `e<N>` and never counts in any run,
   even after that machine takes the lease. Key
   forms keep today's suffix after the epoch, so the single-use lock keys stay locks within a run
   (`tj:device-acceptance:e<N>:approval:<id>`, `tj:device-acceptance:e<N>:first:<n>`); a record that
   today has no explicit key (changes, acceptances) gets `tj:<type>:e<N>:<random>`. A machine whose
   epoch is unknown writes no grant record (the write fails and the caller asks); narrowing records
   never carry an epoch and are always written. Consequences, with no further mechanism:
   - Lease acquisition always writes the current epoch + 1 (`FencedLease.ts`), so if another machine
     held any epoch in between, that epoch is missing from this machine's set and every earlier grant
     is absent. That is the hand-over rule.
   - A lapse and re-acquire by this same machine (sleep, restart, a missed renewal) moves from N to
     N+1 with nobody in between; both epochs are in the set, so its grants survive. If the lapse was
     too short to be observed, the epoch is missing and the grants are absent: denial, never a
     double run.
   - After a wake, `holdsLease()` is false until a renewal is confirmed on the monotonic clock
     (`LeaseCoordinator.holdsLease`, the existing self-fence), so a stale view never counts.
   - While `splitBrainState` is not `clear`, no own grant counts and `admit()` asks.
   - The file is never lowered and is not in the backup set. Missing or unreadable: it starts empty,
     so only grants written from now on count (own grants already keyed at the epoch held when the
     file is re-created still count: they are this machine's own, in the same epoch).
   - A record another machine wrote is never parsed for an epoch.
   - Single machine (the machine registry lists only this machine): epoch 0, the run never ends,
     nothing changes for the owner. More than one machine and the coordinator missing, failed, or not
     yet loaded: no own grant counts, `admit()` asks, and nothing is written with an epoch.
   - Records written before this build carry no epoch: on a multi-machine agent they are outside
     every run (one re-ask at upgrade, decision 6); on a single machine they count as today.
   - Admission recheck: after the `dispatch` write and before returning proceed-once, `admit()`
     re-reads `holdsLease()` and the epoch; if either changed, it returns "ask" (the approval stays
     used, the safe side).
4. **What "grant" covers.** Every record type in the grant column of the record table: requests
   (answerable), acceptances and acceptance statements, device acceptances, device approvals,
   one-time action approvals, `change` records (which back trust levels and the autonomy profile), and
   legacy grants. Concretely:
   - `provenLevel(kind)` returns the adaptive-trust level only if an own `change` for the kind exists
     in the current run; otherwise null ("ask"). A peer's `change` never affects this machine.
   - The autonomy profile: the existing load-time proof check (`checkAtLoad`) reads only own
     current-run changes, and the runtime also runs it whenever the held set gains an epoch that
     starts a new run (this machine took the lease after another holder). A profile wider than its
     last own current-run change, or wider than the default with none, is narrowed (written with
     source `revoked`, so it ends nothing elsewhere) and the owner gets the existing restore line.
     This is the same check, run at one more moment, not a new path.
   - Legacy grants are own, current-run only. `legacyUnchanged(kind)` holds when this machine's own
     legacy grant is in the current run and no own `change` for that kind comes after it in this
     machine's own stream order (the own fold sequence; never a payload time). Peer changes are not
     read. The legacy import's "another machine already imported" check reads a new evidence query,
     `legacyImportedAnywhere()`, over every writer's `legacy-grant` records; it only decides that this
     machine is a joining machine (which imports nothing), never grants. A legacy grant that left the
     run is not re-imported: those kinds ask until the owner approves them on this machine.
5. **Signed `journal-sync` responses, for attribution only.** The `journal-sync` MeshRpc response
   carries the serving machine's Ed25519 signature over
   `['journal-sync-response', responder, requesterNonce, kind, incarnation, fromSeq, sha256(canonical entries)]`,
   following `AgentIdentityAdoption.ts`'s signed-response pattern; the request gains
   `requesterNonce`, which older servers ignore, and older clients ignore the added `sig`. The client
   verifies against the registered key of the machine it asked. An INVALID signature has its
   `trust-grant-record` entries refused and counted (`journal.sync.badSignature`); other kinds are
   handled as today. No signature (an older build) is accepted as today. Honest limit: an on-path
   attacker can strip it; under this design that attacker can still only narrow, never grant.
6. **The owner-visible cost, stated in full.** On a multi-machine agent:
   - after any hand-over (or a lapse too short to observe), each pending approval is asked again on
     the holder the next time the action is attempted;
   - each channel's acceptance (chat `acceptance`, app `device-acceptance`) is asked once on the
     holder before approvals there count;
   - each kind whose level the owner raised is asked again on the holder when the action next comes
     up, and the autonomy profile returns to its default until the owner raises it again there;
   - kinds that had a legacy grant ask until approved on that holder;
   - at the upgrade to this build, everything above happens once, because earlier records carry no
     epoch;
   - a backup restored onto a new machine id has no own records, so the same applies.
   Lines name both machines where known ("I moved from <old> to <new>, so I need your OK again here")
   and use the existing flows: no new authority and no new prompt type. A request issued in an earlier
   run is not answerable: the owner's reply gets "That request was made earlier on <machine>; I will
   ask again here when it next comes up", and nothing changes.
7. **Denial by a peer is told honestly.** When the owner's real reply hits a request another machine
   closed or marked used, the reply is "Another of my machines closed that request, so nothing was
   approved; I will ask again when it next comes up", never "already approved". `applyOutcome` is read
   only for own consumptions.
8. **Visibility: counts only.** `GET /trust/summary` gains a `trustJourney` block (returned even
   when adaptive trust is absent): `peerGrantsIgnored` by (type, writer), de-duplicated by
   (writer, recordKey); `outsideRun` (own grants not counted because their run ended) by type;
   `heldEpochs` (the count and the newest); `runStartedAt` (the epoch the current run began at). No
   alarm and no owner notice: this design never judges whether a peer record was honest.
9. **Rollout and switch.** `trustJourney.peerGrants`: `"ignore"` (this spec) or `"fold"` (today).
   An explicit value wins; anything else (absent, or invalid, which is logged) resolves to `"ignore"`
   when `resolveDevAgentGate(undefined, config)` is true or `config.throwawayAgent` is set, else
   `"fold"` on the fleet until the fleet rung, after which the fallback becomes `"ignore"` by a
   reviewed code change. No config default is written by the migrator. No shadow mode (*A Dark
   Feature Guards Nothing*: a watch-only mode leaves the forgery open). A resolved `"fold"` on a
   multi-machine agent logs at every boot: "Trust records written by other machines are being
   honoured (N grants from other machines are live now)". Single-machine agents see no change at any
   setting.
10. **Merge order.** Part 1 (PR 3403) merges first; this build rebases on it and replaces its "send it
    again" wording only where decision 6 says so.
11. **What the operator decides (named in the approval request).** (a) Re-asking after a hand-over,
    and once at upgrade, is an exception to *Trust Is Earned by Work* until identity piece 2 (the
    owner-signed record, topic 144636) lets a grant verify on any machine; the lift is a dated
    commitment opened with the build. (b) The fleet keeps today's behaviour (`"fold"`) for a 21-day
    review deadline from merge, or ships `"ignore"` fleet-wide from merge. (c) Trust levels and the
    autonomy profile stay per machine (and now per run) until piece 2, an exception to *An Instar
    Agent Is Always a Multi-Machine Entity*. Both answers to (b) are buildable without further review;
    refusing (a) or (c) sends the spec back. The approval request includes the measured hand-over and
    epoch-change counts (decision 12).
12. **Lease stability is measured before the fleet rung.** The cost in decision 6 is per run, so it is
    only as rare as runs end. The development agent's lease epoch reached 23605 on 2026-11-18, and on
    the evening of 2026-11-17 it moved about 100 times in an hour (it has been steady for hours since).
    Same-machine re-acquires do not end a run, so the number that matters is runs ended per week. The
    dev-agent rung logs every run start with its cause (another holder in between, or an unobserved
    epoch) and the review sees the rate. A rate the operator finds too high blocks the fleet rung; it
    does not loosen the rule.

### Record-type table (closed: every value of `TRUST_RECORD_TYPES`)

| Type | Own writer, current run (grant side) | Any writer (narrowing side) |
|---|---|---|
| `request` | answerable request | none |
| `request-status` | closes own request | closes the named request id |
| `receipt` | first-hand receipt (part 1) | none |
| `acceptance-sent` | precondition for an acceptance | none |
| `acceptance` | account path accepted | none |
| `acceptance-withdrawn` | removes an acceptance | removes the named acceptance id |
| `consumption` | records an approve | marks the request id and receipt id used |
| `change` | proven level, autonomy profile check, ends own legacy grant | none |
| `legacy-grant` | own legacy behaviour | none; never imported (`legacyImportedAnywhere` reads it as evidence only) |
| `action-approval` | proceed-once | none |
| `dispatch` | marks approval used | marks the named approval id used |
| `device-acceptance` | device may approve | marks its `approvalId` used |
| `device-acceptance-withdrawn` | removes a device | removes the named acceptance id |
| `device-approval` | approves a new device | none |
| `apply-outcome` | outcome of an own consumption | none |
| any type, unreadable (unknown field or `minReader`) | today's unreadable handling for own records | only the id-keyed narrowing of its type; never `unreadableKeys` |

Narrowing records (`request-status`, `consumption`, `dispatch`, withdrawals) keep today's keys; they
apply from any writer and in any run. From a peer, `request-status` only closes (its value is used
for the honest line, never to reopen). `apply-outcome` is own-only. Grant keys marked `s<N>` (written
while not holding) only ever exist on a multi-machine agent and count in no run.

**Which ids a withdrawal names (round 8).** A withdrawal names every not-yet-withdrawn acceptance id
for its subject recorded by any machine in any run (chat: `principal|adapter`; device: the device id
or the phone's key fingerprint, since device ids are per machine). This is an evidence-only read: it
can only narrow, and it lets an owner's withdrawal made where approvals are not handled reach the
holder's acceptance.

### Query table (closed: every read the store exposes)

| Query | Reads |
|---|---|
| `codeTaken` | every writer's requests (blocks a code only, never grants) |
| `request`, `openRequests`, `allRequests`, `requestByCode`, `requestByCard` | own index, current run, status from the narrowing set; peer and earlier-run requests are never shown, never suppress an ask and never fill `MAX_OPEN_REQUESTS` |
| `requestAnyRun` (new) | own index, any run: only to give the "made earlier" line of decision 6 |
| `receipt`, `receiptConsumed` | own receipts; consumed from the narrowing set |
| `acceptance`, `acceptanceStatementSent` | own, current run, minus withdrawals |
| `consumption`, `consumptionOf`, `requestConsumedOrPending`, `applyOutcome` | own index; `requestConsumedOrPending` is also true when the narrowing set has the request used |
| `deviceAcceptance`, `currentDeviceAcceptances`, `deviceAcceptanceWithdrawn` | own, current run, minus withdrawals |
| `unusedDeviceApprovals`, `deviceApproval` | own, current run, minus used |
| `deviceAcceptanceHistory` | all records, each marked own or "from <machine>, not counted here" |
| `changeLog`, `lastChange` | own changes, current run, in own stream order |
| `legacyGrants`, `legacyKeys`, `unchangedLegacyKeys`, `legacyUnchanged` | own legacy grants, current run (decision 4) |
| `legacyImportedAnywhere` (new) | every writer's legacy grants, evidence only |
| `unusedActionApproval` | own, current run, minus used |
| `hasUnreadableHistory` | own unreadable `change` records only |
| `acceptanceIdsToWithdraw`, `deviceAcceptancesToWithdraw` (new) | every writer, any run, minus withdrawn: evidence only, names the ids a withdrawal writes |

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A replicated record grants on this machine | invariant; basis: irreversible-consequence; evidence: a proceed-once runs a governed action and a device acceptance lets a device approve raises | Grants only from own writes in the current run |
| A peer record narrows on this machine | invariant; basis: enumerable-domain; evidence: the closed narrowing column | Id-keyed only |
| Current run | invariant; basis: external-constraint; evidence: acquisition writes epoch + 1, so an epoch held by another machine is never in this machine's held set; the monotonic self-fence in `holdsLease()` | Missing epoch -> grants absent (denial) |
| Grant while the lease view is contested or unknown | invariant; basis: irreversible-consequence; evidence: two believed holders could each run one approval | Asks |
| Legacy grant validity | invariant; basis: enumerable-domain; evidence: own grant in the current run and own changes in own stream order | No peer input, no payload time |
| Autonomy profile after a new run | invariant; basis: irreversible-consequence; evidence: a profile raised in an earlier run would act without a current yes | Existing proof check, source `revoked` |
| Pre-build records on a multi-machine agent | invariant; basis: irreversible-consequence; evidence: their run cannot be known | One re-ask at upgrade |
| Admission recheck after the dispatch write | invariant; basis: irreversible-consequence; evidence: a hand-over during the write | Returns ask; approval stays used |
| Own stream ownership | invariant; basis: external-constraint; evidence: the stamped origin compared with this machine's id | Origin can only remove ownership |
| Writer identity of a record | invariant; basis: external-constraint; evidence: the authenticated sender and the replica file's machine | Never a payload field |
| `journal-sync` response signature | invariant; basis: external-constraint; evidence: the registered Ed25519 machine key | Invalid -> trust records refused; absent -> accepted (narrowing is every peer record's ceiling) |
| Origin mismatch on a trust record | invariant; basis: enumerable-domain; evidence: the existing `forged` verdict | Batch stops |
| Honest denial line | invariant; basis: enumerable-domain; evidence: the request was closed or used by a non-own record | Never "already approved" |
| Re-ask lines after a hand-over | invariant; basis: enumerable-domain; evidence: the existing approval and acceptance flows | No new prompt or authority |
| Invalid `trustJourney.peerGrants` value | invariant; basis: enumerable-domain; evidence: two valid values | Logged; resolves as absent |
| Boot warning under `"fold"` | invariant; basis: irreversible-consequence; evidence: peer grants become live on that boot | Tells the operator the protection is off |
| Fleet default of `trustJourney.peerGrants` | judgment-candidate; floor: `"fold"` on the fleet until the reviewed change; arbiter: the maturation review | Maturation Path |
| Dark window before the fleet decision (21 days) | judgment-candidate; floor: if the criterion is unmet the reason is recorded and an extension needs the operator's renewed acceptance; arbiter: the maturation review and the operator | Never an automatic flip |
| Graduation criterion | judgment-candidate; floor: the conditions in the maturation plan; arbiter: the maturation review | Thresholds raise, the review decides |

## Multi-machine posture

Unified store, per-run grants. Every trust record replicates to every machine through the existing
`trust-grant-record` journal and is kept everywhere; every machine applies the same narrowing set.
What differs is only which records count as grants: those this machine wrote in its current run.
`GET /trust/summary` reports this machine's counts; only the lease holder acts on approvals, so no
pooled read is added.

## Maturation plan

- **test-agent-live:** a throwaway two-machine agent, `"ignore"`: drive a hand-over, a forged
  `action-approval`, a forged `change` on an unused kind, a reused `requestId` with a `cardMessageId`,
  a forged `legacy-grant`, a forged no-epoch `change` reusing a legacy anchor with a far-future `at`,
  an owner reply to the old holder's request, a hand-back with an unused approval, a same-machine lapse
  and re-acquire with an unused approval, and a device re-accept on the new holder. Each must give the
  verdict the tests name, seen in `/trust/summary`. Phone pairings are per machine: if a phone paired
  to the old holder cannot re-accept on the new one with the existing flow, approvals there use chat
  until the owner opens the new holder in the app, the line says so, and any app change is filed with
  the app owner as its own item before the fleet rung.
- **dev-agent-live:** `"ignore"` on the development agent from merge. Evidence rows in
  `logs/feature-evidence.jsonl`: one per newly counted ignored peer grant (type, writer), one per run
  start (cause), one per re-ask after a run start with its outcome.
- **fleet:** default `"ignore"` after review of the dev-agent rung.
- **graduation criterion:** at least one real hand-over on the development agent; every ignored peer
  grant listed for the review with its writer; every re-ask answered and the answer honoured (a "no"
  honoured counts); runs ended per week and re-asks per run reported (decision 12); both channels
  (chat and app re-accept) observed live or proven on the test-agent rung. A period with zero
  hand-overs is not a pass.
- **dark-window:** a 21-day review deadline from merge to the fleet decision; an extension needs the
  operator's renewed acceptance (decision 11b).
- **ladder:** trustJourney.peerGrants

## Honest residuals

- **A compromised machine can take the lease** through the medium and grant during its own run. That
  needs the owner's device signature on every grant: identity piece 2 (topic 144636).
- **Denial**: a peer can close a request, mark an approval used, or withdraw an acceptance by id. It
  never grants, it is counted, and the owner is told honestly (decision 7). A forged peer
  `legacy-grant` can make the first machine at upgrade treat itself as joining, so it imports
  nothing: its kinds ask (denial).
- **Split brain beyond the medium**: if two machines both hold the same epoch without the coordinator
  seeing a contest, each counts its own grants. Part of the lease-medium residual.
- **Same-id restore**: restoring a backup onto the same machine id brings back approvals dispatched
  after the backup was taken; today's behaviour, unchanged.
- **Own journal rotation**: `trust-grant-record` keeps no rotated files; unchanged, filed through the
  feedback system as its own item when the build starts.
- **Mixed-version pools**: an older-build holder folds peer grants (today's behaviour on that
  machine).
- **Registry integrity**: machine keys and URLs come from the machine registry (SEC-042 / identity
  piece 2).
- **Back to one machine**: if every other machine is removed from the registry, the single-machine
  rule applies again and this machine's own grants from earlier runs count again (own records only;
  removing machines is the owner's act).
- **Withdrawal before replication**: an acceptance written on the holder that has not yet reached
  the machine where the owner withdraws is missed by that withdrawal (a replication-lag window).
- **Withdrawal fan-out**: a peer that floods fake acceptance ids makes one withdrawal write one
  record per id (denial-free, bounded by what replicated; counted in the logs).
- **Lease epoch reset**: a lease medium whose epoch were reset to a low value could let an old held
  range cover a new epoch. The medium only ever writes epoch + 1 today.

## Open questions

*(none)*

## Rollback

Set `trustJourney.peerGrants` to `"fold"` and restart, or revert the release. Either way every peer
grant kept as evidence becomes live again on that boot; the boot warning says how many. No record type
or field changes: the epoch is part of the key, and the signature and `requesterNonce` are additive
wire fields older builds ignore. An older build reads an epoch-keyed record as an ordinary record
(today's behaviour). `state/trust-held-epochs.json` is ignored by older builds.

## Tests

- Unit (store): every row of both tables, own vs peer; a peer request reusing an own `requestId` with
  a `cardMessageId` never replaces the own request; a peer `change` on a kind with no own change leaves
  it "ask"; a peer `change` (with or without an epoch in its key, any `changeId`, any `at`) never
  affects `legacyUnchanged`, `provenLevel` or `changeLog`; a peer key with a huge epoch has no effect;
  peer legacy grants are never imported and `legacyImportedAnywhere` sees them; a peer `consumption`
  gives the honest denial line; the boot refold equals the live fold for any file order and does not
  re-count `peerGrantsIgnored`.
- Unit (run): grants from A are absent on B; A -> B -> A leaves A's earlier grants (approval,
  acceptance, device acceptance, raised level, legacy grant) absent; a same-machine re-acquire N ->
  N+1 with both observed keeps them; an unobserved epoch makes them absent; a lost held-epochs file
  counts only new grants; a grant a standby wrote at the holder's epoch never counts after that standby takes the lease; contested or unknown lease view asks; a multi-machine agent with no
  coordinator asks; pre-build records on a multi-machine agent are absent and on a single machine
  count; a new run narrows a raised autonomy profile with source `revoked` and the owner line; an own
  change after an own legacy grant ends it by stream order; a hand-over during the dispatch write
  returns ask; the owner's reply to an earlier-run request gets the "made earlier" line; a restored
  stream from another machine id is foreign; a single-machine agent (epoch 0) is unchanged.
- Unit (applier): an invalid response signature is refused and counted; an unsigned response is
  accepted with trust records narrowing-only; an origin mismatch is `forged`; a replica claiming this
  machine's id is refused; the boot union takes the writer from the replica file, first-wins per
  (writer, key).
- Integration: two-machine fixture over the real `journal-sync` route; a forged `action-approval`
  from the non-holder never yields proceed-once; `/trust/summary` shows the `trustJourney` block with
  and without adaptive trust.
- E2E (alive): production boot path on a two-machine fixture; `"fold"` restores today's behaviour
  with the boot warning.
- Wiring: `fold` receives a non-empty writer and the local machine id on every path (boot, own commit,
  pull, push); the runtime receives a real lease reader (not a stub) on a multi-machine agent.
