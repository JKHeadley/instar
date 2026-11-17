# The disk forecast no longer counts one cleanup again at every restart

<!-- bump: patch -->

## What Changed

The disk check forecasts how fast a machine's disk is filling. It leaves out space it freed itself, so a cleanup doesn't look like the disk getting emptier on its own. But the record of a finished cleanup stays on disk, and every server restart read that record and counted the same cleanup again. On the Mac Mini on 2026-11-16, one 9.2 GB cleanup was counted five times (46 GB). The disk was really losing about 10 GB a day, but the forecast read 41 GB a day and "about two days until full". Each cleanup now counts once, however many times the server restarts.

## What to Tell Your User

- **Disk warnings**: "My forecast of how fast a machine's disk is filling could overstate it after the machine restarted a few times. That's fixed, so the 'days until full' I report is real."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Each cleanup counted once in the disk forecast | Automatic |

## Evidence

- Mac Mini, 2026-11-16, from its disk check's own history: the cleanup run 24911832381ddf70973b9c52 freed 9.2 GB at 21:29Z. Its recovery was then recorded on the samples at 21:26, 22:11, 22:47, 23:24 and 00:30Z (46 GB in all). The raw 24-hour slope is −10.4 GB/day; the reported one was −41.1 GB/day; the 7-day slope is about flat.
- Unit: `tests/unit/diskSteward.test.ts`. Five more boots collecting the same run add nothing, while a different run still counts. A state written before this fix still refuses its last run a second time.
