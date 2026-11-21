# Message and conversation ids are only used as plain file names

<!-- bump: patch -->

## What Changed

SEC-127. The message store saves each message and each agent-to-agent conversation as a file named after its id. Ids come from other agents, so the store now uses an id as a file name only when it is a single plain name: no folder separators, not `.` or `..`, no NUL character, at most 229 bytes (the 255-byte file-name limit minus the longest suffix built from an id, `.log.jsonl.<pid>.rot.tmp`; wire ids are capped at 128). A message or conversation with any other id is refused with a clear error, and a lookup for it finds nothing. The same check guards the agent-to-agent conversation history files (ThreadLog), whose reads were already confined, and a local send with an unsafe conversation id is refused before anything is stored. Ordinary ids (UUIDs, `msg-…`, `thr-…`, relay ids) are unchanged.

## What to Tell Your User

- **Safer message storage**: "Messages from other agents can only ever be filed inside my message folder now, whatever their ids say."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Message and conversation ids checked before they become file names | Automatic |

## Evidence

- `tests/unit/message-store.test.ts`, new SEC-127 block (5 tests, all fail without the fix); `tests/unit/ThreadLog.test.ts` (2 new) and `tests/unit/message-router.test.ts` (1 new):
  - unsafe conversation ids are refused on save, find nothing on read, and move nothing on archive;
  - an unsafe message id is refused on save, and read, exists, dead-letter and delivery updates stay inside the store;
  - ordinary ids, including ones with dots and colons, still work.
