# Slack Inbound Recovery Robustness — ELI16

Imagine Slack gives every channel a mailbox number. A conversation thread has
the same mailbox number plus a note telling you which folder inside the mailbox
to use.

Instar saved that combined address so it could reopen the right conversation.
But after a restart it accidentally handed the whole combined address to
Slack's mailbox-history API. Slack only accepts the mailbox number, so it
answered “channel not found” and the recovery check missed the message.

There was a second issue: when Slack went quiet, Instar sent a made-up JSON
“ping.” The computer could report that it successfully wrote those bytes even
if Slack was no longer delivering anything back. That was like dropping a note
into a jammed mail slot and assuming the mail carrier was working.

The fix separates the mailbox number from the thread note before asking for
history. It also replaces the fake ping with a fresh Socket Mode connection
after five silent minutes. Instar records when the blind period began, so the
fresh connection checks history and recovers the newest authorized user message
that may have arrived meanwhile.
