# Feedback drain no longer mistakes a Mac reboot for a restored backup — Plain-English Overview

> The one-line version: the feedback drain on the Mac Studio stopped processing reports because a reboot changed a number it used to recognise its own database file; it now ignores that number, so a reboot no longer looks like a backup restore.

## The problem in one breath

The feedback drain keeps its work in a small database file. When it saves a checkpoint, it also writes down a "fingerprint" of that file, so that it can later tell the difference between "the same file after a normal restart" and "a copy put back from a backup". A restored backup needs an operator to confirm it before work continues. The fingerprint had three parts: the disk number, the file number, and the moment the file was created. On macOS the disk number is not fixed: it can change after a reboot even though nothing touched the file. That is what happened on the Mac Studio. The file number and creation time were identical, only the disk number moved from 16777231 to 16777232. The drain concluded "this is a restored backup", refused to do any work, and 274 feedback reports piled up waiting for an operator step that should never have been needed.

## What this changes

The fingerprint is now just the file number and the creation time. Those two are enough to spot a genuinely replaced file: a file copied back from a backup is a new file, with a new file number and a new creation time. Checkpoints already written in the old three-part form still work: when comparing, the old disk number is simply skipped. So the stuck Mac Studio drain unsticks itself on the next check after the update, without anyone pressing the operator button.

## The safeguards

- A really restored file is still caught. Tests replace the database with a copied snapshot and confirm the drain still says "restored", with both the new and the old fingerprint format.
- The other two restore checks are unchanged: the file contents must match the checkpoint's checksum, and the ownership counter must match. A mismatch is still refused loudly.
- Nothing else changes: no new settings, no new routes, and no change for any other part of the agent.

## Rollback

A normal release revert. Checkpoints written by the new version use the two-part form; an older version would read them as "different" and ask for the operator step again, which is exactly the behaviour it has today.
