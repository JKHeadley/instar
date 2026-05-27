# Conformance-gate timeout fix — plain English

## What this is about

Instar has a "rules inspector." When someone writes a spec (a plan for a new feature or fix), this inspector reads our written constitution — the list of standards we hold ourselves to — and uses the AI to check the spec against every rule, then reports anything that looks like it breaks one. We recently wired it to run *automatically* during spec review, instead of relying on a person to remember to run it.

## What went wrong

I tested the inspector on a real, full-size spec — about 400 lines. It didn't answer. It gave up with a "timed out" error after 30 seconds.

## The part I got wrong the first time (and why review matters)

My first diagnosis found ONE cause and I wrote it up. Then I had a deliberately skeptical reviewer pick the plan apart — and it found a *second* cause I'd completely missed. Both had to be fixed. This is exactly why we run specs through review before writing code: my confident first answer was half-right, which is the most dangerous kind of wrong.

Here are both, with a simple picture. Imagine the inspector is a worker who has to make one slow phone call to the AI to do its job.

- **Wall 1 — the building's front-door curfew.** Our server locks any request out after 30 seconds, as a safety rule so nothing hangs forever. A few requests that genuinely need longer (the ones that make an AI call) are on a "give them more time" list and get up to two minutes. The inspector makes an AI call too, but nobody ever added it to that list — so it got kicked out at 30 seconds.
- **Wall 2 — the worker's own phone has a 30-second auto-hangup.** Even if we let the worker stay in the building longer, the *phone itself* is set to hang up after 30 seconds. So the slow AI call gets cut off regardless. Worse: when the call is cut, the inspector shrugs and reports "nothing found" — which reads like the spec *passed*. So fixing only Wall 1 would turn a loud, obvious error into a quiet false "all clear." That's worse than the original bug.

## Why it matters

The inspector is *advisory* — it never blocks anything, it just flags concerns. So neither wall broke anything loudly. But together they meant that on big, important specs — exactly the ones where a constitutional check matters most — the inspector either errored out or, after a half-fix, would have quietly claimed everything was fine. A safety check that silently says "all clear" on the important cases is the worst outcome, because you trust it when you shouldn't.

The good news: this is the "Instar improves itself" idea working as intended. I shipped the auto-wiring, immediately ate my own cooking by running it on a real spec, and the skeptical reviewer caught the rest. Our small test cases used tiny fake specs, so they never hit either wall.

## What the fix is

Take down both walls, cleanly:

1. Add the inspector to the "give it more time" list (front-door curfew raised to three minutes for this one route).
2. Teach the worker's phone to accept a longer limit when it's told to — and have the inspector tell it to use about two and a half minutes. Everyone else who makes quick AI calls is untouched; only this inspector opts into the longer limit.

The two limits are set so the phone hangs up *just before* the front-door curfew would — so if a spec ever truly is too slow, you get a clean "couldn't finish, treat as advisory" instead of an ugly timeout error.

## What's NOT changing

- The inspector stays advisory. It still never blocks anything. More time only lets it *finish* and hand back its notes.
- Every other AI call in the system keeps the same 30-second limit it has today — nothing else slows down or speeds up.
- The fast "show me the inspector's stats" request keeps the normal limit; it makes no AI call, so it doesn't need more time.
- Nothing on your end changes. No setting to flip, no command to run.

## What you're deciding

Whether to approve this fix so it can ship. It's small and fully reversible — four little edits and tests that lock in the correct behavior so it can't quietly slip back. The one thing worth knowing: it's a bit bigger than my first "one-line" estimate, because the review correctly found the second wall. Better to ship the whole fix than half of it.
