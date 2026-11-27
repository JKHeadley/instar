# Side effects: stop repeat flushes on conversation graph reads

## What changed

Graph custody reads flushed the same unchanged files, and every ancestor directory, on every read. In a profile of one member-loss test, 472 of 515 seconds went to `fsync`: 307 s in `GraphCustodyProfileAuthority.syncRetained` and 155 s in `GraphNativeMemberLossStore.syncFile`.

- `GraphCustodyProfileAuthority`: read-only `syncRetained` now remembers what this instance flushed. `assertMemberLossHeld` moved to the read-only path. This reverses an earlier design comment ("no durability memo survives this public read").
- `GraphNativeMemberLossStore.syncFile`: uses the shared `GraphDurableFileMemo`. Paths that just published a record pass `published`, which always flushes.
- `flushDescriptorOnce` takes `force`.
- If any parent directory's stamp changed, the file and all parents flush.
- `ConversationGraphReplication` historical import: the row's own directory always flushes; its ancestors flush only if they changed. Measured at 200 rows, the import phase made 8,448 flushes, 42 per row. The ancestor walk is estimated at about half of that, not measured separately.

Test updates in the same change, all stale against code already on this branch: owner-changes, fleet-erasure, activation-pins, witness-review, the planned-transition helper, and session-pool wiring (`onAccepted` signature).

## Decision point

No. This changes when a durability flush runs. It adds no check that blocks or filters anything. Signature, byte and identity checks still run on every read, and the memo supplies no authority.

## Review

1. **Over-block:** none. Fewer flushes, no new refusals.
2. **Under-block:** a process that loses a page after a successful flush and then reads the same stamp does not flush again. The old code would have retried. On Linux a retry after an I/O error can falsely succeed anyway, so that retry was weak protection.
3. **Level of abstraction:** the memo stays at the file-sync layer, so read callers are unchanged. The authority keeps its own instance memo because its stamps include the expected content hash.
4. **Signal vs authority:** not applicable, no decision point.
5. **Interactions:** `flushDescriptorOnce` remembers a file without its parents, while `syncNativeLeaseFile`, `syncOwnedGraphIdentityDurably` and similar helpers treat a hit as "parents flushed too". Sharing one path across them would skip parent flushes. The reviewer found no overlap in the scopes checked but did not resolve `this.options.directory`.
6. **External surfaces:** none visible to users. Member-loss steps run faster.
7. **Multi-machine posture:** machine-local by design. A flush is about this machine's disk. Each machine flushes its own copies before remembering them.
8. **Rollback cost:** revert the commit. No data or format change.

## Evidence

- Member-loss `pending`: 207 s before, 16 s after, on the Studio under load. All 16 member-loss execution tests passed at their real 120 s limit. The profile was taken before the second site was fixed.
- 54 tests covering flush behaviour passed: native member-loss store, member-loss source, activation pins. These ran before the forced publish flush was added.
- 28 unit tests pass after it: `graph-durable-file-memo`, `graph-custody-bootstrap`.

## Not established

- Behaviour on real power loss. Nothing here cuts power.
- APFS's real timestamp granularity.
- Whether a state root is ever swapped while the process runs.
- Whether the historical member-loss test and the large history test pass at their limits. The historical test took 121 s against 120 s on the Studio at load 30 to 50, mostly CPU. The large history test has not been run at 4,000 rows on this code.
- The full suite on this head.
- The saving from the import ancestor change.
- What remains of large-history cost: about 100 flushes per row across two machines, mostly real first writes. This change does not remove those.

## Second-pass review

One fresh Claude reviewer, read-only, same model family, nothing run. It raised one medium concern: publish paths lost their unconditional directory flush, so two records linked in one timestamp tick could leave a directory entry unflushed. Fixed with the forced flush. It raised one low concern: a state root swapped in place left the holding parent's stamp unchanged. Fixed by flushing all parents on any change. A second read of those fixes and the import change raised two more low concerns, both fixed: a failed forced flush left an old stamp a same-tick retry could trust, so the stamp is now forgotten before each flush; and ancestors created without a flush could be skipped, so an instance's first imported row now flushes every ancestor. Those last two fixes have unit coverage for the first only, and no third read.
