# Messages That Find Their Owner — Plain-English Overview

## Where this fits

The big queue that merged earlier today gave conversations a safe waiting room:
messages that can't be delivered right now sit safely on disk instead of getting
lost or delivered to the wrong machine. It even shipped the "receiving dock" — a
machine can accept a forwarded message with proof of ownership and a durable
receipt. This change adds the three guards that complete the delivery story.

## The three guards

**1. No more accidental twins.** Between "this message should spawn a session here"
and the session actually spawning, ownership of the conversation can move to
another machine. Before: the spawn happened anyway — two machines, two sessions,
same conversation. Now the spawn re-checks ownership at the last moment and sends
the message back to the waiting room if the answer changed.

**2. Machines now advertise what they can safely receive.** Each machine's
heartbeat carries a tiny capability note: "I can durably receive forwarded
messages." A machine that can't (older version, or its queue is switched off)
simply doesn't advertise — and that absence is itself the safety signal.

**3. Never rob a healthy machine.** Without guard 2, forwarding a message to a
machine that can't receive it would fail repeatedly — and the failure handler
would conclude the machine was dead and TAKE the conversation from it. A perfectly
healthy machine, robbed because it hadn't upgraded yet. Now the sender checks the
advertisement first: can't receive → the message waits safely in the queue, and
delivery resumes the moment the machine upgrades (its next heartbeat says so).

## Phase C note

The capability note is the same fixed size whether the pool has 2 machines or 200
cloud VMs; the checks are instant local reads; nothing assumes machines share a
network or have a human at the keyboard.

## What changes for you

Nothing visible — all of this lives inside the multi-machine layer, which still
ships dark. When the layer lights up, conversations move between machines without
twins, theft, or losses — which is the whole point of the seamless experience.
