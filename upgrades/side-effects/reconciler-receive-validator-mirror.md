# Side-Effects Review — Mirror transfer record into receive-side validator

**Slug:** reconciler-receive-validator-mirror
**Change:** Update `JournalSyncApplier.validateData`'s `topic-placement` branch to mirror
the emit-side `CoherenceJournal.validate` — accept `reason: 'reconcile'` and the optional
cooperative-handoff fields (`status`/`transferTo`/`timestamp`/`drainInFlight`), with the
same strict per-field type checks and the same `known`-keys allowlist.

**Why:** Live two-machine proof (2026-06-30). The ownership reconciler correctly wrote a
real transferring record for the stuck topic 28730, but the RECEIVING machine rejected it
in `validateData` (reason `reconcile` not in the receive-side `reasons` list; the handoff
fields not in the receive-side `known` list), marking the peer's `topic-placement` stream
`suspect` and halting cross-machine replication — so the target never claimed. Completes
root cause #3 (`docs/specs/cross-machine-reconciler-convergence.md`), whose emit-side
extension (#1311) was never mirrored to the receive side.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?
None. The change makes the receive-side validator MORE accepting, and only of inputs the
emit-side already produces and accepts. Before the fix it over-blocked (rejected every
valid transferring record); after, it accepts exactly the emit-side's accepted set. A
normal active placement (no handoff fields) validates exactly as before.

## 2. Under-block — what failure modes does this still miss?
A malformed handoff field is still rejected (status not in {active,transferring};
non-string transferTo; non-finite timestamp; non-boolean drainInFlight; any unknown key →
the `known` allowlist still rejects). The validator does not cross-check semantic
consistency (e.g. status:transferring with no transferTo) — but neither does the emit
side, and the OwnershipApplier (the consumer) already validates transferTo against the
known machine set + epoch fence + timestamp clamp before acting. So nothing actionable is
under-blocked here; semantic checks live in the applier by design.

## 3. Level-of-abstraction fit — right layer?
Yes. This is exactly the receive-side schema mirror of the emit-side schema; the two are
designed to be byte-for-byte equivalent (the source carries a "KEEP IN SYNC" comment).
The fix belongs in `validateData` and nowhere else.

## 4. Signal vs authority compliance
This is a validator (accept/reject of a journal record on receipt) — it holds authority by
design (an invalid record MUST be rejected). The relevant principle here is not
signal-vs-authority but **schema-mirror integrity**: a hand-mirrored validator that drifts
from its source silently breaks replication. The real structural follow-up (logged below)
is to make the two validators share ONE source so they cannot drift again — but that is a
larger refactor; this change first restores correctness. The fix does not ADD blocking
authority; it corrects an existing validator that was wrongly rejecting valid input.

## 5. Interactions — shadow / double-fire / race?
None. `validateData` is the single receive-side gate; this branch only runs for
`topic-placement`. It does not interact with the emit side (separate process/machine), the
applier-materialize step (runs after a record is accepted), or any cleanup. It cannot
double-fire (one validation per received entry).

## 6. External surfaces — visible to other agents/users/systems?
Yes, positively: it unblocks cross-machine ownership transfers that were silently halting.
No new endpoint, config, or user-visible surface. The only observable change is that a
peer's `topic-placement` stream no longer goes `suspect` on a transferring record, so
`GET /pool/placement` / the per-machine ownership records converge as intended. Timing: the
receiver picks up the transfer on its normal journal-pull cadence (seconds), unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)
This change IS a multi-machine coherence fix. Posture: **replicated** — the corrected
validator is on the receive side of the CoherenceJournal cross-machine replication path
(peer `topic-placement` stream → `JournalSyncApplier.apply`). The fix is symmetric (both
machines run the same corrected validator), so transfers in either direction now validate.
There is no single-machine assumption (single-machine agents never invoke the receive
path; this is a strict no-op for them).

## 8. Rollback cost
Trivial. The change is a few added lines in one validator branch. Back-out = revert the
commit; behavior returns to the (buggy) prior state. No data migration, no state repair: a
journal stream that went `suspect` self-clears after K=20 clean applies once valid records
flow, and the replica files are re-pulled from the source of truth (the authoring machine's
journal). No durable corruption is possible from this change.

## Follow-up logged
The two validators (`CoherenceJournal.validate` emit-side and
`JournalSyncApplier.validateData` receive-side) are hand-mirrored and CAN drift again. A
structural fix — extract ONE shared per-kind schema both sides call — would prevent the
whole bug class. Tracked: <!-- tracked: CMT-1840 --> (a structural refactor registered as a
durable commitment; this PR restores correctness for the shipped transferring shape).
