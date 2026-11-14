# NCB slice 3f — status

**Slice:** native-conversation-any-machine-access §3f, "Transcripts are copied to every machine (F4, message 141905)".
**Branch:** `echo/ncb-3f-checkpoint-replication`, from `origin/main` 3ae8208a6 (v1.3.1739) with slice 3d (PR #3100, `echo/ncb-3d-transcript-reads`, a fast-forward) merged in: 3f reads through 3d's `transcriptAudience.ts` and transcript route. The spec, its ELI16 and its convergence report come in with 3d. Slice 3b's files (PR #3092) are not touched.
**PR:** https://github.com/JKHeadley/instar/pull/3103 (opened through a one-shot session on the Studio, since the M5 token cannot create PRs; JKHeadley requested as reviewer by the same session).
**Local Verify:** requested on the Studio (`POST /local-verify {"pr":3103}`, port 4042) right after this note was pushed, so it runs on the final head. Its answer is in the build session's final report.
**Merged:** no (by instruction).

## What is built

- `src/core/transcriptCheckpoints.ts`: the source (`TranscriptCheckpointSource`), the copy store (`TranscriptCopyStore`), the production wiring (`wireTranscriptCopies`, which server.ts calls), the journal emit seam, the kind registration and the CLAUDE.md section.
- Incremental checkpoints of whole redacted rows, on the token-ledger poller's cadence and at session end; a trailing partial row held back; `sourceThroughOffset` = end of the last whole row emitted, written in the same atomic write as its checkpoint (outbox); re-emit idempotent.
- Manifest with explicit coverage on every machine: verified `bytes`, `sha256`, contiguity, seq order; a gap stops coverage; a piece that does not verify is not assembled; reads see only committed bytes.
- Audience: owner and agent only, resolved at read time from the reading machine's signed team record over the union of held checkpoints' conversations (most restrictive), currency refusal included; a session whose conversations do not fit on a checkpoint fails closed. No device or team route reads the store (test: no `DEVICE_ALLOWLIST` rule matches either route).
- Applier forging rule: a checkpoint is accepted only from the machine that ran the session.
- Reads: `GET /sessions/NAME/transcript` → `via: "copy"` with coverage when the source does not answer or the session is not recorded here; `GET /transcript-copies` → coverage per session, no text.

## Maturation-plan row (CMT-047)

Dark on every agent: `multiMachine.stateSync.sessionTranscripts.enabled: false` (default), a `DARK_GATE_EXCLUSIONS` entry (action-bearing: a copy cannot be recalled), a sensitive ladder entry `multiMachine.stateSync.sessionTranscripts` (dev-agent-live: config flip, 7-day soak; fleet: code, 14-day soak; fired/error evidence from the feature evidence log). Wired only when journal replication is fully on. Posture marker in the side-effects artifact: `machine-local-justification: migrating-to-unified ratified=5a4efecc1 tracking=commitments.CMT-047 since=2026-11-11 expires=2026-12-09`. Full plan (rungs, graduation criterion, kill criteria) in `upgrades/side-effects/ncb-3f-transcript-checkpoints.md` → Maturation plan.

## Tests

Run on the Mac M5 Pro, `TMPDIR=/Users/adriana/echo-compute/tmp/ncb3f` (outside /tmp, no dots), umask 022; load per core was above 1 at the start, so vitest ran with `--maxWorkers=2` to 4.

- New: `tests/unit/transcriptCheckpoints.test.ts` (24), `tests/unit/transcriptCopies-awareness-migration.test.ts` (3), `tests/integration/transcript-copies-read.test.ts` (9), `tests/e2e/transcript-copies-alive.test.ts` (2, a real CoherenceJournal and JournalSyncApplier and the production wiring function). All pass.
- Unit neighbours (journal, applier, emitter, peer reader, ladders and maturation, dark gate, config defaults, templates, every `migrate*` and `PostUpdateMigrator*` test, the 3d reads): 245 files, 1,984 tests, 0 failures (final run after all fixes). The first run found 6 failing files, all from this change and fixed: the ladder plan text over the 400-character limit, and the dark-gate golden line map needing the new row and +7 shifts.
- Integration neighbours (journal, replication, pool reads, transcript, state sync): 29 files, 147 passed, 1 skipped, 0 failures.
- E2E neighbours (same selection): 23 files, 63 passed, 0 failures.
- `tsc --noEmit` clean; the pre-commit's 52 lint steps passed.

## Second-pass review

Independent subagent. First read: "concern", 10 findings, none a token leaving the source or a copy shown outside its audience. Fixed: the final checkpoint lost when a session ends during a running pass; copy reads bounded by the manifest; withheld rows named in the coverage; more than 64 conversations fails closed; escaped secrets; the line cap bounded by bytes; the production wiring extracted and run by tests (plus a timer when the token-ledger poller fails); the "not asked" sentence; the manifest index; live secrets. In part: the disk bound (waiting chunks capped at 600 per session, outbox pruned at 14 days; copy retention and a Disk Steward floor not built) and the tmux-name collision across machines (the answer names its machine, the copy's own audience applies). Re-check: concur.

## Open problems

1. **The 3f short spec (owed 2026-11-18, CMT-047) is not written.** This build follows every decision §3f fixes; the values §3f item 6 leaves to that spec are chosen here (40 KiB chunks, 3 MiB window, 256 MiB per day, journal retention 2 x 32 MiB, 600 waiting chunks). **Copy retention, a total copy-store size bound and a Disk Steward floor are not built.** The second pass and the artifact agree the switch must not be flipped anywhere until they are.
2. **The copied spec trips the orphan-deferral lint** (same as 3b and 3d): the commit used the logged override (`INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1`); the override log line is committed with this note. The approved spec text is not edited.
3. **This PR's diff includes 3d until #3100 merges.** Merge #3100 first; then this PR shows only the 3f commits.
4. **Live proofs not run** (test-agent-live: a throwaway pair, a session read from the copy while its source sleeps, the member-private refusal). They belong before the switch is flipped.
5. **Backfill** of transcripts that predate the switch is not built (§3f item 6); a peer asleep past the journal window sees a gap that never closes and says so.
