# Stale-Owner Release — Plain-English Overview

> The one-line version: when the machine holding one of your conversations genuinely dies, another machine takes it over — but only after proving the owner is really gone (not just briefly unreachable), with one designated claimer, hard caps on how much moves at once, and a paper trail for every decision, including the decision NOT to act.

## The problem in one breath

Your conversations each live on one machine. If that machine dies — power cut, crash, total network loss — its conversations are stranded: the records still say "that machine owns this," and the healthy machine politely refuses to take over. Today the system detects this and tells you; it doesn't fix it by itself, because an earlier design review concluded automatic takeover wasn't safe yet and wrote down seven conditions that had to be met first. This spec is that deferred work, done properly against those conditions.

## The honest correction from review

The first draft cited the June lease-wedge incident as its motivation — but nine reviewers grounding the draft against the real code showed that in that incident the owning machine was alive the whole time (a different bug, already fixed at the network layer). The real gap this closes is narrower and real: the genuinely-dead-owner case. The draft also proposed new takeover machinery; the review found the takeover engine already exists (it just only covers pinned topics and demands very strong evidence), so this work extends that one engine instead of building a rival — two takeover authorities with different rules would itself be a split-brain risk.

## How it works, in plain terms

Before any takeover, ALL of these must be true: the dead machine has missed its health pulses for a sustained period; it's unreachable on every network path it ever advertised (checked with signed probes — and if the list of paths is empty or stale, that counts as "can't tell," which means don't act); the claiming side can prove its OWN network works (a machine with a broken cable sees everyone as dead — it must never "rescue" the whole fleet); a majority of machines agree; and the owner has left no recent authenticated fingerprints (a machine can lose its peer links yet still be happily replying to you over the public internet — reachability alone doesn't prove death).

Only one machine — the current mesh captain — is allowed to claim, so two survivors can't both grab the same conversation. The dead machine, for its part, fences itself: if it can't renew its own claim to a topic, it stops sending messages for that topic, so even a half-alive machine can't double-reply. Takeovers are paced (a dead machine with twenty conversations doesn't trigger twenty simultaneous rescues), pins you set are paused rather than fought over, and when the dead machine comes back it checks the shared record first and stands down cleanly.

Every decision — including "I chose not to act because I couldn't be sure" — is written to a log, and if uncertainty drags on, you get exactly one question ("this looks stranded — your call"), never silence and never a flood.

## Open questions

None — the operator pre-approved this project's decisions (topic 29836). The contested calls are all resolved in the spec: one takeover engine (the existing one, extended), the mesh captain as the only claimer, act-only-on-proof-of-death with every ambiguity failing toward "wait and ask," messages during a takeover may very rarely arrive twice (stated plainly; the duplicate-suppression layers absorb it, and a follow-up increment tightens it), and the whole feature ships observing-only first, with its "I would have taken over now" decisions logged for review before it's ever allowed to act.
