# Side-effects review — the engine checkpoint (byte-exact pre-fold transcript, restore)

**Version / slug:** `cb-engine-checkpoint`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.3 step 3 ("the engine checkpoint: a byte-exact copy of the pre-fold transcript file (unscrubbed, because a scrubbed transcript cannot restore the original context), mode 0o600 under the archive root's `checkpoints/`, never served, never replicated, never backed up, deleted on commit or after rollback plus a grace period (default 24 h) … Phase 0 verifies the restore with scrub-triggering and oversize entries present"), step 8 ("resume the recorded session id only when its transcript's last entry id still equals the checkpoint's; otherwise materialise the checkpoint as a new session transcript in the engine's transcript directory and resume that … If the restore itself fails … record `rollback-degraded`"), §14 "Engine checkpoint" (machine-local, hardware-bound) and "Resume of a checkpointed session", §18 Tier 1 list. Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0 task 9, part a; stacked on 8c.
**Tier:** 2 (stores an unscrubbed transcript copy on disk; restore writes into the engine's transcript directory). Size: ~5 files, ~560 LOC incl. ~300 test LOC.

## Summary of the change

1. **`src/monitoring/engineCheckpoint.ts`**
   - `takeEngineCheckpoint`: refuses if a copy or pointer already exists for the fold (`checkpoint-exists`: the restore target is immutable, a retried step 3 can never replace it) and refuses a symlinked archive directory; hashes the source, copies it (`copyFileSync`), fsyncs, re-hashes the copy and refuses (`source-changed-during-copy`) unless it equals the source as hashed; writes the pointer LAST, fsynced with its directory (sha256, bytes, `lastEntryId` = the last line carrying a `uuid`, session id, source path). Files 0600 under `state/context-archive/<topic>/checkpoints/` (dirs 0700). Refuses unsafe ids and a missing transcript.
   - `lastEntryId`: reads a 1 MB tail; if the tail holds no complete entry with a `uuid` (an oversize last entry), reads the whole file once.
   - `verifyEngineCheckpoint`: the copy still hashes to its pointer (size and sha256).
   - `restoreEngineCheckpoint`: refuses an unverifiable copy (`degraded: checkpoint-unverifiable`); `resume` when the recorded transcript still ends at `lastEntryId`; otherwise `materialised`: writes a NEW transcript `<newId>.jsonl` (0600) in the engine's transcript directory in which only the exact compact token `"sessionId":"<recorded id>"` is replaced by the new id — every other byte (numbers, escapes, CRLF, non-UTF-8) is carried over untouched (Claude Code writes compact JSON; an engine that writes `"sessionId": "…"` with spaces would keep its old id, which the per-engine adapter suite checks); never modifies the checkpoint; refuses an existing target or a non-UUID id.
   - `engineCheckpointCarrier`: on the terminal transition, a `committed` or `aborted` fold's checkpoint is deleted (aborted: the context was never replaced); a `rolled-back` fold marks it `settledAt` and keeps it for the grace period; `readEngineCheckpoint` accepts a pointer only when it names this fold's own copy; a checkpoint with no record is an orphan and is removed by the boot sweep. `pruneSettledCheckpoints(now, grace=24 h)` is the sentinel's grace deletion (task 10 calls it).
2. **`src/monitoring/foldCarriers.ts`** — the checkpoint carrier joins `defaultFoldCarriers` (record state read from `FoldRecordStore`).
3. **`src/core/BackupManager.ts`** — `context-archive` added to `NEVER_BACKUP_PATH_SEGMENTS` (the archive root is a sibling of the layers root precisely so it can be excluded, §9.7). Never served: `state/context-archive/` is already in `NEVER_SERVED_PREFIXES` (slice 4).

**Phase 0 posture:** nothing takes a checkpoint yet (the step runner is Phase 2); the boot sweep's carrier pass finds no checkpoints.

## Decision-point inventory

- **Added:** resume vs materialise vs degraded at restore time — deterministic over the copy's hash and the transcript's last entry id.

## 1. Over-block

- A transcript that grows during the copy is refused (`source-changed-during-copy`); the fold must retry the step under the lock (the session is quiescent at step 3 per §7.3, so this is rare).

## 2. Under-block

- Memory/performance: `lastEntryId`'s whole-file fallback and the materialise step read the full transcript synchronously (about 2× its size in memory); above ~512 MB the read throws and the restore takes the degraded path. Streaming them is part of the Phase 2 runner work, where transcripts this large first meet a fold. <!-- tracked: CMT-1536 (Phase 2: stream lastEntryId fallback and materialise for very large transcripts) -->
- Resume compares the last entry id only (the spec's rule); lines without a `uuid` appended after the checkpoint do not change the decision.
- A torn or unreadable fold record reads as no record, so release deletes the checkpoint (the carrier contract); for this one carrier that loses data, which the sentinel's quarantine reconciliation (task 10) must account for. <!-- tracked: CMT-1536 (Phase 0 task 10: never release an engine checkpoint on a torn record) -->
- The materialised transcript rewrites `sessionId` only; other per-session fields (e.g. a `cwd` that moved) are kept verbatim. The adapter verification suite verifies the restore per engine version (§9.3 step 8). <!-- tracked: CMT-1536 (Phase 0 task 11: restore verified per rung and engine version) -->
- The grace deletion runs when the sentinel calls `pruneSettledCheckpoints` (task 10). <!-- tracked: CMT-1536 (Phase 0 task 10: sentinel runs the checkpoint grace pass) -->
- Cross-machine restore (a rung-2 spawn with the packet plus the verbatim tail from the scrubbed archive, `rollback-degraded`) is the runner's path, Phase 2; the checkpoint itself is machine-local by design.

## 3. Level-of-abstraction fit

A pure module with a carrier, like the other fold carriers; the runner (Phase 2) decides when to take and restore, the coordinator owns its lifetime.

## 4. Signal vs authority compliance

No gating. The restore plan is data for the runner.

## 5. Interactions

- **Backup/file viewer:** excluded/never served (above). **Disk Steward:** the copies are bounded by one per non-terminal or grace-period fold per topic.
- **Fold boot sweep:** a quarantined fold keeps its checkpoint (non-terminal ⇒ not released); an orphan is removed loudly.

## 6. External surfaces

None in Phase 0. When used, `materialised` writes one new transcript file into the engine's own transcript directory (the intended restore target).

## 7. Multi-machine posture

Machine-local by design (`machine-local-justification: hardware-bound-resource`, §14): an engine session resumes only on the machine whose transcript directory holds it; never replicated.

## 8. Rollback cost

Revert. No state written in Phase 0.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: called per fold step; the grace pass is one bounded scan per call.

## Evidence

- `tests/unit/engine-checkpoint.test.ts` (8): byte-exact copy of a transcript with a secret-shaped entry and a 1.2 MB entry (sha equal, 0600/0700, last entry id found past an oversize line — the first run caught a real bug there: the 1 MB tail window held no complete entry); unsafe ids and missing transcript refused; resume when unchanged; materialise when moved on (every line equal except `sessionId`, last entry id preserved, checkpoint untouched); a tampered copy is never restored; carrier: commit deletes, rollback keeps until the 24 h grace then pruned, orphan removed.
- `tests/integration/engine-checkpoint-fold-lifecycle.test.ts` (4): the real coordinator with default carriers: commit deletes; rollback keeps (settled); crash past the point of no return keeps it and it still materialises; an orphan is removed by the boot sweep.
- `tests/e2e/engine-checkpoint-crash-lifecycle.test.ts` (1): a REAL child process checkpoints a transcript with secret-shaped and oversize entries, passes the point of no return and dies; a server-style boot quarantines the fold, keeps the checkpoint, and the restore materialises a transcript equal byte-for-byte to the pre-fold one except the session id.
- **L7 on real Claude Code 2.1.322** (throwaway project): a session (`913c78b6…`) was told a codeword (PLUM-7731); its transcript was checkpointed (188,474 B) and then removed; `restoreEngineCheckpoint` materialised `f5b3e6d9…`; `claude -p --resume f5b3e6d9…` answered `PLUM-7731`. Control: a fresh session in the same project answered `NONE`.
- `no-silent-fallbacks` at 494; `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10):** "Concern raised." BLOCKING: (1) a second take for the same fold silently replaced the "immutable" checkpoint with the post-fold transcript (probe: ok:true, new sha) — a retried step 3 would destroy the rollback target; (2) a stale `<fold>.json.tmp` pointer was listed but never removed, a permanent boot-sweep orphan. MINOR: (3) materialise re-serialised JSON, changing bytes (`1.0`, a 20-digit integer, escapes, CRLF); (4) the pointer and directories were not fsynced; (5) whole-file synchronous reads on very large transcripts; (6) resume ignores uuid-less appended lines; (7) pointer `file` and symlinked directories were trusted; (8) `aborted` kept an unscrubbed copy for 24 h, the prune has no caller yet, a torn record deletes; (9) test gaps; (10) the L7 run is an attestation, not reproducible from the tree.

**Resolution:** (1) fixed — `checkpoint-exists` (test: second take refused, sha unchanged); (2) fixed — `.json.tmp` removed with its fold (test); (3) fixed — byte-preserving token replacement (test with `1.0`, a 20-digit integer, escapes and CRLF: output equals input with only the id changed); (4) fixed — pointer and directories fsynced; (5) stated in §2 and tracked to Phase 2; (6) stated (the spec's rule); (7) fixed — a pointer must name this fold's own copy (test), and a symlinked archive directory is refused; (8) `aborted` now deletes at once (test); the prune and the torn-record case are tracked to task 10; (9) tests added for every item above plus `target-exists`, `bad-session-id` and the `context-archive` never-backup pin; (10) the L7 commands, ids and answers are recorded in Evidence; it is re-runnable by hand with Claude Code and is also part of the adapter verification suite (task 11).

**Re-check (independent subagent on Fable 5.2, 2026-11-10 02:59 PST): "Concur with the review."** Every fix verified by probe (immutability in three cases, symlinked `<topic>` and `checkpoints` refused, fsyncs, pointer containment, byte preservation including raw `0xff 0xfe`, `.json.tmp` removal, aborted ⇒ delete with no post-point-of-no-return path to `aborted`). Unit, integration, e2e and `tsc` green. Gates the reviewer set on later work: the prune caller and the torn-record case must close before the first checkpoint taker lands (both are already task-10 items above). New minors and their resolution:
1. A materialise that rewrote no token still said `materialised` — fixed: zero replacements ⇒ `degraded: session-id-not-found` (test with a non-compact `"sessionId": "…"` writer).
2. Nested `sessionId` tokens are rewritten too — intended: any compact token carrying the recorded id is that session's id; stated in the module header.
3. A pre-planted `<fold>.jsonl.tmp` link was written through — fixed: the temp path is removed first and the copy uses `COPYFILE_EXCL` (test: another fold's copy survives).
4. A crash between the copy rename and the pointer write leaves `checkpoint-exists` with no pointer; the fold can only abort (and the boot sweep aborts it). The Phase 2 runner must treat that pair as abort, never retry. <!-- tracked: CMT-1536 (Phase 2 runner: checkpoint-exists with no pointer ⇒ abort) -->
5. Test gaps — added: `symlinked-archive-dir` (nothing written at the link target), a lone stale `.json.tmp`. `source-changed-during-copy` needs a writer racing the copy and is covered by the adapter verification suite's concurrent-append case (task 11). <!-- tracked: CMT-1536 (Phase 0 task 11: concurrent append during checkpoint copy) -->
6. Stale docstrings (file header, carrier, `foldCarriers.ts`) — fixed.
