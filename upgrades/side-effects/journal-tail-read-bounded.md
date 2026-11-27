# Side-effects review: the coherence-journal tail read stops at the entries it needs

## What changes
`readTailTolerant` (src/core/CoherenceJournal.ts) still reads the same window, the last `min(size, byteCeiling)` bytes of a journal file. But it now walks that window backwards in `TAIL_READ_CHUNK_BYTES` (64 KiB) steps and stops as soon as it has `limit` valid entries. The old body allocated, read and split the entire window (up to 4 MiB under the reader's default ceiling) synchronously, even when only the newest few hundred entries were needed. The reader's own contract already promised "O(limit) not O(file)".

## Why
The stall source on the Laptop (2026-11-27, `.instar/state/handoffs/laptop-3998-live-gap-145097.cpuprofile`): the profiler started while the server thread was blocked, and the first sample, covering 11.6 s, sits in `readTailTolerant <- CoherenceJournalReader.query <- OwnershipApplier.tick <- timer`. Weighted by time, that stack is about 38% of the 31.8 s profile. `OwnershipApplier.tick` is synchronous and walks several placement pages per tick, and each page is a full `query()` that re-read every stream tail. Caveat: the profile shows where the thread was when sampling could start, not the whole block's composition.

## What is preserved (identical results)
For every input, the new body returns the same `entries` (same records, same newest-first order), the same `skippedCorrupt` count and the same `truncated` flag as the old body. That includes:
- the window boundary;
- dropping a partial first line when the window starts mid-file, while keeping a window that holds no newline as one line, as before;
- files without a trailing newline;
- empty lines;
- multibyte text (lines are split on the newline byte, which never occurs inside a UTF-8 sequence);
- a read error, which still returns no entries.

The reader's byte budget, cursor, paging and replay logic in `CoherenceJournalReader.query` are untouched, so cursors and replay are unchanged.

## Not done here
The read stays synchronous, but it is now bounded by the entries needed. Making `OwnershipApplier.tick` asynchronous, or caching one read across the pages of a tick, would cut further but changes the tick's contract. Post-Mortem keeps the bounded-close companion and the rehearsal.

## Tests
`tests/unit/coherence-journal-tail-equivalence.test.ts`:
- compares the new reader with the old body (kept verbatim) over 392 combinations of generated files (corrupt, empty, multibyte and 90 KB lines; with and without a trailing newline), limits and byte ceilings, including ceilings around the chunk size;
- checks that a missing or empty file returns nothing;
- proves a 50-entry read from a 3.6 MB file reads at most one 64 KiB chunk.

Results: the existing CoherenceJournal*, OwnershipApplier* and JournalSyncApplier tests pass (9 files, 131 tests), and tsc is clean.

## Rollback
Revert this commit.
