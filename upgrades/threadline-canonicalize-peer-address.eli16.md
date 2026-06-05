# ELI16 — Store a peer's real fingerprint as the conversation owner

## The problem, in plain English

When one agent messages another over Threadline, you can address the other
agent by a friendly "name plus a short code" label — for example
`Dawn-Workstation:8c7928aa`. The `8c7928aa` part is just the first 8 characters
of the other agent's long cryptographic fingerprint, used to tell apart two
agents that happen to share a name.

Here's the bug. When I sent the first message, my server looked up the *full*
fingerprint (`8c7928aa9f04fbda947172a2f9b2d81a`) so it could actually route and
encrypt the message to the right agent — but then, when it wrote down "who owns
this conversation," it saved the raw label I typed (`Dawn-Workstation:8c7928aa`)
instead of that resolved full fingerprint.

That mattered because of a security guard. Threadline has an anti-hijack check:
when a reply comes in claiming to belong to an existing conversation, the guard
asks "is the sender actually the agent who owns this thread?" A genuine reply
arrives carrying the sender's *full* fingerprint (and often no display name at
all). The guard compared the stored owner (`Dawn-Workstation:8c7928aa`, a label)
against the reply's bare full fingerprint (`8c7928aa9f04…`), saw they were not
equal, and concluded the reply might be an impostor. So it shunted my friend's
perfectly legitimate reply into a brand-new, empty conversation — and the thread
lost all its memory. It felt like the other agent had become a stranger
mid-conversation. This is the "fragmented identity" incoherence: a known peer's
own replies being treated as someone else's.

## The fix

The server *already* resolves the peer's full fingerprint when it sends the
message (it has to, in order to route and encrypt). The fix is simply: store
*that* resolved full fingerprint as the conversation's owner, and keep the label
I typed only as a separate, human-friendly display name. Now when the reply
comes back carrying the full fingerprint, it matches the stored owner exactly,
the guard says "yes, this is the same agent," and the conversation continues
normally instead of cold-starting.

This follows a pattern the code already uses elsewhere: the Telegram mirror for
outbound messages already stored the resolved fingerprint as the owner and the
typed name as the display name. Only the "capture origin" write had been using
the raw label. We brought it in line.

## Why it's safe

The guard is not weakened at all. We never guess, and we never trust a short
8-character prefix as proof of identity (that would be too easy to fake). We
only store the *full* fingerprint that the server itself resolved for routing.
An impostor presenting a *different* fingerprint still fails the match and still
gets isolated — exactly as before. The only thing that changes is that a real,
known peer's reply now correctly resumes its own conversation instead of being
mistaken for a stranger.

## What you'd notice

Almost nothing — that's the point. Agent-to-agent conversations that were
addressed with the `name:shortcode` syntax will simply stay coherent across
replies instead of occasionally restarting as if from scratch.
