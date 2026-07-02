# Stale-Owner Release — Plain-English Overview

> The one-line version: when the machine holding one of your conversations
> genuinely dies, another machine takes it over — but only after passing a
> multi-part evidence bar that proves the owner is really gone (not just briefly
> unreachable), with one designated claimer, hard caps on how much moves at once,
> and a paper trail for every decision, including the decision NOT to act.

## The problem in one breath

Your conversations each live on one machine. If that machine dies — power cut,
crash, total network loss — its conversations are stranded: the records still say
"that machine owns this," and the healthy machine politely refuses to take over.
Today the system detects this and tells you; it doesn't fix it, because an earlier
review concluded automatic takeover wasn't safe yet and wrote down seven
prerequisites. This spec is that deferred work, done against those prerequisites
— each one is walked explicitly in the spec.

## What three rounds of review did to the design (the honest story)

**Round 1 — wrong motivation, wrong architecture, both corrected.** The draft
cited the June lease-wedge incident as motivation, but in that incident the owning
machine was alive the whole time (a different bug, already fixed at the network
layer) — the citation is withdrawn; the real gap is the genuinely-dead-owner case.
The draft also proposed new takeover machinery; the takeover engine already exists
(it just only covers pinned topics), so this work extends that one engine — two
takeover authorities with different rules would itself be a split-brain risk.

**Round 2 — the evidence bar and its blind spots.** The bar: sustained missed
health pulses; unreachable on every network path the owner itself ever advertised
(signed probes; an empty, stale, or single-path list counts as "can't tell" =
don't act); the claimer proves its OWN network works (a machine with a broken
cable sees everyone as dead and must never "rescue" the fleet); a majority of
machines agree; the owner has left no recent authenticated fingerprints over a
provably fresh mirror (unreachable ≠ dead — a machine can lose its peer links yet
still reply to you over the public internet); and a fresh re-read right before the
claim. Round 2 then caught four holes around it: (1) *restart amnesia* — the
freshness memory is in-RAM, so if the claiming machine restarts, a genuinely dead
owner would read as "never seen, so not provably dead" FOREVER, silently degrading
auto-failover back to manual; a bounded bootstrap rule fixes it (long enough
non-observation since boot plus a durable last-known heartbeat, with anything
earlier escalated to you rather than silently stranded). (2) The existing
staleness feed used the dead machine's own self-reported clock — the exact thing
its own documentation forbids; rewiring it to observer-stamped time is a named
prerequisite fix. (3) The path list used for "unreachable everywhere" had to come
only from cryptographically verified owner announcements — the shared registry
copy is writable by any machine, so a forger could shrink the list and manufacture
a death. (4) If nobody holds the captain lease at all (a real failure mode with
the churn breaker exhausted and the preferred captain dead), the "this looks
stranded" question to you is now raisable by ANY majority member — only the claim
itself stays captain-only.

**Round 3 — the shared state becomes its own record kind.** Three things must
survive the captain role moving between machines: a claimed topic's paused pin,
the per-topic claim budget, and your "no, don't take this over" refusal. Round 2
put them on the ownership record; grounding killed that: the pipeline that
receives ownership records STRICTLY rejects unknown fields — an old-version
machine seeing the new field would halt the sender's entire ownership stream —
and even between updated machines the field would be silently dropped. So they
now ride a NEW, separate replicated record kind ("topic-claim-annotation"): new
kinds are additive, so machines on older versions simply never sync it and choke
on nothing. It's also deliberately independent of the ownership version counter,
because bumping that counter for a bookkeeping note would fence out a LIVE
owner's messages once self-fencing is wired. Round 3 also admitted honestly that
one bootstrap tie-breaker (the ~30-minute coarse heartbeat) can't distinguish a
live owner from a dead one on its own — live-owner protection rests on the other
evidence — and unified the paused-pin label with the sibling pin spec so both
read surfaces speak one name.

## What this adds, concretely

Automatic takeover of a provably-dead machine's conversations (pinned AND
unpinned); a self-fencing owner (a machine that can't renew its own standing stops
sending for its topics, so even a half-alive machine can't double-reply — wiring
that fence into real Telegram sends is a hard prerequisite before the feature may
act); a clean stand-down when the dead machine returns; a status page of every
attempt, would-act, and refusal by reason; and one honest continuation notice to
you when a conversation changes machines.

## The safeguards

Every ambiguity fails toward "wait and ask" — a brief strand beats a split-brain.
Claims are capped per pass, budgeted per topic with a loud give-up, and resumed
sessions go through the existing one-at-a-time calm queue — never a mass spawn.
Your "no" is durable and follows the topic across captain changes — conditions
drifting never resurrects the ask. Messages during a takeover may very rarely
arrive twice (stated plainly; duplicate suppression absorbs it, and a follow-up
increment tightens it). A two-machine setup with no independent tiebreaker gets
detection and the question to you, but the claim path is disabled outright. And
the feature ships observing-only: it graduates to acting only after a measured
soak — at least five "I would have claimed now" calls over days, each confirmed
correct, zero wrong — read off its own telemetry, not off anyone's impression.

## What you actually need to decide

Nothing — you pre-approved this project's decisions (topic 29836), and the spec
ends with zero open questions. Approval of the converged spec is the only step.
