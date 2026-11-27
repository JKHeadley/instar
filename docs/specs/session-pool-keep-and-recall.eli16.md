# A live conversation stays put, and a moved one gets its recent messages: in plain words

**The first problem.** When sharing across machines is first switched on, the conversations already running aren't
recorded as belonging to any machine. The next message could get sent to a different, less busy machine, which would
start a second copy of the conversation while the real one is still going.

**The first fix.** If a conversation is already running on this machine and nobody has asked for it to be elsewhere,
it stays here. If someone did ask, by pinning it to another machine, that request still wins. It also moves if this
machine can no longer do the job, for example if it lost its Slack connection or ran out of quota.

**The second problem.** When a conversation really does move, the new machine has to ask the machine in charge for
the recent messages. It asks using a password that machines set up by pairing don't share. The request gets refused,
nobody hears about it, and the conversation carries on with no memory of what was said.

**The second fix.** The new machine now asks using its signed machine identity, which every paired machine has. If
the other machine is on an older version, it falls back to the old way. If both fail, the conversation still starts,
and the log now records that it started without its history. This brings back the last 50 messages at most, not
the whole conversation.

**What this does not do.** It doesn't turn sharing on for anyone. It's preparation, and one-machine agents never
reach this code.
