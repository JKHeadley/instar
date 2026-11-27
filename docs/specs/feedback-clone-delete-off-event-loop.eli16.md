# Feedback check clones are deleted in the background

## What this is about

The agent has a part that reads bug reports and tries to fix them by itself. To check a fix, it makes complete copies of the Instar code (a "before" copy and an "after" copy, each with all the libraries the code needs) and runs tests in them. When the check ends, the copies are thrown away.

A copy like that is several hundred thousand small files. Deleting it is real work for the disk.

## What was wrong

The server that runs the agent does one thing at a time. While it is busy with one job, everything else waits: incoming messages, the dashboard, the health check that tells the supervisor "I am alive".

The copies were deleted by the server itself, in one go, and it could do nothing else until the delete had finished. On a quiet disk that took 5 to 20 seconds each, several times a day. Nobody noticed, though every one of those was a stretch where the agent did not answer.

On 13 November 2026 a test run was writing heavily to the same disk when a check ended. The two deletes took 128 seconds and 59 seconds. The server did not answer for three minutes, its supervisor decided it was dead and restarted it. That threw away one test run in progress on the Studio and another on a second machine.

## What changes

Throwing a copy away already happened in two steps: first move it into a private "trash" folder (instant, it is one rename), then delete it. Only the second step is slow.

Now the first step still happens at once, so the place where the copy was is free straight away, exactly as before. The slow delete is handed to the operating system to do in the background while the server carries on answering. Copies are deleted one after another, never several at once, so the cleanup does not pile extra load on a busy disk.

If the server stops while a copy is still being deleted, the half-deleted copy is still in the trash folder. The agent already looked through that folder on every pass to clear leftovers; it still does, and now hands those to the same background queue instead of deleting them on the spot.

## What stays the same

- Which things get deleted, and when the decision to delete is made.
- The safety rule that only lets this code delete inside its own trash folder, and the written record of every delete.
- On Linux machines where the temporary folder is on a different disk from the trash folder, a small temporary folder is still deleted on the spot, because it cannot be moved. It holds a handful of files, not a copy of the code.

## What could go wrong, and why it is acceptable

- Disk space comes back a little later than before (seconds to minutes). Nothing in this part of the agent measures free space right after a delete.
- A delete that fails leaves the copy in the trash folder. It is tried again on the next pass, as leftovers already were.

## What you need to decide

Nothing. This removes one cause of the server being restarted in the middle of work; it changes nothing you can see.
