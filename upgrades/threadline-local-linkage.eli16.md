# Same-machine agent replies now route back to their topic (ELI16)

## What was broken

Instar lets one of your AI agents send a message to another agent and get the
reply back in the same chat topic where you started. That works great when the
two agents live on different computers. But when both agents run on the *same*
computer (the common case — for example Echo and Luna both on your laptop), the
reply did not come back to the topic. It quietly ended up in a separate
"Threadline" holding area, and the agent that was waiting never noticed it. So
the collaboration felt clumsy: you'd see the other agent had clearly answered,
but your agent acted like it never heard back.

## Why it happened

When a message arrives, Instar runs a security check called the "anti-hijack
guard." Its job is to stop a stranger from hijacking someone else's
conversation by guessing its ID. To do that, it checks: does the sender's
identity match the identity recorded as the owner of this conversation?

A conversation stores its partner by a long cryptographic fingerprint (like an
ID number). But the same-machine delivery path handed the guard only the
sender's *name* (like "sagemind"), never the fingerprint. A name is not a
fingerprint, so the check always failed, and the guard treated every single
reply as a possible hijack. It defended the conversation by shoving the reply
into a brand-new, empty thread — one with no link back to your topic. Right
instinct, wrong target: it was firing on a friend.

## The fix

The same-machine delivery path now looks up the sender's name in the local
agent registry, finds their fingerprint, and hands that fingerprint to the
guard along with the message. Now the guard can see "yes, this really is the
agent that owns this conversation," so it lets the reply through and it routes
back to the right topic.

The fix is deliberately narrow. It only touches the same-machine path (which
only local programs on your own computer can reach). The cross-computer path,
where the real hijack risk lives, is completely untouched and just as strict as
before. We tell the guard the truth about the transport too: it's a local,
trust-on-first-use delivery, not cryptographically signed end to end — so the
performance shortcuts that require a fully verified signature stay switched off.

## How we know it's safe

There are two tests that pin both halves down. One proves a co-located reply
with its fingerprint resolved now resumes the conversation (so it reaches your
topic). The other proves that when no fingerprint can be resolved, the guard
*still* isolates the message — so the hijack protection is intact, not weakened.
Both pass, the whole anti-hijack and Threadline test suite stays green, and the
type checker is clean.

## What you'll notice

When two of your agents talk on the same machine, the reply shows up in the
topic you started in, the waiting agent picks it up right away, and you stop
seeing replies disappear into the separate Threadline area.
