# A finished round can now be recorded as finished

## The one-sentence version

The part that checks "is this work actually merged?" was a placeholder that always answered
"nothing is merged" — so a round could never be marked done, and asking it to run again would start
a fresh session to redo work that was already finished.

## What was actually there

Projects here are organised into **rounds** — a batch of items worked together. When a round runs, a
supervisor loops: *check whether every item has landed; if not, start a session to do the work; when
that session exits, check again.*

That check had a seam so tests could substitute a fake. Its default read, in full:

> Best-effort no-op default — production callers should pass a real one.

No production caller ever did. The one place that starts a round passes four things —
tracker, project id, round index, repo path — and not the checker. So production ran the
placeholder, which returns an empty answer every time.

## Why an empty answer is worse than an error

An empty answer means **"I verified nothing."** To the code receiving it, that is indistinguishable
from **"nothing is merged."** Nothing crashes. Nothing logs. It just quietly always says no.

Three things followed:

1. The "everything has landed" condition could never be true, so a round whose items were all merged
   **still started a session to redo them**.
2. "Complete" became unreachable — not missing from the code, just never arrivable.
3. Since the progress line counts only completed rounds, a project could honestly report
   **"0 of 5 done"** while its items sat merged and verified. That is exactly what this project was
   reporting when the defect was found.

## What changed

**The placeholder is deleted.** The seam now defaults to the real, git-backed checker, so a caller
cannot forget to supply one. That is the whole fix in one line: the failure mode of forgetting is now
"it works", instead of "it silently always says no".

**And the answer got a third state.** The real checker already distinguishes three things, and the
runner now respects all three:

| The checker says | What it means | What the runner does |
| --- | --- | --- |
| verified | the work is on main | count it as landed |
| regressed | git said, definitively, no | start a session to do the work |
| unverifiable | the check could not run | see below |

## The interesting part: two very different "I don't know"s

"Could not check" arrives in two situations that look identical in the data and mean opposite things:

- **The item records no merge commit at all.** Nothing has landed — which is the ordinary state of a
  round nobody has worked yet. The right move is to start the session.
- **The item records a merge commit, but git could not answer.** The work may already be done. Starting
  a session would redo it.

Telling these apart matters enough that getting it wrong breaks the system in opposite directions:
treat the first as "unknown" and every fresh round stalls forever; treat the second as "not done" and
you are back to redoing finished work.

They are separated by **evidence** — does the item record a merge commit? — and deliberately *not* by
reading the explanation text, because then rewording a message would silently change what the system
does.

When the second case happens, the runner **refuses in both directions**: it does not start a session,
and it records no verdict at all. The round keeps the state it had and gets asked again later. Saying
"failed" or "partly done" would state a conclusion nothing established.

## What this does not do

It does not make rounds run on a schedule, and it does not change what a session does once started.
It makes a finished round recordable as finished, and makes an unanswerable check say so instead of
guessing.

## Honest note on how it was built

The first draft applied the evidence rule at the pre-session check and missed the identical check
after the session exits — so the old conflation survived in the second spot. A test written for the
fresh-round case caught it. The rule is now defined once and used in both places, specifically so the
two cannot drift apart again.
