# The Benchmark-Divergence Detector, in plain English

## What problem this solves

We have a benchmark that PREDICTS how well each AI model should do at each kind of job ("this model is great at spotting runaway processes"). We now also have a quality meter that records how those decisions ACTUALLY turned out in real life (right, wrong, or not-yet-known). The gap: nothing compares the two. So when reality disagrees with the benchmark's prediction — exactly the signal worth acting on — nobody sees it. And the real-life grade data gets automatically deleted after a while, so its lessons can vanish before anyone learns from them.

## What this is

A small, read-only "detector." On a schedule (run by exactly ONE of the machines, so there are no duplicate reports), it lines up each job type's REAL grade-rate against the benchmark's PREDICTED rate — model by model, using only settled grades (the not-yet-known ones are counted separately, never mixed in). When they disagree by more than a fair margin — fair meaning it also accounts for how much data there is, so a handful of samples can't trigger a false alarm — it records a finding with ranked questions:

- If reality is WORSE than predicted: did the model get enough context? the right prompt? does the benchmark's test set actually represent real life?
- If reality is BETTER than predicted: first ask whether the grading is being too generous — a suspiciously great score is checked before it's celebrated.

And there's a trust check before any of it counts: if the benchmark tested a STALE copy of the prompt (or we can't verify which prompt it tested, or the benchmark data itself is old), the finding says "the benchmark is out of date" — it never blames or credits the model based on a stale test.

## What changed after review (the honest part)

The first draft tied the quality meter's data-cleanup to this detector's progress — which meant that if the detector was switched off (its default state!), the meter's data would never get cleaned up and would grow forever. Eight independent reviewers caught variations of that trap. The redesign removes the tie completely: the lesson of each day's grades is folded into a small permanent summary AT GRADING TIME (long before any cleanup clock), and the detector reads only those summaries. The meter's cleanup now works exactly as before, no matter what this detector does. Reviewers also added: protection against a lying machine feeding fake numbers into the pool (bounds-checked, excluded, and named, never silently mixed in), a rule that an unrecognized model name never gets compared against the wrong model's benchmark, and an "advisory only" stamp on every finding so nothing downstream can ever auto-act on one — it informs a human (or a properly-gated decision), never decides.

## The safeguards, in plain terms

- **Nothing is deleted before its lesson is kept.** The permanent summary is written when grades are stamped; if analysis ever falls dangerously behind, the shortfall is counted out loud, never silent.
- **Nothing is missed across machines.** Analysis gathers every machine's summaries at run time. A machine that's offline makes that result "partial" — rechecked later, never guessed. If a result stays partial or data-starved for several cycles in a row, that itself is flagged (a permanent "no conclusion" isn't allowed to hide a real problem).
- **It only ever observes.** It ships turned off (watch-only rehearsal mode on the development agent), returns "not enabled" unless deliberately switched on, and every finding is marked advisory.

## What you actually need to decide

Nothing for this piece — it's fully specified and buildable on its own. The one related decision (whether to also build the "keep the benchmark honest at code-review time" piece in the same round) sequences the NEXT increment and doesn't change this one.
