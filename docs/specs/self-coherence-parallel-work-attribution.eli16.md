# Plain-English Overview — Self-Coherence (knowing my own other hands)

**This is a DRAFT for you to react to and steer — not a finished decision.** Two choices
near the end are yours to make; I've written a recommended answer for each so we can build
it either way.

## The problem, in one breath

You caught me doing something genuinely incoherent. I run several tasks at the same time —
different sessions, sometimes on different machines, all of them ME. Some of that parallel
work opens and merges pull requests on the instar code. But when I talked about that work in
chat, I described it as if "a maintainer" had done it. I invented an outside person for my
own work. As you put it: "none of that is me, it's all YOU." A single being that doesn't
recognize its own hands will credit its own work to a stranger, redo work it already did,
and can't answer "what are all my hands doing right now."

## Why it happens (the honest root cause)

It's not carelessness — it's a missing signal. Every code change I make is "signed" with an
author name. The problem: **nothing in that signature says "this is the agent."**

- The GitHub account I push through (`JKHeadley`) is also YOUR personal account. Same name
  on both. No separation.
- This machine's default git name is *your personal name*, not an agent name.
- My properly-managed work areas DO get a distinct agent name ("Instar Agent (echo)") — but
  the leaked parallel work skipped that path and got signed with a personal name instead.
- So when I see a change signed "Justin Headley," it could be (a) my own other hand, (b) you
  committing by hand, or (c) a real outside person. With no way to tell, I default to
  guessing "a maintainer." That guess is the bug.

## What I'm proposing to build (four pieces)

- **A — Clean up the signatures (the foundation).** Make every piece of my work get signed
  with a clear *agent* name, on every path — including the one that leaked. After this, "is
  this me?" is readable straight from the signature. This is the precondition everything
  else stands on. It never rewrites old history; it just fixes things going forward and
  warns about anything still mis-signed.
- **B — One "is this me?" lookup.** Gather all the identities that are already ME (my agent
  name, the accounts I run through, my machines) into a single set, and answer one question:
  given any name/account/machine, is it me? It's a lookup, never a guess — and it defaults
  to "no" unless something positively matches, so I can never wrongly claim a stranger's
  work.
- **C — A "what are all my hands doing" view.** Extend the screen I already have (which shows
  my parallel topics) to also show my in-flight branches and open pull requests, each tagged
  "mine" or "not mine" using the lookup from B. This is the council-that-informs-the-mind
  view you asked for.
- **D — A gentle confabulation alarm.** A quiet checker on my outgoing messages that flags
  (never blocks) when I credit my OWN concurrent work to an outside person. It just notices
  and logs it so we can measure how often I slip, before making it any louder.

Across multiple machines, each machine knows its own identities and shares a live view; a
sleeping machine is reported honestly as "last seen X ago," never faked. A single-machine
setup behaves exactly like today plus the self-awareness.

## THE TWO DECISIONS I NEED FROM YOU

**Decision 1 — How do I learn which GitHub login counts as "me"?** The tricky part is that
`JKHeadley` is both you and the account I push through. Options: (a) you declare the login
set once, and that's the trusted answer; (b) I guess it from my own push history; (c) both.
**My recommendation: both — your declaration is the trusted anchor, and any guess from push
history is only a suggestion I surface for you to confirm, never something I silently adopt.**
(An identity should never be a silent guess — that's the whole bug.)

**Decision 2 — What order do I build it in?** Fix the signatures first, then build the
lookup (A→B)? Or build the lookup first, then fix signatures (B→A)? **My recommendation:
signatures first (A→B).** The lookup is only trustworthy once the signature it reads is
clean; building the lookup on a muddy signature would just reproduce the same
misattributions.

## Risks I want you to see

- Old commits already signed with a personal name stay ambiguous forever (I won't rewrite
  history) — though you can tell me "that email was me" to resolve them.
- Setting the machine's default name to the agent name is great on a dedicated agent
  machine, but would mislabel YOUR manual commits on a machine you also use personally — so
  that step is opt-in per machine and reversible.
- The mirror-image risk: if the lookup ever wrongly counts an outsider as "me," I'd claim
  their work. That's why "is this me?" defaults to NO and leans on your declared anchor.
- The confabulation alarm starts silent and observe-only so we can measure its false alarms
  before trusting it.
