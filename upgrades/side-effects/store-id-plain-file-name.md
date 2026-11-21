# Side effects: the message store only uses plain names as file names (SEC-127)

In plain words: message and conversation ids come from other agents and become file names in the message store. The store now uses an id as a file name only when it is one plain name, so no id can reach a file outside the store.

Tier 1. Size: 4 source files (one new 20-line helper), 8 new unit cases.

## What changes for running agents
- `isSafeFileId(id)` in the new `src/core/safeFileId.ts` (also exposed as `MessageStore.isSafeFileId`): a string of 1 to 229 UTF-8 bytes, not `.` or `..`, with no `/`, `\` or NUL. 229 = the 255-byte file-name limit minus the longest suffix built from an id (ThreadLog rotation `.log.jsonl.<pid>.rot.tmp`, 26 bytes with a 7-digit pid). Wire message ids are capped at 128 (`MESSAGE_ID_MAX`), so no real id is refused.
- Message ids (`store/`, and the dead-letter copy): `save` throws on an unsafe id; `get` returns null; `exists` returns false; `updateDelivery` and `updateEnvelope` throw "Message not found" as they already do for a missing message; `markManyUndelivered` and `deadLetter` skip it.
- Conversation ids (`threads/`, `threads/archive/`): `saveThread` throws on an unsafe id; `getThread` returns null; `archiveThread` does nothing.
- ThreadLog (`threadline/threads/`): every path it builds from a thread id (log, meta, archive segments, delete) now goes through the same check and throws on an unsafe id. Reads were already gated by `isPathConfined`; this closes the write side. `ThreadMessageRecorder.record` already turns a throw into an observable `append-failed`.
- `MessageRouter.send` checks a caller-given `threadId` before saving, so a refused send stores nothing (before, the message could be saved as sent and never routed).
- ThreadLog is a producer of the `threadline-inbound-canonical-store` migration contract, so its revision moves 4 → 5 in `docs/canonical-migration-contracts.json` and in every producer, consumer and validator annotation (comment-only edits in those files).
- Every other id behaves exactly as before; nothing on disk is migrated, moved or deleted.

## Who sees a refusal
- A relayed message with an unsafe id is refused at `save`, before any file is written; the relay caller gets the error, as for any failed store write.
- A relayed message with an unsafe thread id: the relay path already catches the aggregate failure ("updateThread (relay) failed") and the canonical-history append reports `append-failed`; no file is written outside the store.
- A local send with an unsafe `threadId` is refused before anything is stored.
- Not in this PR: the pipe-session spawner's prompt file name is covered by SEC-126 (#3576), which gates the spawn entry with `THREAD_ID_RE`.

## Signal vs authority
Input validation at the storage boundary. It grants nothing and blocks only ids that could never name a file inside the store.

## Rollback
Revert the commit. No state change to undo.

## Tests
- `tests/unit/message-store.test.ts` (51 pass, 5 new; all 5 fail on main): unsafe thread ids on save, read and archive; unsafe message ids on save, read, exists, dead-letter and delivery update; ordinary ids including dots, colons, a 229-byte id and a 128-character wire id.
- `tests/unit/message-router.test.ts`: a send with an unsafe thread id is refused and stores nothing; a plain one still works.
- `tests/unit/ThreadLog.test.ts` (2 new; the refusal case fails on main): append refuses unsafe ids and writes nothing outside; an ordinary id still appends and reads back.
- Also run, all pass: `message-router-cross-machine`, `ThreadlineRouter-relay`, `recordThreadMessage`, `threadSymmetry`, `threadline/ThreadlineReplyValidation`, `threadline/relayIngressHistory`, `no-silent-fallbacks`, `a2a-local-route-signed-envelope`, `session-summary-sentinel`.

## Follow-ups (not in this PR)
Tracked as commitment CMT-021 on the M5 (m_a804869356): its own tier-1 PR opened by 2026-11-24 17:00 PST, with a beacon in the security topic.
- Relay routes answer 500 for a refused id; a 400 would tell the sender not to retry.
- Windows reserved device names (`NUL`, `CON`, …) and `:` alternate streams are not refused; they stay inside the folder.
- Repeated relays with refused thread ids count as canonical-history append failures and can raise the recorder's HIGH "check disk/permissions" attention item; refusing them at the relay route (with the 400) or giving them their own non-alerting outcome fixes it. Integration and e2e tests were not run on the M5, per the machine rule.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, given only the diff and the problem statement), 2026-11-21. First pass: do not concur. The blocking finding was that ThreadLog built log, meta and archive paths from the raw peer thread id, so the write side was still reachable through the relay route. Fixed here by routing every ThreadLog path through the shared check. Second pass: concur. It confirmed that reads return empty rather than throwing, that the only callers of append and deleteThread catch, that #3576 covers the pipe-spawner prompt file, and that no other path built from an id is reachable. Its non-blocking notes: the cap was too high for ThreadLog's longest suffix (fixed: 229 bytes), and the three items under Follow-ups (CMT-021).
