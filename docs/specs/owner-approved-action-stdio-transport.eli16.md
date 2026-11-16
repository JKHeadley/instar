# Owner-approved deletes, for the *default* transport — plain overview

## What this is

A sister agent (PR #3218, already merged but switched off) makes **permanently deleting a Threadline conversation** require a one-tap Face-ID approval on your phone, instead of trusting that the request came from your own machine. Good — but it only guards **one of the two ways** your sessions get their `threadline_*` tools.

Those tools come either from a small **helper program that runs once per session** (the default), or from the agent server directly (opt-in). #3218 guarded the server path. It left the **default** helper path unguarded. So if you flipped the switch today, only the opt-in minority would actually be protected. This change closes that gap, and it must land **before** anyone flips the switch.

## What already exists

- The owner-approval machinery itself: your phone signs a one-time approval with a Face-ID key; the server verifies it. (That's #3218 / the primitive.)
- The helper program already talks to the server for everything stateful (sending messages, reading history) over a local-only connection with the agent's token.
- `ThreadResumeMap` / `ConversationStore`: the on-disk record of your conversations, written in a cross-process-safe way (each write re-reads the latest file and changes only its own record).

## What's new

One server-side operation that does the **whole** gated delete in one place — check the switch, consume your phone's approval, delete the conversation — and a tiny local-only route so the helper can call it. **Both** transports now funnel through that one operation. The old idea of putting the gate *inside* the helper is gone.

## Why it was rebuilt three times

Reviewers (including a non-Claude GPT reviewer reading the real code) found the first design would have **let deletes through unapproved** (a subtle async bug turns the check into a no-op), used a **credential the helper doesn't even have**, and let a hostile local program **delete your approval request so you could never approve**. Doing the whole thing on the server, in one place, fixes all of those at once and keeps the irreversible delete where the authority lives.

## The safeguards, in plain terms

- Nothing happens unless the switch is on (ships off).
- When on: no approval → nothing is deleted; wrong/expired approval → nothing is deleted; only a real Face-ID approval for *that exact conversation* lets the delete through.
- If the server can't be reached, the delete reports **"outcome unknown — check the conversation"** rather than silently deleting or silently failing.
- A crash mid-delete leaves the conversation intact and the approval spent — you just re-tap.

## What you actually need to decide

Whether this design is sound to build. It ships **dark** (off), and even when on it adds no friction to normal use — deleting still works, it just shows one Face-ID card first. The one honest trade-off: a delete now needs the agent server reachable (it already does for everything else). The live phone-tap proof still gates the switch being flipped; approving this spec only authorizes building it.
