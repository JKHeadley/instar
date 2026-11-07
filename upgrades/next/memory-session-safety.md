<!-- bump: patch -->

## What Changed

On an agent with memory privacy on, a sandboxed session could trick the server, which is not sandboxed. It could report a made-up session id that became a launch flag at the next start, and on Linux it could plant a link so the server overwrote one of the owner's files. Both are closed. A session id must now be a plain id wherever it is stored or launched, a scoped session can report hook events only for itself and without file paths, and the server no longer writes through links in a session's folder. A sandboxed session's output also no longer reaches agent-wide digests through the session-completion path.

## What to Tell Your User

If your agent uses memory privacy, this update closes two ways a person's sandboxed session could have reached beyond its sandbox. There is nothing for you to do.

## Summary of New Capabilities

No new capabilities. `isSafeSessionRef` and `setAsideUnlessRealFolder` are the new checks.

## Evidence

Found by independent code review during team access work on 2026-11-06. The session id path was traced in code and `claude --resume --bogus-flag=1` was confirmed to parse the value as a flag; running code through it was not attempted. The link overwrite was confirmed with a local run. Each fix was removed in turn to confirm its test fails.
