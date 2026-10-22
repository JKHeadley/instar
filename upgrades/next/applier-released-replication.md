# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **A released topic now replicates as released, not as live ownership by the machine that let it go.** A `release` CAS was journaled as `{owner, epoch, reason: 'released'}` with no `status`, and every peer's `OwnershipApplier` materialized it as `active(owner = releaser)` at the higher epoch. On a multi-machine agent that meant a topic one machine released looked, on every other machine, like that machine still owned it: the pin target's reconciler saw a live owner and deferred forever (`deferred-no-evidence`), and a standby machine that cannot send kept spawning sessions for a conversation it could not answer in (topic 127648, 2026-10-21). The `emitPlacement` funnel in `server.ts` now carries `status: 'released'` and normalizes `reason` to `released` for any released record; `CoherenceJournal.validate()` and `JournalSyncApplier.validateData()` accept that status; and `OwnershipApplier` materializes a `released` local record for a row with `status: 'released'` OR the legacy bare `reason: 'released'` — so rows from a peer that has not updated yet still converge. The `POST /pool/transfer` release half, which writes to the journal directly, carries the same status. Records this bug ALREADY wrote are repaired too: a released row at the SAME epoch as a local record the applier itself materialized as `active` (nonce `applier:<owner>:<epoch>` on both sides) is corrected to `released` through a new nonce-bound `correctMaterializedStatus` on both ownership stores — the fast-forward CAS can never touch an equal-epoch record, and a released topic produces no fresh row, so without this the stuck picture would have stayed stuck. A record written by a local CAS is never rewritten. Rolling-update note: a machine still on the old version schema-rejects the new `status: 'released'` value and halts its copy of that peer's placement stream until it updates (minutes, via the auto-updater) — the same shape as the 2026-06-30 `transferring` rollout.

## What to Tell Your User

If you run me on more than one machine: when you ask me to move a conversation to a particular machine, it now actually lands there once the old machine lets it go. Before this, the other machines kept believing the old machine still owned the conversation, so the move never completed and the conversation could go quiet. Nothing to set up.

## Summary of New Capabilities

- Cross-machine ownership records agree after a release; a pinned move completes instead of waiting forever.

## Evidence

- `tests/unit/OwnershipApplier-released.test.ts`: the exact live journal row (`reason: 'released'`, no status) materializes as `released`; an explicit `status: 'released'` row does too; a lower-epoch release never clobbers a fresher local claim; a later higher-epoch claim by the pin target lands; a `transferring` row still materializes as transferring.
- `tests/unit/JournalSyncApplier.test.ts`: a `status: 'released'` record passes receive-side validation and the stream stays `current`.
- `tests/unit/CoherenceJournal.test.ts`: a `status: 'released'` placement is not schema-rejected at the source and round-trips through the stream file.
- Observed before the fix (2026-10-22 03:1xZ): Mini's local record `released@3`, Studio's `active(mini)@3` materialized by the applier from the same row; Studio reconciler `deferred-no-evidence`, Mini `not-my-move`; `GET /pool/placement?topic=127648` → `pinState: diverged`.
