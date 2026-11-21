# Side effects: topic history import (POST /topic/import)

Spec: `docs/specs/topic-history-import.md` (converged, approved). Tier 2. The route writes history people see, adds a new row-origin value, and changes two existing readers.

## Summary and proportion

- Change: 1 new module (`src/memory/topicHistoryImport.ts`), 1 new route, edits to `TopicMemory` (merge, re-apply in `importAllLogs`, a rebuild lock, the corpus row predicate, `supersedeImportedRow`), `userCorpus.classifyRow`, a new `writeTelegramLogRow` helper in `topicRowWriter.ts` (used by the server's Telegram dual-write), `topicRowCarrier`, and a request-timeout entry. Tests: 28 unit, 7 integration, 2 E2E.
- Effort: 6 spec-converge rounds, the Tier-2 cap, with codex-cli plus an internal reviewer each round, plus the Standards-Conformance Gate. They found about 35 design issues, all fixed or recorded in the spec's Left behind as accepted residuals. That is in line with a Tier-2 change that writes durable history.
- Rehearsal on a copy of the Studio's real store and recovery file:
  - 13,860 rows accepted into 161 topics; 85 app messages and 1 fixture refused;
  - 12.5 s in total, and the largest single-topic event-loop hold was 4.5 s (topic 7848);
  - every watched topic's newest message was unchanged;
  - a second run accepted 0.

## What changes for running agents

- Nothing happens until someone calls `POST /topic/import`. With no `state/topic-history-imports/` folder, boot's `importAllLogs` gets an ENOENT and returns immediately, so it behaves as before.
- After an import, each affected topic's rows are renumbered (deleted and re-inserted in one transaction). `/topic/rebuild` already does the same to every topic.
- Two existing readers change:
  - `getUserCorpusRows` now admits origin-labelled rows only for `relay`/`a2a`, the only origins that existed before. The result is identical for every existing row.
  - `classifyRow` handles the new `imported` origin.
- `TopicRowWriter.writeRow` is unchanged. The live Telegram dual-write in `server.ts` now goes through `writeTelegramLogRow`. That calls `writeRow` and, on a keyed duplicate, `supersedeImportedRow`, whose update matches only rows with `origin = 'imported'`. Without an import it changes nothing.

## 1. Over-block

Refused rows:
- **App messages (`app:` ids):** the app conversation store keeps them. All 84 distinct ones were verified present on the Studio.
- **Rows without a Telegram topic.**
- **Non-numeric ids** (a test fixture).
- **Timestamps more than 5 minutes in the future.**
- **A `conversationKey` naming a different topic.**

Each refusal is counted and returned with a reason, so the caller can fix the row and send it again. There is no per-row text cap, because the live log has none.

## 2. Under-block

- **Forged rows:** a bearer-token caller can forge a row with a past timestamp and an unused id. The token already grants full write access, the row carries no authority, and the genuine message supersedes it when it arrives.
- **Delayed live copies (residual):** if every restored row of a topic later arrives live, a rebuild orders that topic by the live log instead of by time. Recorded in the spec's Left behind.

## 3. Level-of-abstraction fit

- The merge belongs in TopicMemory, the derived index the time-ordered readers query.
- Durability belongs in source batches beside the logs, which is how the index is rebuilt.
- The live log is not the right layer, because its tail readers treat the end as "now".
- The existing out-of-process backfill script inserts at the newest row ids and survives no rebuild, so it was not extended.

## 4. Signal vs authority (`docs/signal-vs-authority.md`)

- No gate, detector or blocking authority is added.
- Admission is a schema check against the store's own column types and key rule, so it is invariant and has no judgment in it.
- Every authority-relevant choice narrows authority, with one deliberate exception: a LOCAL live Telegram delivery of the same message replaces the restored copy, label and provenance included. That delivery is the authoritative source the restored copy stood in for, and a rebuild from the live log gives the same result. Otherwise:
  - restored rows are never `forwarded = false`;
  - restored rows are labelled `origin = imported`;
  - the user corpus gives them `recovered` (operator rows) or `third-party` (agent rows), with `authority: 'none'`;
  - standing authorization, the message-evidence authority and topic-creation provenance all require `forwarded === false`, so none of them count a restored row.

## 5. Interactions

- **Live dual-write:** better-sqlite3 is synchronous, so a write runs before or after a topic's transaction, never inside it. Imports and rebuilds share one promise-chain lock, so an import cannot land between a rebuild's delete and its replay.
- **User-corpus watermark:** it re-lists idempotently after a renumber.
- **Meaning-search sweep cursor:** it lives in memory and catches up. A renumbered topic is swept again from its new ids, which is one round of embedding work for that topic.
- **Context layers:** `countMessagesAfter` may honestly report a layer as behind, which is correct.
- **Summaries:** `needsSummaryUpdate` reads each imported topic as stale once, so there is one summary refresh per topic the next time it is summarized. Accepted.
- **Stub referents:** they skip restored agent messages.
- **Peer row carrier:** it never sends a restored row. An inbound carried copy goes through plain `writeRow`, which never relabels, so a carried row cannot strip the `imported` label or widen authority. Only the local Telegram delivery supersedes, because it is the source the restored copy stood in for. The receive path does accept a peer row labelled `imported`; that only narrows authority (spec Left behind).
- **Request timeout:** the route gets 300 s, because the default 30 s would answer 408 in the middle of a merge.
- **Event loop:** each topic's merge holds the event loop for the whole transaction, measured at up to 4.5 s on the largest real topic. The response reports `slowestTopicMs`. A Telegram send that needs the loop during that window can be held briefly, so the import should be run at a quiet moment.
- **Rebuild:** it still refuses to wipe live rows when its log is missing; a batch never licenses that. It also refuses on a damaged batch, and imports wait for it.

## 6. External surfaces

- **New endpoint:** a bearer-token caller can use it; a paired phone (owner, team or MSP) gets 403.
- **New state on disk:** `.instar/state/topic-history-imports/*.jsonl` (gitignored, never git-synced) (mode 0600, written to a temp name, fsynced, then renamed) and `.instar/logs/topic-history-imports.jsonl` (counts only).
- **New origin value:** `imported` appears in TopicMemory rows. An older build reading this database treats the value as unknown, and the rows still have `forwarded` unknown.
- **No outbound messages, notices or URLs.**

## 7. Multi-machine posture

- The live log and TopicMemory are already per machine. That existing gap is why the rebuild lost history; it is filed as fb-33f27f6a-03c.
- This route is the repair tool: any machine can take in rows its peers held.
- The key rule gives every machine identical keys.
- Restored rows are never carried to a peer, because each machine imports for itself.
- Batch files are machine-local, the same as the logs they sit beside.

## 8. Rollback cost

- **Revert the code:** the batch folder is no longer read, and the restored rows stay until the next `/topic/rebuild` drops them. Until then a reverted build reads their origin as unknown, while `forwarded` stays unknown.
- **Undo the data with no code change:** move `state/topic-history-imports/` aside and call `/topic/rebuild`.
- No migration is needed, and the live log is never touched.

## Second-pass review

High-risk surface: this writes history and changes an authority-labelling path. The spec-converge internal reviewers (six independent fresh-context rounds, read-only) reviewed the code, not only the spec.

**Phase 5 reviewer:** an independent second-pass subagent, fresh context and read-only. First pass: Concern raised. Putting the supersede inside `TopicRowWriter.writeRow` let an inbound peer-carried row strip the `imported` label and widen authority. Fixed by moving it to `writeTelegramLogRow`, which only the local Telegram dual-write calls, and a test pins both paths. Re-check: **Concur with the review.** Plain `writeRow` never relabels again, supersede also requires `body.origin === undefined`, and sections 4 and 5 now state the exception.


## Amendment 2026-11-21 (Local Verify fixes)

- Batches moved from `<stateDir>/topic-history-imports/` to `<stateDir>/state/topic-history-imports/`. The write-domain ratchet surfaced that the old folder was not gitignored in agent homes, so git-sync would have committed restored private conversation history. `state/` is gitignored. No data migration is needed: no import has run anywhere yet.
- `POST /topic/import` is classified machine-local in `buildWriteDomainRegistry` (per-machine path, not on a git-synced path), satisfying the §3.5 ratchet.
- Error reasons from the route now pass through `operatorError`, satisfying the local storage error response ratchet.
- Over-block / under-block / signal-vs-authority answers are unchanged: the move narrows where data lives and adds no decision point.
