# Old sessions close when a conversation moves — the plain-English version

## The problem you named

"Sessions don't get closed off of a machine after the topic has moved from one
machine to another, which leaves duplicate sessions that do duplicate work."

Exactly right. When you said "move this to the laptop," the system moved the
conversation — but the Mac Mini's session for that conversation just… kept
sitting there. Worse, if it was busy, the safety guards that protect working
sessions from being killed protected the DUPLICATE too — it was "working,"
after all, just working on the same thing twice.

## The fix — two layers

**Layer 1: instant cleanup on an explicit move.** The moment your "move this
to X" lands, the machine you're leaving closes its session for that
conversation. Your command is the authority — same as clicking "close" in the
dashboard. You already get the "Moving…" reply; the close itself is silent
(nothing disappeared — the conversation continues on the other machine).
Protected sessions (the ones on the never-kill list) are never auto-closed.

**Layer 2: a standing rule that catches everything else.** Moves can also
happen without you asking — a failover, automatic load-balancing. So the
session reaper now checks every couple of minutes: "is this session bound to a
conversation that another machine now owns?" Two consecutive yeses (about 4
minutes — enough to ride out a move in progress) and it closes the leftover,
even if it's busy — busy-on-a-duplicate is the exact problem. This close still
goes through the normal safety authority: if a guard says "not yet," that's
recorded and retried, never forced.

## How you can verify it

Every close (and every refusal) is written to the reap-log with the reason
"topic moved to <machine>." Ask me "why did that session disappear?" and I'll
read you the exact entry. Single-machine setups are untouched — the rule
simply never fires when there's no second machine to move to.

## What changes for you

Move a conversation and the old machine quietly tidies up after itself. One
conversation = one session = one machine doing the work.
