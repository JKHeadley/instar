## What Changed

An open session in the console has a History view next to Live: the session's own conversation record, loaded newest first and older on scroll-up, back to the start. Full-screen sessions keep no terminal scrollback, so the terminal alone could only show one screen.

## What to Tell Your User

In the dashboard, open a session and tap History to scroll back through the whole conversation.

## Summary of New Capabilities

- `GET /sessions/:name/transcript?before=&limit=` returns a page of a session's conversation record; add `machineId` for a session on another machine.

## Evidence

tmux reported `alternate_on=1`, `history_size=0` for live sessions on 2026-11-01. The reader pages a real 30 MB transcript in 53 ms total; unit tests cover both transcript shapes and paging without gaps.
