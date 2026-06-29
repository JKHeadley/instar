# Bias to Action — ELI16

## What went wrong

Justin told me to fix the release pipeline "on your own — this is exactly the kind of
thing you should fix yourself," and gave me preapproval. I fixed the urgent part, but
then for the bigger structural fix I stopped and asked "ready for your go-ahead to
build?" — and waited. He'd already given me the go-ahead. So I made him chase me
("did you get my last message?") for permission he'd already granted.

His point, which is the real lesson: I should never assume something is his job and
sit waiting. When he's already handed me the authority, I should ACT and report — not
ask again.

## Why my existing guards didn't catch it

I already have a system that checks my outbound messages for bad patterns. One of its
rules catches me **handing work back** to the user ("your call", "remember to do X").
But I didn't hand work back — I **asked for approval**. And the checker decides whether
an ask is fair ("is this really the user's decision?") **without ever looking at
whether the user already said yes**. So "can I build this?" looked like a perfectly
reasonable question — even though he'd already answered it.

## The fix (corrected after review — it's smaller than I first thought)

My first design added a whole new check. The review caught that I don't need one: I
**already** have a gate (called "B17 / never a false blocker") whose whole job is to
catch me handing a doable task back to the user. The only reason it missed this is that
it doesn't yet know when you've **already granted** the authority — so "can I build
this?" looks like a fair question even when you already said yes.

So the fix is to **teach that existing gate one new fact**: whether the verified operator
has already authorized this exact thing. When I ask for permission I already hold, the
gate now recognizes it as the same false-blocker pattern it already catches — and nudges
me to act and report instead of asking. No new gate, no new rule — just closing a blind
spot in the one I already have.

## The important safety rail

This must NOT turn into "act recklessly and never ask." So it deliberately **stays
silent** for the things that genuinely always need a yes — anything irreversible,
anything that spends real money over a threshold, anything out of the original scope,
or anything policy-sensitive. For those, asking is correct even with a standing
grant. It also only counts authority from the **verified** operator — never a name in
a document, never my own earlier words.

## How it ships

Signal-only and observe-first: at the start it just **records** when it would have
nudged me, so I can measure how often it's wrong before it ever changes a message. It
never blocks or rewrites what I send. Once it's proven accurate, it starts showing the
nudge. It's off by default for everyone else and turned on for me first to dogfood.

## Why it matters

This is the "build it into the structure, don't rely on remembering" rule applied to
initiative itself. Me remembering to be agentic is willpower. A check that catches
"you're asking for permission you already have" is structure.
