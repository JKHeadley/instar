# The Benchmark-Divergence Detector, in plain English

## What problem this solves

We have a benchmark that PREDICTS how well each AI model should do at each kind of job ("this model is great at spotting runaway processes"). We now also have a quality meter that records how those decisions ACTUALLY turned out in real life (right, wrong, or not-yet-known). The gap: nothing compares the two. So when reality disagrees with the benchmark's prediction — exactly the signal worth acting on — nobody sees it. And worse, the real-life grade data gets automatically deleted after a while, so it can vanish before anyone learns from it.

## What this is

A small, read-only "detector." On a schedule, it lines up each job type's REAL grade-rate (from the meter) against the benchmark's PREDICTED rate. When they disagree by more than a set margin — and only when there's enough data to be fair — it records a finding. Each finding comes with three ranked questions to figure out WHY reality and the prediction disagree:

0. Is the benchmark even trustworthy? (Did it test the real, current prompt, or a stale copy? If stale, the "disagreement" is a benchmark bug, not a model failure — this is the precondition under everything else.)
1. Was the model given enough context?
2. Did it have the right prompt?
3. Does the benchmark's set of test cases actually represent real life?

So a disagreement gets sorted into "fix the SYSTEM" (give the model more context or a better prompt) versus "fix the BENCHMARK" (it drifted or isn't representative).

## What already exists vs. what's new

Already built: the correlation spine, the provenance recording, and the grading pass — all part of the quality meter (just merged). New here: only the ANALYSIS layer — the part that compares real grades to benchmark predictions and raises the three questions. Grading and analysis are deliberately SEPARATE steps with separate bookmarks in the data.

## The safeguards, in plain terms

- **Nothing is deleted before it's used.** A per-machine "analyzed" bookmark marks exactly which grades the detector has consumed, and the auto-delete of raw data is blocked until (a) it's been analyzed and (b) its lesson is rolled into a permanent, content-free summary. Raw data ages out on schedule; what we learned never does.
- **Nothing is missed across machines.** At analysis time it gathers every machine's grades into one view. If a machine is offline, that result is marked "partial" and re-checked when it returns — it never draws a conclusion from an incomplete picture.
- **It only ever observes.** It records findings and answers a read-only question ("where is reality diverging from the benchmark?"). It never changes a decision, never messages you on its own, never blocks anything. It ships turned-off (dark) and, on a development agent, in a watch-only mode that writes nothing durable until deliberately switched on.

## What you actually need to decide

Scope: this spec is just the DETECTOR (needed no matter what). The related "make the benchmark trustworthy" fix (guaranteeing it tests the real shipped prompt) is a separate, bigger piece that reaches into the off-repo benchmarking setup. The decision is whether to do the detector alone now, or bundle that trustworthiness fix in the same round.
