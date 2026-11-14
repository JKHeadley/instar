# Messages sent while a topic moves machines: plain English overview

## What this change is

When several machines run the same agent, each conversation topic lives on one
of them. The machine that receives a message (the router) either handles it,
passes it to the machine that owns the topic, or, for a topic with no current
owner, picks a machine and asks it to start a session with the message.

That last step was broken in one common case. The router sent the message with
an ownership number of 0 and never read the answer. A machine that already knew
an older owner record for that topic saw "0", decided the message was out of
date, and refused it. The router logged "spawned" anyway and stopped. Nobody
held the message. On 1 November a message in the Echo Bugs hub sat unanswered
for 15 minutes this way, until the next message (sent the normal way, with the
right number) started a session.

## What already exists

Forwarding to an existing owner already sends the right number, reads the
answer, retries on network errors and re-places the topic if the owner is
gone. A durable inbound queue can hold a message until it can be delivered.

## What is new

The start-a-session hop now works like a forward. It sends the ownership number
the router just recorded, carries the sender's identity, and reads the answer.
Only an accepted answer counts as "spawned". If the other machine refuses or
never answers after the usual retries, the router takes the topic back for
itself and answers the message on its own machine. If it cannot take the topic
back, the message goes to the durable queue; if that is off, the message falls
through to the normal local handling. In every case some session gets it.

## Safeguards

The take-back only applies to the record this router just placed, still in the
"placing" state on the machine that refused. A sender refusal stays a refusal
and is never re-placed. A machine that answered is not marked suspect; one that
never answered is, as for forwards.

## What you need to decide

Nothing. A revert restores the old behaviour.
