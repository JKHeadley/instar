# Side-Effects Review — storage refusals name the machine

**Version / slug:** `storage-refusals-named`
**Date:** `2026-11-07`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1: wording plus an optional name dep. 7 files, about 70 lines. One review round.

Justin's app showed "This machine is nearly out of disk space, so the file was not stored." under a message. His words: "Errors like this should specify what machine it's referring to." It was the Mac Studio. Every storage refusal in the app-media layer now names its machine. That layer handles app and Slack attachments, phone uploads, files copied between machines, and reply files.
- `AppMediaStore` takes an optional `machineName` and gains `machineWords()`, which falls back to the tidied host name and never to "this machine". Three refusal details change:
  - disk floor: "Mac Studio is nearly out of disk space, so the file wasn't stored."
  - store full: "The file store on Mac Studio is full. …"
  - upload staging: "Mac Studio has too many uploads in progress. …"
- `AppMediaReplicator`'s copy refusal names the machine.
- `AppConversationService`:
  - passes the name through;
  - the disk-floor notice title used the raw machine id ("m_03b3… is too low on disk") and now uses the name. The notice key still uses the id, so de-duplication is unchanged;
  - the store-full notice title and the disk-floor notice body name the machine;
  - a test-only `mediaDiskSpace` seam lets the store-cap test stop reading the real disk. That test failed on the Studio today because the Studio is at 95% (below the 5% floor), which is the very condition Justin hit.
- `commands/server.ts` and `AgentServer.ts` pass the verified registry name.

The app shows the server's words. Its own fallback for older servers ("The agent has no room for this file right now") names no machine because it knows none.

## Decision-point inventory

No decision changes. The same conditions refuse with the same codes and statuses; only the words change.

## 1. Over-block
No block/allow surface change — not applicable.

## 2. Under-block
No block/allow surface change — not applicable.

## 3. Level-of-abstraction fit
The words are composed where the refusal is decided (the media store), so every caller (phone upload, Slack attachment, replication, reply files) gets the same named sentence.

## 4. Signal vs authority compliance
No authority added or changed.

## 4b. Judgment-point check
None.

## 5. Interactions
Error codes and HTTP statuses are unchanged, so clients branching on `error` behave the same. The notice de-duplication key is unchanged.

## 6. External surfaces
The `detail` text of 507 refusals and the titles of two attention notices change. A machine name is not a secret: it is the verified registry nickname the phone already shows.

## 6b. Operator-surface quality
No dashboard file touched — not applicable.

## 7. Multi-machine posture
Machine-local BY DESIGN: each machine refuses for its own disk. That is exactly why the words must name the machine; the person reading them on a phone cannot otherwise tell which machine is full.

## 8. Rollback cost
Pure code change. Revert and ship a patch. No state.

## Conclusion
Clear to ship. The review also found and fixed the id-in-title bug and the real-disk dependence of one test.
