# Sending a message to another machine: what was broken and what changed

## The short version

An agent that runs on several computers can pass a message from one of its computers to another with its own "send a message" call. That call had two problems, and this change fixes them.

First, it never actually reached the other computer. The sending side knocked on the wrong door: it posted to an address the receiving computer does not serve, got "not found" back every time, and quietly parked the message in a local folder marked "machine unreachable". That is one reason why, during the November 20 outage, every hand-off between machines had to be done by posting directly into the other computer's own server instead. The fix points the sender at the address the receiver really serves. Both sides already check each other's machine keys on that address, so nothing about who is trusted changes.

Second, when the sending computer did not know the target computer at all (it happens when the machines' lists of each other disagree, as they did after the Mac Studio was rebuilt), the call gave up at once, answered "201 created" as if all was well, and told nobody.

## What happens now

- **The target is one of my paired machines:** the message goes to that machine and the answer says it was accepted there.
- **The target was removed from this agent on purpose (revoked):** I do not try at all, and the answer says so in plain words.
- **I have never heard of the target:** the answer is now an error (502) with a plain sentence the session can pass on, saying the target may need to be paired with this machine again. The machine also records one warning per target every half hour, so a repeated failure is visible without flooding anyone.

## What this change does not do yet

Two further pieces belong to a larger piece of work that is already under way in another pull request (number 3426, "cross-machine session messages are delivered"): typing an arrived message into the right conversation on the other machine, with signed receipts. Routing a message through a third machine that does know the target needs a small change to the arrival checks that pull request introduces, so it is handed to that work instead of being built twice in conflicting ways.

## Safeguards

- No password or login token is sent anywhere new.
- Revoked machines are never contacted.
- The only status change is for a send that truly failed; everything else answers exactly as before.

## What a reader needs to decide

Nothing is waiting on a decision. This is a small, fully reversible code change: a revert restores the old behaviour, with no data to repair.
