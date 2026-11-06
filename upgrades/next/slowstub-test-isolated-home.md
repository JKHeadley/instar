<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The tmux slow-stub integration test now gives its server an empty home folder, so the server's token-usage scan no longer reads the host machine's real Claude transcripts during the timed checks. Test-only; no runtime change. The time limits are unchanged.

## Evidence

On the Studio (about 700 MB and 1,400 recent transcripts under `~/.claude/projects`), the unchanged file failed 3 of 3 runs on main 79d83ec93 and 3 of 3 on PR #2825's head, always the 1-second check ("expected 1559 to be less than 1000", 1577, 1611, 1768, 2028, 2474). A CPU profile of the test worker showed about 6 s in `TokenLedger.ingestFile`/`ingestLine`, and `/health` took 1.4 to 2.7 s per call. With the empty home: 5 of 5 passes, and 3 of 3 passes with 12 extra busy loops added.
