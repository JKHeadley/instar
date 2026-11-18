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
no idea who wrote it. Part 1 (PR 3403) stopped the holder from PROCESSING a peer's receipt of the
owner's reply. The folded state still creates authority from any paired machine:

| Record type | Effect when written by a compromised peer | Severity |
|---|---|---|
| `action-approval` | `unusedActionApproval` -> `admit()` returns proceed-once for the named governed action | critical |
| `device-acceptance`, `device-approval` | a device counts as accepted, or a new device as approved, so it can approve later raises | high |
| `legacy-grant` + `change` | `legacyUnchanged(kind, self)` holds -> admission `legacy` (ungated) | high |
| `change` + `consumption` | the load-time rebuild (`checkAtLoad`) restores a raise | high (corrupt settings only) |
| `acceptance` | the owner's acceptance step is skipped (a real approve is still needed) | medium |
| `receipt` on a predictable key, `consumption`, `request-status` | a real approve is swallowed as a duplicate, or a request is closed | denial |

An earlier design (trust-journey-record-provenance) tried to prove that a peer's record was written
while that peer really held the lease. Six review rounds showed that "really held the lease at the
time" cannot be proven cheaply here (pull-only unsigned replication, self-signable lease records,
rewritable history), and it was stopped at the round cap. Its report recommended this simpler design,
which the Chief of Staff approved on 2026-11-18 01:45 PST with its cost accepted.

## The rule in one paragraph

A record that GRANTS something counts on a machine only if that machine wrote it. A record that only
TAKES AWAY or marks something USED counts from any authenticated machine of the agent. After the
lease moves, the new holder therefore sees none of the earlier holder's grants; the normal approval
flow asks the owner again the next time the action is attempted. Nothing is ever granted by a record
another machine wrote.

## Frontloaded Decisions

1. **The writer is transport-derived, never read from the record.** Three transport fixes carried
   over from the earlier design, all needed for "who wrote this" to mean anything:
   a. **Signed delta responses.** The journal-delta response carries the serving machine's Ed25519
      envelope signature (the machine key MeshRpc requests already use) over the request nonce and
      the response body; the client verifies it against the registered key of the machine it asked.
      The `secret-share` command already signs its response; the build follows that pattern. A peer
      that has once answered signed must always answer signed (a later unsigned answer is refused and
      counted, `journal.delta.unsigned`). A peer that has never signed (an older build during a
      staggered update) is still accepted for every other kind; its `trust-grant-record` entries are
      folded as narrowing-only (decision 3), which is the same treatment every peer record gets, so
      nothing waits on the whole pool updating.
   b. **Origin binding.** `validateEntry` adds `trust-grant-record` to the kinds whose `data.origin`
      must equal the sender. A mismatched entry is dropped and counted (`trust.originMismatch`); a
      placeholder line keeps the sequence consecutive so one bad entry never stalls the stream.
      `materialize` and the boot union take the writer from the replica file's sender, never from a
      payload field (today the boot union sets `receivedBy: r.origin` from the payload); this
      machine's own records carry this machine's id.
   c. **Per-writer keys.** The index is keyed by (writer, recordKey). A peer can no longer occupy a key
      this machine is about to write (today `fold` is first-wins regardless of writer, so squatting a
      predictable withdrawal key stops the owner revoking a device).
2. **`fold` receives the writer and the local machine id, and applies one closed table** (below):
   - *own-grant*: counts as a grant only when writer = this machine;
   - *narrowing*: counts from any authenticated writer;
   - *self-scoped*: describes the writer's own machine and is only ever read for that machine.
   A record that is own-grant from another writer is still KEPT (it is evidence and appears in the
   history the devices show) and its narrowing side-effects still apply (decision 3), but it grants
   nothing.
3. **Every grant record has a "used" side, and that side counts from anyone.** A peer's
   `consumption` still marks its request and receipt used; a peer's `device-acceptance` still marks its
   `approvalId` used; a peer's `request` still occupies its code (`codeTaken`). This is exactly what
   `fold` already does for unreadable records today, so a peer record can close or use something but
   never open or grant it. It means a compromised peer can deny (swallow an approval, close a request);
   denial is listed under Honest residuals, and it is visible (decision 6).
4. **After a handover, earlier holders' grants are absent and are re-asked on the next attempt.** No
   migration copies them and no new record type adopts them. When the new holder next evaluates a
   gated action, `admit()` finds no own grant and starts the normal approval flow, the same one a
   single-machine agent uses. A request the earlier holder issued and the owner had not yet answered is
   not answerable on the new holder (its `request` is not an own-grant); the owner's reply to it gets
   the existing "nothing changed, please send it again" path from part 1, and the next attempt issues a
   fresh request from the new holder. A lease hand-back (A -> B -> A) keeps A's own grants, because A
   wrote them.
5. **Long-lived grants are re-established by the owner, once, on the new holder.** `acceptance` (the
   owner's acceptance of the account path) and `device-acceptance` (an app device allowed to approve)
   are long-lived. On a new holder they are absent, so the first approval there asks the owner to
   accept again (chat) or re-accept the device (app), using the existing flows. This is the main cost
   of the design and is accepted: handovers are rare (hand-back is off by default) and each one costs
   the owner one acceptance per channel. The re-accept prompt says why in one plain line: "I moved to
   <machine>, so I need your OK again before I act on approvals here."
6. **Ignored grants are visible, not silent.** Each peer own-grant record that `fold` keeps but does
   not count is counted by type and writer (`trust.peerGrantIgnored`) and shown on the trust journey
   status read. A peer grant written while that peer did NOT hold the lease (by this machine's own
   lease view at arrival) is a forgery signal: one Needs-you item, updated in place, "<machine> wrote a
   permission record while it was not in charge: N times, last at <time>". A peer's narrowing that
   closes a request this machine issued and the owner has not answered is listed in the same item.
7. **Self-scoped records stay self-scoped.** `legacy-grant` counts only for `machine` = writer, and
   `legacyUnchanged(kind, self)` reads only this machine's own legacy grants and the change log
   (whose `raise` entries count only when own-written, decision table). `receipt` stays first-hand only
   (part 1). `apply-outcome` describes what an apply did on its writer and grants nothing.
8. **`change` direction is recomputed, not trusted.** A peer's `change` counts only as narrowing; this
   machine recomputes the direction from `from`/`to` against its own last change for that key, and a
   peer record whose real direction is `raise` counts for nothing except being listed (decision 6). So
   a peer cannot make `lastChange` move in a way that re-validates a legacy grant upward.
9. **Rollout walks the maturation ladder, enforcing at each rung it reaches.** The switch is
   `trustJourney.peerGrants`: `"ignore"` (this spec) or `"fold"` (today). It has no shadow mode: the
   rule only removes trust from peer records, every one of which is reproducible by asking the owner
   again, and a watch-only mode would leave the forgery open while it watches (*A Dark Feature Guards
   Nothing*). Default by agent class (the role, never a per-agent list): test agents and development
   agents `"ignore"` from merge; the fleet stays `"fold"` until the fleet rung below is reviewed, then
   the default becomes `"ignore"` by a reviewed code change. Single-machine agents see no change at any
   rung (every record is own-written). An explicit `"fold"` on any agent logs a warning at every boot.
   Read at boot; documented in the upgrade note.
10. **Asking again after a handover is not asking the same yes twice.** *Trust Is Earned by Work*
    says the same yes is never asked twice. The earlier yes is recorded, but on the new holder it is
    a record another machine wrote, which this machine cannot tell apart from a forgery; that is the
    whole defect. So the new holder is not re-asking a yes it holds, it is asking for one it can
    verify for the first time. The cost is bounded: one re-ask per pending item and one acceptance per
    channel per handover, and handovers are rare. The re-ask line says plainly why it is asked. When
    the identity work's signed owner record (piece 2) lands, an owner-signed grant verifies on any
    machine and this re-ask goes away; that is the lift condition, tracked with the residual below.

## Maturation plan

- **test-agent-live:** a throwaway two-machine agent (the standing two-machine test route) with
  `"ignore"`: the build drives a lease handover, a forged `action-approval` and a forged
  `device-acceptance` from the non-holder, an owner reply to the old holder's open request, and a
  hand-back; each must give the verdict the tests name, seen in `peerGrantIgnored` and the Needs-you
  item.
- **dev-agent-live:** `"ignore"` on the development agent's machines from merge. Evidence: rows the
  build adds to `logs/feature-evidence.jsonl` (one per ignored peer grant, with type and writer, and one
  per handover re-ask).
- **fleet:** default `"ignore"` after review of the dev-agent rung.
- **graduation criterion:** at least one real lease handover on the development agent with every
  `peerGrantIgnored` row explained (an earlier holder's grant, never an unexplained writer) and every
  re-ask answered without a support message; a period with zero handovers is not a pass.
- **dark-window:** at most 21 days from merge to the fleet decision; if the criterion is not met by
  then, the reason and a new date are recorded on the maturation track.
- **ladder:** trustJourney.peerGrants

### Record-type table (closed: every value of `TRUST_RECORD_TYPES`)

| Type | Rule | Grant side (own writer only) | Used / narrowing side (any writer) |
|---|---|---|---|
| `request` | own-grant | answerable request | code taken; occupies its `requestId` |
| `request-status` | narrowing | none | closes or supersedes a request |
| `receipt` | self-scoped (part 1) | first-hand receipt | none cross-machine |
| `acceptance-sent` | own-grant | precondition for an acceptance | none |
| `acceptance` | own-grant | account path accepted | none |
| `acceptance-withdrawn` | narrowing | none | removes an acceptance |
| `consumption` | own-grant | backs a raise at load (`checkAtLoad`), records an approve | request and receipt used |
| `change` raise | own-grant | restores a raise at load | none |
| `change` lower / same | narrowing (direction recomputed) | none | counts for `lastChange` |
| `legacy-grant` | self-scoped (`machine` = writer) | that machine's legacy behaviour | none |
| `action-approval` | own-grant | proceed-once | none |
| `dispatch` | narrowing | none | approval used |
| `device-acceptance` | own-grant | device may approve | its `approvalId` used |
| `device-acceptance-withdrawn` | narrowing | none | removes a device |
| `device-approval` | own-grant | approves a new device | none |
| `apply-outcome` | self-scoped | none | none |

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A replicated record grants on this machine | invariant; basis: irreversible-consequence; evidence: a proceed-once runs a governed action, and a device acceptance lets a device approve raises; neither is undone before it takes effect | Authority only from this machine's own writes |
| A replicated record narrows on this machine | invariant; basis: enumerable-domain; evidence: the closed narrowing column of the table | Refusing a narrowing would leave authority in place |
| Writer identity of a replicated record | invariant; basis: external-constraint; evidence: the serving machine's signature on the delta response and the replica file's sender | Never a payload field |
| Fleet default of `trustJourney.peerGrants` | judgment-candidate; floor: `"fold"` on the fleet until the reviewed change; arbiter: the recurring maturation review (two independent readings) | Maturation Path |
| Dark window before the fleet decision (21 days) | judgment-candidate; floor: the reason and a new date are recorded if the criterion is unmet; arbiter: the maturation review | A review date, never an automatic flip |

## Multi-machine posture

Replicated, evaluated per machine. Every machine keeps all records (evidence and history), and each
machine's grants come only from its own writes; the lease holder is the only machine that acts on
approvals, so in practice "the holder's own grants". Narrowing replicates and applies everywhere.
machine-local-justification: authority-locality (a grant is honoured only by the machine that wrote
it, because no machine can prove another machine's write was legitimate).

## Honest residuals

- **A compromised machine can take the lease** through the medium and grant during its own term. That
  is unchanged and out of scope; part 1's review and the earlier design agree it needs the owner's
  device signature on every grant, which is the identity work's piece 2 (signed owner record, topic
  144636). Tracked as a dependency, not closed here.
- **Denial**: a compromised peer can close a request or mark an approval used. It is listed
  (decision 6) and the owner's next attempt asks again; it never grants.
- **Registry integrity**: machine keys and URLs come from the machine registry; its integrity against a
  compromised paired machine is SEC-042 / identity piece 2.
- **Own stream on disk**: this machine's own trust journal file must not be writable by peers through
  git sync. The build verifies that the trust-grant-record journal is not in the git-synced set and
  adds a test that fails if it ever is.

## Open questions

*(none)*

## Rollback

Set `trustJourney.peerGrants` to `"fold"` and restart (today's behaviour; a boot warning says the protection is off), or revert the release.
No record format changes: records written by this build are read by older builds unchanged, so a
mixed-version pool replicates normally in both directions.

## Tests

- Unit (store): for every type in the table, a peer-written record grants nothing and its used /
  narrowing side applies; the same record own-written grants; per-writer keys stop a peer squatting
  this machine's next key; a peer `change` whose recomputed direction is raise counts for nothing;
  `legacyUnchanged(kind, self)` ignores a peer's legacy grant and a peer's raise.
- Unit (applier): a delta response with a bad or missing signature from a peer that has signed before
  is refused and counted; an origin mismatch is dropped with a placeholder and the stream continues;
  the boot union takes the writer from the replica file, not the payload.
- Unit (handover): grants from holder A are absent on B; `admit()` on B starts a fresh request; the
  owner's reply to A's open request on B gets the resend line; after hand-back A's grants count again.
- Integration: two-machine fixture, a forged `action-approval` from the non-holder never yields
  proceed-once; the Needs-you item appears once and updates in place.
- E2E (alive): production boot path on a two-machine fixture; the trust journey status read shows
  `peerGrantIgnored` counts; the kill switch restores fold.
- Wiring: `fold` receives a non-empty writer and local machine id on every path (boot, commit, peer).
