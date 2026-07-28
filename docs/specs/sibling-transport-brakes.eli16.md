# ELI16 — Brakes for the last two machine-to-machine channels

## The problem

Earlier tonight the "who's in charge" checker between Echo's two machines got
two brakes: a time limit on its network calls (so one stuck connection can't
silently break it forever) and bounded failure logging (so a down machine
produces ~49 log lines a day instead of ~17,000). But two sibling channels
shipped with the exact same missing brakes: the conversation-copier's wire
(which streams conversation updates to the standby machine) and the
"already answered" marker wire (which tells the standby "this message was
replied to — don't reply again after a takeover"). A hung connection could
hold either open forever, and a down or rejecting machine produced one log
line per attempt.

## The fix

The same two brakes, applied to both channels: every network call gets a
30-second time limit (sized above the 5–40 second freezes this fleet's
machines are known to have under load, so a slow-but-alive machine isn't
mislabeled as dead — the lesson the reviewer taught us on the first
transport), and failure logging becomes one line when a machine becomes
unreachable, a periodic reminder with the count, and one line on recovery.

One trade-off, checked deliberately: if the standby is VERY slow, a 30-second
cutoff might drop an "already answered" marker that a longer wait would have
delivered. That's acceptable by design — the marker system has two backup
layers (the message dedup gate and the synced ledger) exactly for lost
markers, and the reviewer traced that nothing depends on the send succeeding.

## What changes for you

Cleaner logs and two fewer ways for the two-machine setup to silently jam.
This completes the brake set: all four machine-to-machine wires (lease,
heartbeat, conversation-copier, reply-marker) now follow the loop standard.
