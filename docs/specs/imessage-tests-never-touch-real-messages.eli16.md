# iMessage tests never touch the real Messages database — Plain-English Overview

> The one-line version: when the test runner builds the iMessage adapter without telling it which database to use, the adapter must reach for a stand-in folder inside the test's own scratch directory, never the machine's real `~/Library/Messages` folder, because touching that folder on an unattended Mac can freeze the test process forever.

## The problem in one breath

Since about 12:46 PM on 2026-11-20, every pull-request test run on the Studio machine hung at the very end of its unit tests and was cut off at the 40-minute limit, while the M5 machine ran the same pull requests fine. The frozen test workers were stuck inside a single operating-system call: creating a hard link (a second name for the same file on disk) whose source was the Studio owner's **real iMessage history database**, `~/Library/Messages/chat.db`. macOS treats that folder as private. On the Studio it now answers a program that reaches in by waiting for a human to click "Allow Full Disk Access" — and on a machine where nobody is at the screen, that wait never ends. The kernel log confirmed it: a line reading `watchdog expired for approval entry … (kTCCServiceSystemPolicyAllFiles, pid <test worker>)` repeated every five seconds for each stuck worker.

## What already exists

- **The iMessage adapter** — the piece of instar that reads a Mac's iMessage history so the agent can answer texts. It reads the history through a hard link it creates inside the agent's own state folder, so the agent's server process does not itself need Full Disk Access.
- **The hard-link helper** (`ensureChatDbHardlink`) — the function that creates that link at adapter start-up. Until now it always used the real home folder's `~/Library/Messages` as the source, with no way for a caller to point it anywhere else.
- **Tests that build the adapter** — about 37 constructions in the unit suite, plus integration and end-to-end suites. Most build the adapter without naming a database, which sent them straight at the real one. On most machines this failed fast with "operation not permitted" and the adapter quietly fell back, which is why nobody noticed; on the Studio it started hanging instead.
- **Local Verify** — the two-machine test line that runs every pull request's full suite before merge, with a 40-minute deadline per lane. It reported the hang faithfully but could only name the files that happened to be listed as "running" in its throttled progress file, which pointed at the wrong tests.

## What this adds

The hard-link helper now takes the Messages folder as a parameter, and its default depends on whether the test runner is active. In production (the `VITEST` environment variable is absent) the default is unchanged: the real `~/Library/Messages`. Under the test runner the default becomes a folder inside the test's own state directory that is never created — so the helper sees "no chat.db here", returns its normal fallback path, and never issues a single file-system call against the real Messages folder.

- A test that genuinely wants to exercise the linking code passes a fake Messages folder explicitly; the production code path is then covered with a fake, not with the operator's private data.
- Four new unit tests pin this down: the test-runner default lives inside the state directory and is never created; an adapter built with no database path produces no `chat.db*` links; an explicit fake folder is linked correctly (same inode, WAL linked, missing SHM skipped); and a folder with no `chat.db` returns the fallback path.

## The new pieces

- **`defaultMessagesDir(stateDir)`** — a one-line decision: real Messages folder in production, a never-created stand-in under `stateDir` when `VITEST` is set. It is not allowed to do anything else; in particular it does not create directories or touch files.
- **`ensureChatDbHardlink(stateDir, messagesDir = defaultMessagesDir(stateDir))`** — the existing helper, now parameterised. Behaviour for every existing production caller is byte-for-byte the same, because no production caller passes the new argument and the production default is the old hard-coded value.

## The safeguards

**Prevents the test suite from touching private user data.** Nothing under test can reach `~/Library/Messages` through this adapter any more, on any machine, regardless of that machine's privacy settings.

**Prevents a privacy prompt from freezing a test run.** The specific syscall that parked forever is simply never made under test, so the Studio's 40-minute deadline cut-offs stop at the source rather than being papered over with a longer timeout.

**Changes nothing in production.** The production default and the production call site are unchanged. A revert of this change fully restores the previous behaviour; there is no persisted state, migration, or config involved.

## What ships when

One pull request, one patch release. Once it is merged, the Studio's Local Verify runs finish normally again; until then the M5 continues to verify pull requests on its own.

## What you actually need to decide

Nothing — this is a Tier-1 reversible fix with no production behaviour change; the agent approves and merges it on green. The only question a reader might weigh is whether a broader structural guard (making *any* test-time reach into a macOS privacy-protected folder fail fast instead of hang) should follow; that is noted as a separate improvement, not a blocker for this fix.
