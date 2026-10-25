# Making an approval actually do something — Plain-English Overview

## The problem in one breath

Tonight the operator approved a rulebook change and nothing happened. The check that was supposed to notice his approval had already run — minutes earlier, before he tapped — and finished red. Nothing told it to look again. It only didn't leave him stuck because someone was watching and pushed the button by hand.

## What already exists

The automated checks run when code changes. That has always been enough, because until today every input they cared about was code.

## What this adds

The checks now also run when someone approves a change, or withdraws an approval. That's it — one line saying "an approval is also a reason to look again."

## The new pieces

Nothing new is built. An existing set of checks gains one more reason to run.

## The safeguards

**Withdrawing counts too, and that's the important half.** If the operator approves and then changes his mind, the check runs again and goes back to red. A check that only re-runs when the news is good isn't a check — it would let a change of mind be quietly ignored while a stale green sat on the screen.

**The new trigger is pinned in place.** There's a guard that records the exact shape of the automated checks, so this can't be quietly removed later. If it were, the symptom would be an operator approving into silence again — the same bug, returning without a trace. Now its absence breaks the build instead.

## What ships when

Immediately, and it needs nothing from the operator. It's the missing half of the approval path that shipped an hour ago.

## What you actually need to decide

Nothing. This is a defect found on first real use, fixed in the direction of your time rather than mine.
