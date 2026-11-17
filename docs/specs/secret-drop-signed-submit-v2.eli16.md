# Signed secret hand-offs use an unambiguous format — plain-English overview

## What this is

When one of your agents hands a secret to another, the sender signs it so the receiver knows it really came from that agent and wasn't changed on the way. The way the values were written down before signing could, in rare cases, read the same for two different sets of values. A signature for one could then be accepted for the other.

## What changes

The sender now writes the values down in a format where that can't happen, and marks which format it used. Older senders keep working for ordinary one-line secrets. For a secret that spans several lines, such as a key file, an older sender is asked to update first.

## What you would notice

Nothing for normal secrets. A multi-line secret from a machine running an older Instar gets a clear "update and send again" message, and the link still works afterwards.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
