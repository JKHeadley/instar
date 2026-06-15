# Action-Claim Follow-Through Sentinel — plain-English overview

## What broke

When I tell you "relaunching now" or "I'll fix that," nothing makes sure I actually
do it. On 2026-06-15 I said "Relaunching now" in a Telegram reply — and then didn't.
The work just evaporated. You pointed out this is the whole reason commitment
tracking exists: whenever I claim I'm doing something, there should be a system that
notices the claim and tracks whether it actually happened.

## What this adds

A small detector that watches my outgoing conversational messages. When I make a
**concrete future-action claim** — "I'll restart it", "pushing the change",
"relaunching now" — it automatically opens a tracked **commitment** for that action,
bound to the conversation. From then on the existing follow-through machinery (the
gentle reminder beacon + the overdue-commitment check) makes sure I actually
deliver, and if my session dies before I do, the revival system brings it back
(that's the sibling fix from earlier today — "an autonomous run must outlive its
session"). So a promise I make can't silently vanish anymore.

Crucially it is **careful, not chatty**:
- It only fires on a short, closed list of *concrete, checkable* actions (restart,
  push, merge, deploy, fix X, redeploy, revert…). Vague filler like "I'll take a
  look" or "I'll keep that in mind" does NOT trigger it — otherwise it would bury you
  in pointless reminders.
- If I say the same thing twice ("I'll restart it" across two messages), it updates
  the ONE commitment instead of creating a second — using a fingerprint of the
  conversation + the action. (Today's commitment store mints a brand-new record every
  time; this adds the missing "is this the same promise?" check.)
- A mistaken catch expires on its own after a few hours instead of nagging forever,
  and there's a cap on how many of these can be open per conversation.

## What's deliberately NOT in v1

Catching a **completed**-action claim ("I already pushed it") and checking it against
real evidence is left for a follow-up <!-- tracked: CMT-1554-sibling action-claim-A2-evidence-primitive --> — because the place this detector runs can only
see my message text, not whether a git push actually happened. Building that check
properly needs a new "what did this turn actually do" evidence feed, which doesn't
exist yet. The founding incident was a *future*-action claim ("relaunching now"),
which the v1 detector does catch — so the gap is honestly scoped, not faked.

## Safety / how it behaves

It never blocks or delays a message — it only opens a tracked commitment in the
background (signal, not gate). It ships **off on the fleet** and on for this
development agent first, so it proves itself before rolling out. If the
follow-through engine it relies on is ever disabled, that shows up on the guards
view rather than silently swallowing a promise.

## What changes for you

A concrete thing I say I'll do becomes a tracked promise you can see (and that I get
nudged on), instead of a sentence that might quietly never happen.
