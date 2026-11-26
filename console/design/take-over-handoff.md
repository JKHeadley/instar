# Take over / I'm done — options, not a proposal

The research's highest-value single finding (`../research/SYNTHESIS.md`, adopt #1)
is Grok Bot's hand-off: the agent hits a wall only a human can pass, hands the
human its own live session, and resumes when they're finished. Nothing restarts,
no credential changes hands.

This note exists because the next step is a **decision about scope**, not code.
It lays out what the wall actually is, three ways to answer it, and what each
costs. It deliberately does not pick one.

## The wall is real and measurable

During one night of research this stopped work three times:

| What blocked it | What I could do instead |
|---|---|
| Google refused the password (silently discarding automated keystrokes) | Message the operator, wait |
| An onboarding form demanded the operator's age | Message the operator, wait |
| A terms gate needed accepting | Message the operator, wait — until a standing authorization removed this one |

Each is seconds of human work. Each cost an interruption and, in two cases, hours
of elapsed time because the operator was asleep. The cost is not the human's
effort; it is that the agent's entire task stops and its context goes cold.

## What the hand-off has to preserve

1. **The agent's session, not a copy.** The value is that the agent resumes
   *where it was* — same page, same cookies, same half-filled form.
2. **No credential transfer.** The human acts in the agent's browser; the agent
   never learns the password, and the human never receives the agent's session
   by file.
3. **A clear end.** The agent must know when the human is finished, without
   polling the page and guessing.
4. **Attribution.** What the human did in that window must be distinguishable
   from what the agent did, in the audit.

## Three shapes, with honest costs

### A. Screen-share the agent's browser
Expose the running browser over a remote-view protocol, reachable through the
existing tunnel, PIN-gated like the dashboard.

*For:* genuinely the agent's own session; works for any wall, including ones
nobody predicted; closest to what the research observed.
*Against:* a remote desktop onto the agent's machine is a significant new exposure
surface, and the tunnel already proved unreliable tonight. Needs its own
threat model, not a flag.
*Open question for the operator:* is a PIN-gated remote view of the agent's
browser acceptable at all? If not, A is out and the rest is academic.

### B. Hand over the one field
The agent detects it is blocked, and asks for exactly the value it needs through
the existing Secret Drop — which is already one-time, encrypted and never in chat.

*For:* reuses hardened machinery; no new exposure; the narrow scope is itself a
safety property.
*Against:* only solves walls that reduce to "a value I lack". It does not solve a
CAPTCHA, a consent screen, a phone tap, or anything requiring a human to *see* the
page. Two of tonight's three walls fit; the Google sign-in did not.

### C. Scheduled human window
The agent parks the task with its state intact and re-attempts at a time the
operator said they would be available, rather than blocking on an answer.

*For:* no new surface at all; works while the operator sleeps, which was the
actual failure tonight.
*Against:* solves lateness, not capability. The wall is still a wall; the agent
just waits more gracefully.

## What I'd want decided before building anything

1. Is a remote view of the agent's browser (A) acceptable in principle? That
   single answer removes either A or most of B+C from consideration.
2. If A is out: is B's narrower promise worth building, given it would not have
   unblocked the hardest of tonight's three cases?
3. Is "the agent waits better" (C) worth anything on its own, or only as a
   companion to A or B?

## What is already true today

The pieces for B exist and are proven: Secret Drop, the credential store, the
one-time link. The pieces for A mostly exist — the agent drives a real browser,
the dashboard is PIN-gated, the tunnel reaches it — but the exposure question is
unanswered, and tonight's tunnel failures are a caution rather than a blocker.

Nothing here is built. This is a note so the decision can be made quickly, not a
commitment to a design.
