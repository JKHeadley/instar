# Side-Effects Review — Transcript checkpoint replication (NCB slice 3f)

**Version / slug:** `ncb-3f-transcript-checkpoints`
**Date:** `2026-11-11`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Builds slice 3f of `docs/specs/native-conversation-any-machine-access.md` (F4, message 141905: "FULL insight/access to any conversation AND the session behind it, regardless of what machine you are on"), on top of slice 3d (PR #3100, merged into this branch).

- `src/core/transcriptCheckpoints.ts` (new): the source side (`TranscriptCheckpointSource`), the copy store (`TranscriptCopyStore`), the store schema and kind registration (`sessionTranscripts` / `session-transcript-checkpoint`), the journal emit seam (`journalCheckpointEmit`), and the CLAUDE.md awareness section.
  - Source: per session, reads from `sourceThroughOffset` in windows of at most 3 MiB, splits whole rows (a trailing partial row is held back), redacts each row (`redactRow`: byte-identical when no secret is present; otherwise inside the parsed JSON, so a numeric PIN inside another number cannot break the row; as text when the row does not parse), and cuts one checkpoint `{ sessionId, session, sourceMachineId, seq, fromOffset, toOffset, sourceThroughOffset, rowCount, firstAt, lastAt, sha256, bytes, conversations, final, withheldRows }`. The checkpoint and its offsets are written in ONE atomic file write (the outbox, `.instar/state/transcript-checkpoints/source/`) before anything is emitted; the pending checkpoint is cleared only after every chunk was accepted and the journal confirmed the last seq durable. A row larger than 3 MiB becomes a marker row naming its size. A daily byte budget (256 MiB default) and a per-pass chunk budget (90, under the journal's per-kind burst of 100) bound emission. Session end cuts a final checkpoint once every whole row is copied.
  - Chunks: each checkpoint's redacted rows are cut into 40 KiB pieces, base64, one journal entry each (~53 KiB, under the 80 KiB replicated line cap). Record keys are `tc-<sha(sessionId)>-<seq>-<sha16>-<index>`; re-emitting a pending checkpoint produces the same keys and bytes.
  - Copy store: lands each received chunk (only from the machine that ran the session), assembles checkpoints strictly in seq order when every chunk is present, verifies `bytes`, `sha256` and contiguity (`fromOffset` equals the coverage so far), appends to `copy.jsonl`, and commits by writing `manifest.json` (bytes past the manifest from a torn append are cut before the next append). A gap stops coverage at the gap; a complete checkpoint that does not verify sets `problem` and stops there. `catchUpFromJournal` re-lands peer stream files at boot (idempotent).
- `src/core/CoherenceJournal.ts`: the new kind in `JournalKind`, `JOURNAL_KINDS`, seq/high-water/dedupe/rate maps, and retention `{ maxFileBytes: 32 MiB, rotateKeep: 2 }`.
- `src/core/JournalSyncApplier.ts`: a checkpoint entry whose inner `origin` or `sourceMachineId` is not the sender is `forged` (no relaying another machine's transcript); the kind maps to `multiMachine.stateSync.sessionTranscripts` for refusal evidence.
- `src/server/routes.ts`: `GET /sessions/:name/transcript` answers from the copy (`via: 'copy'`, `copy: { throughAt, complete, sourceAwake, sentence }`) when the machine that ran the session does not answer (timeout/transport), when it has no known address, or when the session is not recorded on this machine. The audience is resolved on this machine over the union of the manifest's conversations, through the same `transcriptAudience` as the live read (currency refusal included). `GET /transcript-copies`: coverage per session, no text; owner only.
- `src/server/AgentServer.ts`: `transcriptCopies` into the route context; `transcriptCheckpointTick` rides the token-ledger poller's `afterTick` (own 60 s timer when there is no token ledger).
- `src/commands/server.ts`: kind registration; when `stateSync.sessionTranscripts` resolves on and the journal and emitter exist, builds the source and the copy store, lists sessions (running, or ended in the last 48 h; transcript path and conversations exactly as 3d's verb does), lands peer commits in the copy store, fires the final checkpoint on `sessionComplete`, and runs the boot catch-up. Evidence rows go to `multiMachine.stateSync.sessionTranscripts` in the feature evidence log.
- Config: `multiMachine.stateSync.sessionTranscripts: { enabled: false, bytesPerDay: 268435456 }`, a `DARK_GATE_EXCLUSIONS` entry (action-bearing: a copy cannot be recalled), and a sensitive ladder entry in `src/data/feature-ladders.json`.
- CLAUDE.md awareness for new agents (`generateClaudeMd`) and existing agents (`migrateClaudeMd` + framework shadow), guarded by a marker.

Tier 2 (spec-driven; new replicated kind and wire contract; irreversible data placement once switched on). Size: 7 new files and 12 modified, about 1,900 added lines including tests. Effort: one build pass plus one fix round from the second pass (10 findings, 8 fixed fully, 2 in part), no spec rounds (the spec converged in six rounds before this build); commit attempts recorded in the status note.

## Maturation plan

- **test-agent-live:** a throwaway pair with the switch and journal replication on: run a session on one, put it to sleep, read the session on the other (`via: "copy"`, coverage sentence), and the owner refusal for a member's private conversation. Before the switch is flipped anywhere (owner Echo, by 2026-12-02).
- **dev-agent-live:** Echo's pool, from 2026-12-02 (CMT-047): the switch on, `GET /transcript-copies` on each machine reaches every session of every other machine within one poller cadence; one real read of a sleeping machine's session from the copy. Soak 7 days.
- **fleet:** the same release with the default flipped, after the dev soak, by code (ladder `fleet` rung, soak 14 days).
- **graduation criterion:** on Echo's pool over 14 days: at least 20 `fired` checkpoint rows; `error` at most 2% of rows; zero copies with `problem` set; zero reads where a person outside the audience was shown a copy (the audience is an invariant; any one is a kill).
- **dark-window:** until 2026-12-02 (CMT-047), owner Echo.
- **ladder:** multiMachine.stateSync.sessionTranscripts

`machine-local-justification: migrating-to-unified ratified=5a4efecc1 tracking=commitments.CMT-047 since=2026-11-11 expires=2026-12-09` — until the switch is on, session transcripts stay proxied-on-read over 3d's signed verb; this slice is the replication path that ends the interim.

Kill criteria (any one: switch off that day): an unredacted token or PIN in any checkpoint; a copy shown to anyone outside its audience; a copy presented as complete when it is not; a repeated or skipped row in a copy.

## Decision-point inventory

- Transcript audience on a copy read — **pass-through** (the 3d invariant, `resolveTranscriptAudience`, fed the union of held checkpoints' conversations).
- Applier forging rule for the new kind — **add** (invariant: a checkpoint is accepted only from the machine that ran the session).
- Chunk size 40 KiB, window 3 MiB, 90 chunks per pass, 256 MiB per day, retention 2 x 32 MiB, 48 h session window — **add** (judgment-candidate values within the spec's floors; spec §3f item 6 leaves them to the 3f spec; see Open problems).

---

## 1. Over-block

- A row larger than 3 MiB (a big tool result or image) is copied as a marker naming its size, not its content. The reader shows no entry for the marker, so a copy read counts it in `copy.withheldRows` and its sentence says "One row was too large to copy and is named by size only."; the live read (3d) still serves the row while the source is awake.
- A peer asleep longer than the journal retention window (2 archives of 32 MiB of this kind on the source) sees a seq gap that never closes; its copy stops at the gap and says so. Backfill is left to the 3f spec (§3f item 6).
- Past the daily budget the source stops copying until the next UTC day; coverage reads as behind, honestly.
- A source file that shrinks (replaced or cut) is not re-copied; evidence `source-shrank`, the copy keeps what it has.
- Copy-read cursors are positions in the redacted copy, not in the source file; a cursor from a live page does not continue a copy page (each answer says `via`).

## 2. Under-block

- A session running on any machine can read the copy files on that disk directly, as it can the source transcript and the conversation log (spec §3d item 2 Stated limit, §5, accepted).
- Redaction removes this machine's own API token and dashboard PIN only. A transcript holds other secrets; the audience rule, not redaction, limits who reads it (spec §3d item 2 Redaction). The copy read additionally removes the reading machine's own token and PIN.
- `conversations` on a checkpoint is the session record's view when the checkpoint was cut (same lookup as 3d's verb); a session whose record names no conversation is the owner's (spec decision for jobs and hand-started sessions).
- The currency refusal does not fire on a machine whose peers show no sign of being awake (spec Stated limit, by design).
- Support bundles: not changed; whether a bundle includes `.instar/state/transcript-checkpoints/` was not audited here (spec Left behind 19). See Open problems.

## 3. Level-of-abstraction fit

The carrier is the existing replicated journal (same emitter, applier and peer pull as app conversations), with its own store key, as §3f item 2 fixes. The copy store is its own on-disk store, filled from the applier's commit observer, not from `ReplicatedPeerStreamReader.materialize` (which folds a whole store into memory and would hold every transcript). The audience decision is the 3d pure function, applied where a person is answered (the route). The outbox is per session, because the transaction that matters is per session (a checkpoint and its `sourceThroughOffset`).

## 4. Signal vs authority compliance

Required reference: docs/signal-vs-authority.md.

Two authorities, both closed decisions over structured facts, not heuristics: the audience refusal (3d's invariant over the signed team record and the confined list, fail-closed) and the applier's forging rule (equality of the sender with the checkpoint's own origin fields). The copy store's verification (length, sha256, contiguity) refuses to present unverifiable bytes; it holds no authority over anything but its own copy. Budgets and windows are tuning within floors, and every hold is recorded as evidence.

## 4b. Judgment-point check

No competing-signals decision gets a static heuristic. The size values are within the floor "no unredacted token leaves the source; no copy is shown outside its audience; a partial copy is never called whole; coverage always says how far it reaches".

## 5. Interactions

- Journal rate cap (100 burst, 50/s per kind): a pass emits at most 90 chunks; a checkpoint that does not fit the remaining budget waits for the next pass whole, so a checkpoint is never half-emitted by budget (a mid-checkpoint `rate-limited` keeps it pending and re-emits it whole; duplicates are harmless).
- Journal-replication mode: the failure-only replication mode (coherence journal replication not explicitly on) does not carry this kind, so server.ts wires the source and the copy store only when journal replication is fully on; with the switch on and replication not, it logs one line and records `held: journal-replication-not-on` instead of cutting checkpoints that could never leave.
- Witness index: `ReplicatedPeerStreamReader`'s boot rebuild scans registered streams, this kind included (one witness entry per chunk key, not the bytes).
- 3d transcript route: the live path is unchanged; the copy path runs only where 3d returned 502 (`peer-unreachable`), 404 (`peer-unknown`) or 404 (not recorded here).
- `TokenLedgerPoller.afterTick`: the pass runs after the two existing monitors; the poller's own `running` guard and the source's guard prevent overlap.
- `lint-dev-agent-dark-gate.test.ts` golden map: one row added, four shifted by +7 (the new config block).

## 6. External surfaces

- Wire contract: a new replicated kind. Older peers do not register it and do not advertise receiving it, so they are never sent it; an older applier drops unknown kinds.
- HTTP: `via: 'copy'` and `copy` on the transcript answer (additive); new owner-only `GET /transcript-copies`.
- Disk: up to the source budget per day lands on every other machine, plus two 32 MiB journal archives of the kind per origin. Chunks waiting behind a missing checkpoint are capped at 600 per session (about 24 MiB); past that, later chunks are not kept and the copy says it stops at the gap. Finished outbox records are pruned after 14 days. Retention of assembled copies and a Disk Steward floor are not built (spec §3f item 6 leaves them to the 3f spec; Open problem 1).
- Depends on runtime: the journal's durability confirmation (`awaitDurableSeq`); a timeout keeps the checkpoint pending.

## 6b. Operator-surface quality

No dashboard file changes. The coverage sentence is plain English and fixed in code.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Session transcripts: **replicated** (this slice is the path), dark until CMT-047; meanwhile proxied-on-read over 3d (`machine-local-justification: migrating-to-unified ... tracking=commitments.CMT-047`).
- Source outbox (`transcript-checkpoints/source/`): **machine-local by design**, it describes the reading position in a file on this machine's disk.

  machine-local-justification: hardware-bound-resource

- Copy store: **replicated** destination; each machine derives its own manifest from what it holds, so a status read is this machine's view (named as such).
- No user-facing notices, no generated URLs, no topic-bound state.

## 8. Rollback cost

Switch off: emission and landing stop at once; existing copies stay on disk and stay readable only by the owner-only route, which reads them only when the store is wired (switch off means not wired, so nothing reads them). By version: the kind is unregistered, the journal keeps the files until rotation. Copies already on other machines cannot be recalled (FD-11, irreversible by decision), which is why it ships dark.

## Open problems

1. The 3f spec's own short document (owed 2026-11-18, CMT-047) is not written by this build. Copy retention, a total copy-store size bound and a Disk Steward floor are not built; the second pass holds, and this artifact agrees, that the switch must not be flipped anywhere until they are. The decisions §3f fixes are built as specified; the values §3f item 6 left to it (chunk size, budget, disk floor, retention, backfill) are chosen here as stated above and should be ratified or changed by that spec before the switch is flipped.
2. Support-bundle exclusion of the copy store is not audited (spec Left behind 19).

## Conclusion

Builds slice 3f as specified, dark. Clear to merge once the second pass concurs and Local Verify is green.

## Second-pass review

**Reviewer:** independent second-pass subagent

Concern raised:

1. The final checkpoint is lost when session end arrives during a running pass. `src/core/transcriptCheckpoints.ts:301` returns `{}` while `running` is set, and `src/commands/server.ts:6318-6320` sends the final only through `tick()`. `finalRequested` is persisted only inside `copySession` (`:355`), so it is never recorded. Later periodic passes never pass `final`, so that copy is never `complete`. This is fail-safe (it under-claims), but the final path does not reliably run in production. Fix: persist `finalRequested` before the running guard, or queue finals and drain them after the current pass.
2. A copy read is not bounded by the manifest. `src/server/routes.ts:12506` reads `copy.jsonl` to its file size (`readTranscriptPage` uses fstat). Suppose a crash lands after the append and fsync (`transcriptCheckpoints.ts:529-531`) but before the manifest write (`:541`). The route then serves bytes the manifest never committed until the next assemble cuts them. That breaks "the manifest is the commit point" for reads. Fix: cap the read at `m.throughOffset`, or cut the file to `throughOffset` before every read.
3. A withheld row is skipped silently on a copy read. The marker row (`transcriptCheckpoints.ts:131-133`, type `instar-row-withheld`) produces no entry in `SessionTranscriptReader.extractRaw`, which only knows user/assistant/response_item. `coverage()` (`:576-581`) and the route answer (`routes.ts:12507`) carry neither `withheldRows` nor a sentence about it. This is the silent clip the 3d kill criteria forbid. The artifact's Over-block line "A copy read shows the marker" claims more than the code does.
4. The audience can be less restrictive than the live read. The source truncates `conversations` to 64 (`transcriptCheckpoints.ts:342`, `.slice(0, MAX_CONVERSATIONS)`). A session that served more than 64 conversations is then judged on a subset, which breaks "most restrictive over every conversation". It should fail closed: send no checkpoint, or mark the audience unreadable.
5. Disk is unbounded and there is no disk floor. Chunks for seqs past a gap that never closes land forever and are never assembled or pruned (`transcriptCheckpoints.ts:476-478`). With `rotateKeep: 2` (`CoherenceJournal.ts` retention), a peer asleep past about 64 MiB of this kind gets a permanent gap. After that, every later checkpoint for that session adds to the chunks directory and nothing new is ever readable. Source state files are never pruned either. The artifact's §6 says "no retention of copies" but leaves out the orphan-chunk growth and the missing Disk Steward floor.
6. Redaction is detected on raw bytes only (`transcriptCheckpoints.ts:111`). If a writer JSON-escapes any character of the token (`\uXXXX`), the row is kept byte for byte, and the replica's JSON parse rebuilds the token. Today's writers (JS and serde) do not escape ASCII, so this is unlikely, but it is a gap in "no unredacted token can leave". Fix: when the row contains a backslash, also test the parsed strings.
7. The line cap is enforced only for ASCII. `validateCheckpointChunk` allows 64 conversation keys of 256 characters each (`:162`). With multi-byte characters, a 40 KiB chunk (about 54.6 KB base64) plus those keys can pass the 80 KiB entry cap. The journal would then refuse every chunk, and the checkpoint would stay pending forever, logged only as a `held` row. The line-cap test (`tests/unit/transcriptCheckpoints.test.ts:256-261`) uses ASCII only. Fix: bound by bytes.
8. The production wiring is only string-matched. `tests/e2e/transcript-copies-alive.test.ts:41-51` greps source text. The server.ts block itself (the switch condition, `sourceSessions`, the final race in item 1, the `_conversationRegistryRef` lookup) is never executed by a test. Also, the own-timer branch needs `!this.tokenLedger` (`AgentServer.ts:8920`), so a token-ledger poller that fails to construct (`:8941` catch) leaves no tick at all.
9. Coverage can say something unchecked. The "not recorded here" path (`routes.ts:12577`) calls `answerFromCopy(null, {})`, and `coverage(m, false)` always says "the machine that ran it is asleep" without checking whether it is. With no origin given, `find()` picks the newest copy by tmux name across all origins, so a name collision can return another machine's session. That copy's own audience still applies.
10. Minor: `find()` loads every manifest on each read (`transcriptCheckpoints.ts:551-573`), so read cost grows with the whole store. The artifact cites "spec Left behind 19", which does not exist (Left behind has 12 items). The secrets are read from the startup `config` object (`server.ts`, `secrets:`), so a PIN changed at runtime through LiveConfig may be missing. The 3d route shares this, but here a copy cannot be recalled.

Held: the applier and the store each check the forging rule (`JournalSyncApplier.ts:584`, `ingest` `:473`). Each checkpoint and its `sourceThroughOffset` are written in one atomic write (`:344-349`), and every crash point in the source resumes at a row boundary. Assembly checks sha, length and contiguity, and stops at gaps. Both routes refuse any device principal, and no device rule lists either one. The switch is dark (`DARK_GATE_EXCLUSIONS`, `enabled: false`) and is wired only when replication is fully on rather than failure-only. A tick emits at most 90 chunks, under the burst of 100.

**Re-check:** concur. I read each fix in the code; I did not rerun tests.
1. `tick()` now saves `finalRequested` before the running guard (`transcriptCheckpoints.ts:346-351`), and `save()` keeps a flag another call recorded (`:302-305`). The read and write in the final loop are synchronous, so nothing interleaves.
2. The route reads `committedCopyFile(m)` (`routes.ts:12508`), which cuts the file to `throughOffset` before reading.
3. `withheldRows` is now in `coverage()` and in the sentence.
4. `boundConversations` fails closed with `conversationsOverflow`. The flag stays on the manifest once set, and the route refuses `unreadable` before the audience check (`routes.ts:12503`).
5. Partly fixed. Waiting chunks are capped at 600 per session. Total copy-store size still has no limit, retention or Disk Steward floor. That is open problem 1 and must be settled before the switch is flipped anywhere.
6. A row containing a `\u` escape now always goes through the parse path.
7. The validator and the source both bound conversations by UTF-8 bytes (8 KiB).
8. `wireTranscriptCopies` is the production path. The own timer also starts when the poller fails to construct (`AgentServer.ts:8945`).
9. The no-origin path now says the machine "was not asked". A tmux-name collision across machines can still return another machine's copy; that copy's own audience applies, and the builder accepts this.
10. `find()` uses an index now. Secrets are read at each pass, from both the config and the live config. My "Left behind 19" note was wrong: I read only through line 240 of the spec, and item 19 exists at line 247.

## Response to the second pass (builder)

1. Fixed. `tick()` saves `finalRequested` for every session it is told has ended before the running guard; `save()` keeps a flag another call recorded while a pass held the state. Test: "a session end seen while a pass is running is saved and cut by the next pass".
2. Fixed. The route reads `committedCopyFile(m)`, which cuts bytes past `throughOffset` before the read. Test: "a read sees only what the manifest committed".
3. Fixed. `copy.withheldRows` on every copy answer and the sentence names them; the over-block line is corrected.
4. Fixed, fail closed. A session whose conversations do not fit (more than 64, or over 8 KiB) gets `conversations: []` with `conversationsOverflow: true`; the manifest keeps the mark (sticky) and the route refuses with the `unreadable` sentence. Tests in unit and integration.
5. Fixed in part. Waiting chunks are capped at 600 per session with a plain `problem`; the missing checkpoint still closes the gap when it arrives (test). Finished outbox records are pruned after 14 days (test). Assembled-copy retention and the Disk Steward floor are not built; they are what §3f item 6 leaves to the 3f spec (Open problem 1).
6. Fixed. A row containing a JSON `\u` escape always goes through the parse path, so an escaped secret is redacted in decoded form (test).
7. Fixed. The conversations list is bounded by UTF-8 bytes (8 KiB) on the source and in the validator; the line-cap test now uses multi-byte keys.
8. Fixed. The server.ts block is now `wireTranscriptCopies` in `transcriptCheckpoints.ts`; server.ts only supplies the session list and the 3d lookups. The unit test and the e2e run that function (the e2e with the real journal and applier, tick then final). AgentServer starts its own 60 s timer also when the token-ledger poller fails to construct.
9. Fixed in part. On the "not recorded here" path the copy is marked `sourceAwake: null` and the sentence says "the machine that ran it was not asked". A tmux-name collision across machines can still return another machine's copy when no machine is given; the answer names its `machineId`, and that copy's own audience applies.
10. `find()` now uses an index by tmux name, built once and kept current by assembly. "Left behind 19" exists in the spec on this branch (line 247: keep the checkpoint store out of git sync, backups and support bundles). Secrets are read at each pass and include the live config's PIN and token.

## Evidence pointers

- `tests/unit/transcriptCheckpoints.test.ts`, `tests/unit/transcriptCopies-awareness-migration.test.ts`
- `tests/integration/transcript-copies-read.test.ts`
- `tests/e2e/transcript-copies-alive.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
