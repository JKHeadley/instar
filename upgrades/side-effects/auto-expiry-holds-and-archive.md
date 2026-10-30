# Side-Effects Review — Auto-expiry holds, exclusions and reversible archive (CMT-1132)

**Version / slug:** `auto-expiry-holds-and-archive`
**Date:** `2026-10-30`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent`

## Summary of the change

Tier 1: both sweeps remain dry-run and a revert fully undoes it. `CommitmentTracker`
agent branch now requires `pending` and skips `behavioral`; operator-wait also
skips `behavioral`; both skip `autoExpiryHold`. `EvolutionManager` honours the same
hold and archives full records before removal, with no tombstone. New: `AutoExpiryHold`
and `parseAutoExpiryHold` in `AutoExpiryLedger.ts`; hold on both PATCH routes and the
forwarded `patch-beacon`; `GET /evolution/actions/archive`; `POST /evolution/actions/:id/restore`.
Awareness text corrected for new and existing agents.

Proportion: Tier 1, 17 files, about 430 added lines, most of them tests and docs.
One review round. Time was lost to a stray `cat` and an 8-file test batch that
queued as a full suite; neither changed the design.

## Decision-point inventory

- `autoExpiryDisposition`: modify, narrower eligibility.
- `operatorWaitDisposition`: modify, narrower eligibility.
- `runActionAutoExpirySweep`: modify, removal becomes archive; hold added.
- `saveActions`: the `explicitlyRemoved` parameter is gone; the prune tombstone path is unchanged.

## 1. Over-block

The change only narrows what can close. A genuinely dead behavioral row now never
ages out; it needs a deliberate withdraw, which is the right cost. A forgotten hold
keeps a row open forever by design; holds are visible on the row and counted in the
ledger. A `violated` row no longer ages out, so it needs a real close.

## 2. Under-block

Age-only expiry still applies to everything unheld and pending. Reviewers named
rows they read; other live rows may remain in the 300-odd left. The flip stays
gated on re-reading the ledger, which this change does not automate. Astra's fuller
ask, evidence of resolution before closing, is not built; reversibility is what
makes a wrong close survivable.

The queue-cap prune (EVO-022) still tombstones and drops terminal rows. That is
separate from this sweep and already tracked.

## 3. Level-of-abstraction fit

Eligibility lives in the two existing predicates. The hold is data on the row, not
a list in config, so it survives id-free moves and needs no restart. The archive
sits beside the queue in the same state directory and is written through the same
atomic `writeFile`.

## 4. Signal vs authority compliance

Compliant. No new blocking authority over agent behavior; a hold is an explicit
record set by an authenticated caller, and both changes only reduce what the sweeps
may do.

## 4b. Judgment-point check

No LLM or judgment is added. The hold is a human or review decision recorded as
data; the rules are structural facts (type, status).

## 5. Interactions

- Undated resurfacer and overdue checks read the queue: an archived row stops
  resurfacing, the same as the old delete. A held row keeps resurfacing, which is correct.
- `nextActionId` reads the archive to reserve archived ids. A damaged archive only
  warns: new actions keep working, the sweep refuses, and restore refuses any id
  already in the queue.
- An owner machine on older code drops a forwarded hold and answers no-op, so a
  forwarded hold is confirmed by reading the row back.
- `.claude/hooks/action-queue-archive.mjs` on this agent is an unrelated belt that
  observes the queue; different file, no conflict.
- Duplicate entry after a crash between archive write and queue save is replaced by
  the next archive of that id.

## 6. External surfaces

New optional fields on commitment and action JSON; new routes under an existing
prefix. PATCH error text lists the new field. Replication peers receive `cancelled`
puts instead of tombstones. No user-visible message changes.

## 6b. Operator-surface quality

No operator action is added. Holds are set by the agent in conversation.

## 7. Multi-machine posture (Cross-Machine Coherence)

Commitment hold: replicated with the row; the PATCH forwards to the owner and is
validated there. Action hold and archive: machine-local BY DESIGN, like the queue
they guard; each machine sweeps its own queue, and replication is keyed on content
rather than the local `ACT-` id. A closed row reaches peers as a `cancelled` put, and
a restore as a live put. Older peers handle both as ordinary puts. No user-facing
notice, so no one-voice concern.

## 8. Rollback cost

Revert and release. No migration. Old code ignores the new fields; an archive file
is inert. The migrator's wording correction would stay in place, harmlessly, until
the next doc change. Rows already archived while live would need a restore first, and
nothing can be archived while `dryRun` stays true.

## Conclusion

Safe to ship: strictly reduces what either sweep can do, and both remain dry-run.

## Second-pass review (if required)

An independent subagent read the diff and raised two concerns; neither let a sweep
destroy a record. A damaged archive blocked all `addAction` calls, and a hold-only
PATCH could get a 400 from the beacon shape check on some rows. Both are fixed with
tests. It found archive ordering, crash windows and restore emission sound, and did
not read the replication merge code; the e2e test covers that path.

## Evidence pointers

`tests/unit/CommitmentTracker-auto-expiry.test.ts`, `tests/unit/evolution-action-auto-expiry-ledger.test.ts`,
`tests/integration/evolution-actions-patch-route.test.ts`, `tests/e2e/commitment-auto-expiry-api-lifecycle.test.ts`,
`tests/e2e/ws2-evolution-actions-cross-instance.test.ts`.

## Class-Closure Declaration (display-only mirror)

Class: age-based closure of records that age cannot judge. Closed on both sweeps'
every branch by the hold; the `expireCommitments` path is excluded because it acts
on an explicit `expiresAt`, not on age.
