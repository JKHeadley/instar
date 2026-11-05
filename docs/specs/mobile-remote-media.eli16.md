# Opening a Slack file from another machine

Your phone talks to one machine, but a Slack conversation can live on a different one. A recent change lets the phone read that conversation's messages. Files still failed, because the file sits on the other machine's disk.

This change lets the machine your phone talks to fetch the file from the machine that holds it and pass it along. Only your own phone can do this, and the machine is chosen from the agent's trusted list, never from anything in the request. The holder checks that this exact file belongs to this exact conversation before it sends a byte, so knowing a file's hash gets nobody anything.

The file passes straight through rather than being stored in the middle, with a size limit and time limits. The owner check is repeated before connecting, before the first byte and throughout. If your phone is removed partway, the transfer is cut. The last piece is held back until the whole file's fingerprint matches, so a damaged or incomplete file can never look finished. The phone checks that fingerprint again and keeps nothing if it fails.

Each copy on the phone is stored separately per agent, machine and conversation, so a file allowed in one place is not treated as allowed in another.

Limits: a file comes whole, so a cut transfer restarts from the beginning. Sending and uploading are not included. Both machines need this version. There is nothing to decide.
