# Sending a message to another machine: what was broken and what changed

## The short version

An agent that runs on several computers can pass a message from one of its computers to another with its own "send a message" call. That call had two problems, and this change fixes both.

First, it never actually reached the other computer. The sending side knocked on the wrong door: it posted to an address the receiving computer does not serve, got "not found" back every time, and quietly parked the message in a local folder marked "machine unreachable". That is why, during the November 20 outage, every hand-off between machines had to be done by posting directly into the other computer's own server instead. The fix points the sender at the address the receiver really serves. Both sides already check each other's machine keys on that address, so nothing about who is trusted changes.

Second, when the sending computer did not know the target computer at all (it happens when the machines' lists of each other disagree, as they did after the Mac Studio was rebuilt), the call gave up at once, answered "201 created" as if all was well, and told nobody.

## What happens now

- **The target is one of my paired machines:** the message goes straight there and, if it is for one of this agent's own named conversations, it is typed into that conversation, just like a message sent on the same computer.
- **I have never heard of the target:** I hand the message to up to four of my other machines. One that knows the target passes it on, exactly once, and signs it with its own key so the target recognises who handed it over. A machine that does not know the target says no, and I try the next one.
- **The target was removed from this agent on purpose (revoked):** I do not try at all and say so.
- **Nobody could carry it:** the call now answers with an error (502) and a plain sentence the session can pass on, for example that the target may need to be paired again. The machine also records one warning per target every half hour, so a repeated failure is visible without flooding anyone.

## Safeguards

- A message can be passed on at most once. A machine will not forward something that was already forwarded, or something whose history does not start with the machine that signed it.
- No password or login token is sent anywhere new. Every hop uses the machine-to-machine check that already exists.
- The forwarding machine gains no new power: the receiving machine already accepted anything that machine signs.
- Revoked machines are never contacted.

## What a reader needs to decide

Nothing is waiting on a decision. This is a small, fully reversible code change: a revert restores the old behaviour, with no data to repair. The one judgement worth a second look is the trust argument for letting a peer re-sign a message it forwards, written out in the side-effects review.
