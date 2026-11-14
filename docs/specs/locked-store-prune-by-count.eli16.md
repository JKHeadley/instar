# Locked-Mac remote desktop: keep the unlock record small — ELI16

## What this is

When someone opens remote desktop to a locked Mac, the Mac's small helper program writes a "duty" record: a note saying "I typed the password, so I owe a relock when this session ends." Each record is about half a kilobyte. The server reads the whole file of records every time it checks whether the Mac is locked.

## What went wrong

The helper only threw finished records away once they were a week old. The server refuses to read a helper reply bigger than 64,000 bytes. A Mac that unlocked about 126 times inside one week (easy on a test rig, possible on a busy real Mac, about 18 a day) crossed that size. From then on the server could not tell whether the Mac was locked, so remote desktop to that Mac stopped working for up to a week, with only a technical error code to explain why. Nothing unsafe happened: the Mac still relocked every time. It was an availability bug, found live on the test Mac on 6 November.

## What changes

The helper now keeps only the newest 30 finished records, as well as dropping anything older than a week. Records that still matter are never dropped: a duty still owed, and a failed relock nobody has been told about yet, always stay. On disk the trim happens the next time a duty is created, exactly where the old weekly clean-up already ran. A Mac whose file is already too big is fixed straight away, because the helper also applies the same trim to what it hands the server when the server reads, without writing anything during that read.

## Safeguards

- The server only ever looks at open duties, failed relocks, and the current duty, so dropping old finished ones takes away nothing it uses.
- The 64,000-byte limit on the server side is unchanged. It still protects the server from a runaway reply.
- A new test builds a file of 200 finished records plus one owed duty and one unreported failure. It checks that the read comes back small with exactly the newest 30, that the read changes nothing on disk, and that the next new duty prunes the file down to 30.

## What the reader needs to decide

Nothing. This is a small fix that a revert would fully undo. One cost to know about: changing the helper's code changes its fingerprint. As with every helper change, a Mac keeps using its already-approved copy until the new copy gets its own macOS permission.
