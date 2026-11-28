<!-- bump: patch -->
## What Changed

The history-acquisition worker can accept a receipt for an export the Mac app captured itself, read the file safely from the app's private folder, and check its exact size and checksum before staging it for preview. The receiver is off: nothing in a normal install turns it on, and there is no new web address.

## What to Tell Your User

Nothing changes yet. Bringing over Claude or ChatGPT history still uses the existing file option until the automatic route passes its live checks.

## Summary of New Capabilities

An internal, dark receiver for Mac-captured history exports: one capture per job, receipts that survive restarts and cannot be replaced by a conflicting one, signed same-Mac admission, and a no-follow file read. The owner's preview and confirmation are still required before anything is copied.

## Evidence

25 focused tests (receiver, signed admission boundary, archive staging) passed after rebasing onto the cancel-cleanup fix; TypeScript passed. No live provider or two-process signed capture is claimed.
