# Remote desktop: each session logs where its pictures went

## What Changed

When a remote desktop stream closes, the machine being viewed logs one line of counts for that session: how many times it tried to grab the screen, how many grabs were unchanged, sent, dropped (and why: bandwidth allowance, a full send buffer, or an out-of-range size), how many grabs failed, how long a grab took on average and at most, pictures sent per second and the bit rate. Counts only; no screen content, grant or operator.

## What to Tell Your User

Nothing visible changes. This lets the agent find where a choppy remote desktop picture is losing frames.

## Summary of New Capabilities

Per-session picture counts in the server log (`[DesktopStream] frames:`).

## Evidence

tests/unit/desktop-stream-frame-stats.test.ts (summary arithmetic; one close line with sent and unchanged counts that add up to the grabs, and no grant id in it). Existing DesktopStreamManager tests pass.
