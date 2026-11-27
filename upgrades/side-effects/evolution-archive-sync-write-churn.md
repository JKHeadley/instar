# Side-effects review: archive sync stops rewriting the evolution archive on every peer visit

## What changes
- **`EvolutionArchive.importPage`** (src/core/EvolutionArchive.ts) now returns the number of new entries, and writes the archive only when that number is above zero.
- **`EvolutionArchiveSync`** (src/core/EvolutionArchiveSync.ts): after a terminal page, a complete scan of a peer, `nextAttemptAt` is set to `now + EVOLUTION_ARCHIVE_TERMINAL_RESCAN_MS` (15 minutes) instead of 0. A non-terminal page still continues the pass at once (`nextAttemptAt` 0). The rescan still starts from offset 0, as before.

## Why
On the M5 (2026-11-27), Machine Stewardship's exact-path trace found the evolution action archive (856 KiB) replaced 45 times in 40 s, about 0.96 MB/s, out of 910 MB the server wrote in 10 minutes, with local snapshots pinning the space. Each authenticated peer-presence event that found the peer due ran a full pass:
- a reservation write;
- the import, which rewrote the archive even when the page held nothing new;
- a cursor write.

Because a terminal page cleared `nextAttemptAt` to 0, the next presence event, seconds later, ran the same pass again.

## What is preserved
- **Retry charging before any fetch:** unchanged. The reservation is still written (fsynced) before each request, and a reservation that cannot be written still authorizes zero requests.
- **Cursor advance only after durable import:** unchanged. A page with new content is written and fsynced before the cursor. A page with nothing new needs no write, because its content is already durable here.
- **Failure backoff, the six-request park and the incarnation rescan:** unchanged.
- **Memory still replicates:** a peer that gained memory is picked up at the next rescan, at most 15 minutes later. A changed peer URL still starts a fresh state at once.

## What this does not do (offered as a follow-up)
Stewardship also suggested storing the retry and cursor bookkeeping apart from the archive. This change leaves it inside the archive document: the existing safety tests (zero requests when the reservation cannot be written, no double charge, the six-request park across restart) prove those guarantees through the archive's own write. With the two changes above, a rescan costs two archive writes per page (reservation and cursor), at most four pages per presence event. A peer is rescanned once per 15 minutes instead of on every presence event. On this agent's 712-entry archive (15 pages of 50), that is about 30 full rewrites per peer every 15 minutes, spread over about four presence events, against roughly one a second before. Those remaining writes are bookkeeping only. Moving the bookkeeping out of the archive is the natural next step, and Stewardship's after-trace will show whether it is worth the test rework.

## Measured before the change (Machine Stewardship, 2026-11-27, 10-minute baselines)
- M5: 910 MB written by the server in 601 s; 45 archive replacements of 856 KiB in a 40 s exact-path trace.
- Mini: 451.8 MB (0.75 MB/s). Laptop: 145.9 MB (0.24 MB/s). Studio: at least 227.7 MB (0.38 MB/s; 266 replacements observed by inode).
Stewardship will repeat the same methods after the repair.

## Tests
`tests/unit/evolution-archive.test.ts` has three new cases:
- an import that adds nothing does not write;
- after a complete scan, 45 presence events a second apart cause no fetch and no write, and the rescan after the interval writes exactly twice for a one-page archive (reservation and cursor; a multi-page archive writes twice per page, which the new cases do not cover);
- a peer that gained memory is picked up at the next rescan.

One existing case ("keeps failed-page cursor…") ran its forged-page pass immediately after a completed scan. That pass is now scheduled past the interval, and it still asserts the failure is charged and nothing is imported.

Results: `evolution-archive` and `self-action-convergence` 950/950, `graph-source-paged-history-held` 4/4, tsc clean.

## Rollback
Revert this commit.
