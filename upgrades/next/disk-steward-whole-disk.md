# Disk warnings say who is using the space across the whole machine

<!-- bump: patch -->

## What Changed

Once a day the Disk Steward's cleanup child also measures the top level of the home folder and groups it by owner: an Instar agent (from the machine's agent registry) or a top-level folder such as `~/Projects`. On macOS it never opens Documents, Desktop, Downloads, Library, Pictures, Movies, Music or the trash; their bytes are reported as not opened. Each folder gets at most a quarter of the remaining time; a folder it cannot finish is reported as "at least" and named. The result is `wholeDisk` on `GET /disk-steward` and one line in disk posts. Spec: `docs/specs/disk-steward.md` §3.7a.

## What to Tell Your User

Disk space warnings now say who is using the space on the whole machine, such as another agent or a backup folder, not only folders inside this agent. Private folders like Documents and Photos are never opened.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Whole-disk usage by owner in disk warnings and the disk status | Automatic, once a day; read `wholeDisk` on `GET /disk-steward` |

## Evidence

Laptop, 2026-11-11: the post named about 25 GiB of 746 GiB used. Studio live run, 2026-11-12: 254 of 813 GiB attributed in 524 s, with the largest folder named as unfinished. 15 new unit cases in `tests/unit/diskSteward-wholeDisk.test.ts`; route test asserts the field.
