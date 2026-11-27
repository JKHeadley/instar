# Spec approvals carry the constitution check: the plain version

## What went wrong

Instar has a constitution: a long list of standards that everything built on it is supposed to follow. It also has a built-in checker that reads a design document (a "spec") and says which of those standards the design might break. That checker runs automatically, but only inside one specific review process. On November 15 a spec was written and reviewed by hand, outside that process, so the checker never ran, and the spec was sent to Justin to approve anyway. Justin's point: the constitution is meant to be part of every design, always, not something that happens only when someone remembers.

## What this change does

Two small pieces.

First, every time the checker runs, the server now writes down the result: which spec, when, and which standards were at risk. That is just a record; it cannot block anything by itself.

Second, the places where an approval request reaches Justin now look at those records. Every message the agent sends already passes through a reviewer that reads it before it goes out. That reviewer gets one new rule: if the message asks Justin to approve a spec or a design, it must say what the constitution check found. If it does not, or if it claims a check that has no record, the message is held and goes back to the agent with the fix: run the check, then send again with one line giving the result. The same rule applies when the agent writes a card on the Work Board asking for approval.

The reviewer is an AI reading for meaning, not a list of trigger words, because people ask for approval in endless ways ("OK to build?", "ready for your sign-off", "say yes and I start").

## Safeguards

- Only the agent ever has to do anything. Justin is never asked to run the check or fix the message.
- If the checker itself is down, the agent can say so honestly in the request, and that counts.
- Approvals of other things (a payment, merging finished code, pairing a phone) are not affected, and neither are changes to the constitution itself, which have their own process.
- If the Work Board's judge cannot answer, it tries a second model; if that fails too, the card is not written and the agent is told to try again in a minute. Nothing is lost.
- Each machine keeps the records of the checks it ran, and the reviewer reads them from every machine, so a check run on the laptop counts for a message sent from the Studio.

## What you need to decide

Nothing. This uses the constitution as it stands and changes no standard. It ships on for Echo with the next release. Undoing it is a plain revert.

One bookkeeping note: the new record-keeping file is listed in the release check's list of code outside the message-delivery path it certifies, the same way the previous fix's helper was.
The Work Board check's AI calls are counted under the same token-use category as the message reviewer's.
