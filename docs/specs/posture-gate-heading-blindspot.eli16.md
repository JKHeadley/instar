# The safety check that couldn't see a numbered heading — plain-English overview

## The problem in one breath

There is a rule that every design document must say how its feature behaves when the agent runs on more than one machine. An automatic check is supposed to make that rule unskippable. It finds the relevant section by looking for a heading that reads exactly "Multi-machine posture" — and it does not recognise "8. Multi-machine posture". The section number, which is an entirely ordinary thing to write, makes the section invisible to it.

## What already exists

Two things check this rule, and only one of them was broken.

A human-facing reviewer reads each document and judges whether its multi-machine answer is actually correct. That has been working, and it reads a heading however it is written.

Alongside it sits a small automatic check whose narrower job is to confirm that a required marker is present and well-formed. It is deliberately not wired into anything yet — that graduation is hard-sequenced behind other work, and is on the operator's decision list. This is the one that was blind.

## What this changes

The check now finds its section by looking for the phrase anywhere in a heading, rather than demanding an exact title. When a document has several headings that could match, it prefers the one that looks like a real section heading rather than a passing mention, so the choice is predictable rather than a matter of which came first.

Measured on the real corpus: it used to see 91 documents and now sees 129. The 38 it had been skipping are not obscure ones — they include the replicated-store foundation, the mesh self-heal document, the secure agent-pairing document, and the document that defines the standards themselves.

## The second bug, found by using the fix

Pointing the repaired check at a real document immediately produced a complaint, and the complaint was wrong. That document *quotes* a marker while explaining that an earlier draft got it wrong, and ordinary paragraph wrapping had pushed the quotation to the start of a line — where the check read it as a live declaration in the wrong place.

The fix distinguishes a quotation from a declaration by what follows it: a real declaration is the whole line, whereas a quotation closes its quote marks and carries on into a sentence. No existing test had ever contained a document that talks *about* markers, which is why nothing caught it.

## Why the first attempt was not enough

Allowing a section number fixed 34 documents. Re-running the sweep rather than declaring victory found four more heading shapes still invisible: a section symbol instead of a digit, a letter instead of a number, the phrase sitting mid-title rather than leading it, and the phrase in brackets after something else. Each would have stayed silently skipped. The final version handles all of them, and a re-sweep confirms no document with a posture heading is invisible any more.

## The safeguards

**Nothing can be blocked by this today.** The check reports rather than blocks unless run in a strict mode, and that strict mode is invoked by nothing in the repository — deliberately. So this change cannot break a build.

**Being too eager was measured, not assumed.** Matching the phrase anywhere in a heading could in principle pick a heading that merely discusses the topic. Of the 37 newly visible documents, two matched on an unusual heading and both turned out to be genuine sections. Zero false picks across the whole corpus.

**The direction of error is the right one.** Being slightly too eager means checking a section that might not be the intended one, and the result is a report someone reads. Being too strict means skipping the check entirely and reporting nothing — which is what had been happening to a third of the corpus, silently.

## What you actually need to know

This does not fix anything that is currently running, because the check is not currently running. What it does is remove a hole the check would otherwise have carried with it when someone eventually switches it on.

The thing worth knowing before that switch is flipped: now that it can see the whole corpus, it reports 90 issues across 85 documents, where before it reported 71. Turning it on without working through that list would fail every build. That decision — whether to switch this check and three similar ones on, schedule it, or record them as deliberately advisory — is already on the operator's list, and three of the constitution's own standards currently name one of those four checks as their guard.

## Rolling it back

Revert the commit. The check returns to seeing 91 documents. There is no data to migrate, no agent state to repair, and no release to issue — this file is not shipped to agents.
