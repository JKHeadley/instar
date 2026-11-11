# Chief of Staff needs a verified owner

## What happened

On Nov 10 at 5:51 PM Pacific, the agent Inspec switched on its Chief of Staff. That is a conversation that watches all the agent's projects and only listens to the agent's owner. Inspec had no owner id set. Over the next ten minutes the Chief of Staff turned away six messages from the operator, the one person the agent already knew and had verified. Each time, a separate standby notice said "actively working… your message has been delivered to the session". The message had not been delivered at all. Justin: "That should NOT be a possibility."

## Why

Two separate gaps. First, the Chief of Staff looked only at a configured owner id. Other owner checks in instar already accept "the one verified operator this agent has met" when no id is configured. The Chief of Staff did not. Second, the standby notice starts when a message arrives. It did not know the owner rule had thrown that message away.

## What this change does

1. The Chief of Staff's owner is now the verified owner: the configured id, or else the one verified operator. Inspec's case would have worked.
2. If the Chief of Staff is switched on and no verified owner exists at all, it stays off. It creates nothing and runs nothing, and it reports once that it is waiting for an owner.
3. When the owner rule turns a message away, the sender gets a plain "This message was not delivered" with the reason. The standby notice uses the same rule, so it stays silent for that message.

## What already existed

The owner-only rule, the "one verified operator" check used by approval buttons, the standby notice and the problem reporter all existed. This change connects them; it adds no new setting or route.

## Safeguards

Strangers and unverified senders are still refused. A configured owner id always wins over the inferred operator. If two different people were ever verified, there is no inferred owner, and the feature stays off rather than guess. An existing Chief of Staff conversation is never deleted or unpinned while it waits for an owner.

## What you need to decide

Nothing. A revert undoes it fully.

A small follow-up moved one setting in the wiring so an existing test that checks the standby helper still passes. It does not change what anyone sees.
