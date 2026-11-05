# Opening a Slack file from another machine

Your phone talks to one machine, but a Slack conversation can live on a different one. A recent change lets the phone read that conversation's messages. Files still failed, because the file sits on the other machine's disk.

This change lets the machine your phone talks to fetch the file from the machine that holds it and pass it along. Only your own phone can do this, and the machine is chosen from the agent's trusted list, never from anything in the request. The holder checks that this exact file belongs to this exact conversation before it sends a byte, so knowing a file's hash gets nobody anything.

The file passes straight through rather than being stored in the middle, with a size limit and time limits. The owner check is repeated before connecting, before the first byte, before every piece sent and on a timer throughout. Those repeats happen on the machine your phone talks to. The holder checks once at the start, and what it trusts is the agent's own machine credential, which proves a trusted machine, not your phone. So this does not protect you if the machine your phone talks to is itself taken over. If your phone is removed partway, the transfer is cut. The last piece is held back until the whole file's fingerprint matches, so a damaged or incomplete file can never look finished. The phone checks that fingerprint again and keeps nothing if it fails.

If a phone stops taking a file for a minute, for example because it locked, the download moves to one of a few waiting places so other files can start. It keeps running until the overall five-minute limit, because a server cannot tell a very slow phone from a sleeping one. At most 8 of these downloads are open at a time, 3 per machine; past that the phone is told to wait. The machine that holds the file also keeps that connection open longer than usual after sending the last piece, so a slow phone still gets the end of the file. A file that needs more than five minutes does not finish: the phone tries from the start up to three times, then asks you to tap to retry.

If the holder is missing the file, asking for it can start the usual background copy from another machine, under the existing storage and cleanup limits.

Each copy on the phone is stored separately per agent, machine and conversation, so a file allowed in one place is not treated as allowed in another.

Limits: a file comes whole, so a cut transfer restarts from the beginning. Sending and uploading are not included. Both machines need this version. There is nothing to decide.
