---
title: Auto-expiry holds, exclusions and reversible archive (CMT-1132)
slug: auto-expiry-holds-and-archive
tier: 1
eli16-overview: docs/specs/auto-expiry-holds-and-archive.eli16.md
---

# Auto-expiry holds, exclusions and reversible archive

## Problem

The 2026-10-30 feature-maturation review read both auto-expiry ledgers in full.
Two model families reached the same answer: turning either sweep live would
close real obligations.

- `commitments.autoExpiry`: 395 of 1,129 eligible. 53 are `behavioral` (standing
  rules, which produce no activity, so "no activity" says nothing about them),
  one is `violated`, and the list holds live duties, including a token rotation
  due in 2027. There is no way to exempt a row.
- `evolutionActions.autoExpiry`: 18 of 300 eligible, including unresolved
  defects. A live sweep deletes the row and tombstones it across machines, and
  the ledger keeps ids only, so nothing could be recovered.

## Change

### Commitments

The agent branch now requires `status: 'pending'` and skips `type: 'behavioral'`.
The operator-wait branch also skips `behavioral`: a standing rule is not waiting
on anyone. It keeps its existing `violated` handling, which is a separate rule
for rows blocked on the operator.

New field `autoExpiryHold: { reason, setAt }`. Both branches skip a held row.
A hold has no end date; one that lapsed by itself would hand the row back to the
sweep unreviewed. It is set or cleared with `PATCH /commitments/:id` and
`{ "autoExpiryHold": { "reason": "..." } }` or `null`. A forwarded PATCH is
validated on the owning machine (`patch-beacon` in `CommitmentMutation`). The
ledger row gains `held`, the count of pending held rows.

### Evolution actions

The same `autoExpiryHold` on `ActionItem`, through `PATCH /evolution/actions/:id`.

A live sweep archives instead of deleting:

1. The full `ActionItem` goes to `state/evolution/action-archive.json` first. If
   that write fails, or the archive is unreadable, the sweep removes nothing and
   marks every ledger item `applied: false`. The archive is read strictly,
   because the tolerant reader would return an empty archive and the next write
   would erase it.
2. The rows leave the queue in one `saveActions`, with no tombstone.
3. Peers get a `put` with `status: 'cancelled'`, which a later put reverses.

Marking the row `cancelled` in place was rejected: the queue cap prunes terminal
rows first, so at saturation (the queue is at 300) the row would be gone, and
tombstoned, in the same save.

`GET /evolution/actions/archive` lists entries. `POST /evolution/actions/:id/restore`
puts one back, with a hold, because its age is unchanged and the next sweep would
archive it again. Archived ids stay reserved in `nextActionId`, so a restore
cannot collide with new work. Restored entries stay in the archive as history.

The ledger item gains `title`, so a reviewer can judge a row without the store.

### Unchanged

Both `dryRun` defaults stay `true`. Neither sweep flips here; that is a separate
decision after re-reading the ledgers.

## Held ids

Holds are live state, not code. After this ships, the desk sets them on the
server that owns each row, using the reason `feature maturation review
2026-10-30`:

- Commitments (union of both reviewers): CMT-015, 020, 026, 055, 071, 159, 210,
  371, 397, 453, 544, 549, 551, 579, 618, 624, 665, 669. CMT-081 is `violated`,
  so the new status rule already covers it.
- Actions: ACT-018, 020, 030, 035, 048, 049, 090, 427, 428.

## Multi-machine posture

Each machine sweeps only its own rows, as before (`originMachineId` for
commitments, the local queue for actions). The commitment hold travels with the
row. The action hold and archive are machine-local, like the queue they guard:
replication is keyed by content, not by `ACT-` id, and a peer's own sweep judges
its own queue.

## Rollback

Revert. Nothing is live while `dryRun` stays true. A hold or archive file left
behind is ignored by the old code.

## Acceptance

- A behavioral or `violated` row is never eligible on the agent branch.
- A held row is skipped on both branches until the hold clears.
- A live action sweep leaves the full record in the archive, emits no tombstone,
  and a restore puts it back and keeps it.
- A damaged archive leaves the queue untouched.
- Existing agents get corrected awareness text through `migrateClaudeMd`.
