# iMessage tests never touch the real Messages database

<!-- bump: patch -->

## What Changed

The iMessage adapter creates a hard link to the Mac's `~/Library/Messages/chat.db` inside the agent's state folder at start-up, so the agent's server can read iMessage history without itself holding Full Disk Access. Until now the source of that link was hard-coded to the real home folder, so every test that built the adapter without an explicit `dbPath` reached for the operator's real Messages database. On a Mac whose privacy (TCC) state answers that reach with a pending "Allow Full Disk Access" approval instead of a fast refusal, the `link()` system call parks in the kernel until someone clicks — and on an unattended machine nobody does. That is what froze the Studio's Local Verify unit lane at exit from ~12:46 PST on 2026-11-20 (every PR verify cut off at the 40-minute deadline) while the M5 ran the same PRs fine.

- `IMessageAdapter.ensureChatDbHardlink(stateDir, messagesDir?)` now takes the Messages directory as a parameter. Its default, `IMessageAdapter.defaultMessagesDir(stateDir)`, is the real `~/Library/Messages` in production (the `VITEST` environment variable absent) and a never-created stand-in directory inside `stateDir` under the test runner.
- Under test the helper therefore sees "no chat.db here", returns its existing fallback path, and issues no filesystem call against the real Messages folder. A test that wants to exercise the linking code passes a fake Messages directory explicitly.
- Production behaviour is byte-identical: no production caller passes the new argument and the production default is the previous hard-coded value.

## What to Tell Your User

- **Test runs on an unattended Mac no longer freeze on a privacy prompt**: "My own test suite was reaching into the real iMessage database on this Mac, and macOS was silently waiting for someone to approve Full Disk Access — forever, since nobody was at the screen. Tests now use a stand-in and never touch your real messages. Nothing changes in how I read your iMessages when actually running."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Tests never read the operator's real Messages database | Automatic under the test runner; no configuration |
| Exercise the chat.db linking code against a fake | `IMessageAdapter.ensureChatDbHardlink(stateDir, fakeMessagesDir)` in a test |

## Evidence

- Root cause observed live on the Studio: `sample` of the stuck vitest workers showed the main thread inside `node::fs::Link → link()`; `lldb -p` on two of them read the link source register as `~/Library/Messages/chat.db`; the kernel log repeated `(Sandbox) watchdog expired for approval entry N (kTCCServiceSystemPolicyAllFiles, pid <worker>)` every 5 s for exactly those workers; the lane's progress file said all 3,925 unit files had finished while the process could not exit.
- Before/after: a tracer counting filesystem calls whose path is under the real `~/Library/Messages` while constructing an adapter with no `dbPath` — old code under the test runner: 3 link attempts + 4 existence checks; new code under the test runner: 0 + 0; new code in production (no `VITEST`): 3 + 4, identical to before.
- Unit: `tests/unit/imessage-adapter.test.ts` gains four tests (test-runner default lives under `stateDir` and is never created; an adapter built without `dbPath` produces no `chat.db*` links; an explicit fake Messages dir links correctly — same inode, WAL linked, absent SHM skipped; a dir with no `chat.db` returns the fallback). 43/43 in that file; 53/53 with `identity-piece1eb-imessage-sms` and `imessage-connected-at`.
- Integration: `imessage-outbound-safety` (56), `imessage-review-blockers` (26), `imessage-routes` (17) pass. E2E: `imessage-adapter-e2e` 14/14. `tsc --noEmit` and eslint clean.
