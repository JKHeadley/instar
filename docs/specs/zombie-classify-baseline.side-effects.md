# Side effects — zombie-classify predictions-mirror baseline

## The change

One file: `src/data/benchmarkPredictions.json` gains a `zombie-classify` task
entry (per-model `passes`/`deterministic` counts, `benchedPromptSource`,
`benchedPromptHash`, `capturedAt`, plus `scoredPopulation` and `note` prose), and
the top-level `capturedAt` is refreshed.

No code paths change. No behaviour changes.

## Who reads this file

`BenchmarkDivergenceDetector` (observe-only, dev-gated, dark on the fleet). It
compares a decision point's real settled grade-rate against this mirror's
predicted pass-rate and emits `advisory: true` findings. It gates nothing, blocks
nothing, and cannot alter a routing decision.

Before this change the detector returned exactly one finding for this pair,
`precondition-failed` — no mirror entry existed. After it, the pair has a
prediction to compare against.

## Blast radius

**Bounded to advisory output.** The worst case from a wrong number here is a
misleading finding on `GET /benchmark-divergence`. Nothing enacts on it.

Specifically NOT affected:
- The `ExternalHogSentinel` kill path. It reads the floor and the classifier
  verdict; it has never read this file.
- Model routing. `sessions.componentFrameworks` and the provider-fallback chain
  are untouched.
- The quality meter's own grading, which derives from settled decision rows.

## The Q0 precondition

The detector refuses to draw conclusions when the benched prompt hash no longer
matches the live template — a stale benchmark must never blame or credit a model.
`98b026db…` was verified equal to a sha256 of
`EXTERNAL_HOG_CLASSIFIER_PROMPT_TEMPLATE`, compiled from this branch's source, at
commit time.

This is load-bearing in an unusual direction: if the hash were wrong, the
detector would keep reporting `precondition-failed` — i.e. it fails toward
saying nothing, not toward saying something false. That is the safe direction and
it is intentional.

**A future prompt change invalidates this baseline and must re-stamp it.** That
includes fixing the unknown-vs-false flattening logged as ACT-1212, which will
necessarily change the hash. The regeneration recipe is
`research/llm-pathway-bench/instar-bench-v2/regen-zombie-classify.mjs`, which
prints the hash to stamp. It refuses to run without being pointed at a compiled
copy of the live builder, so the numbers cannot come from a prompt pasted into
the script and left to rot.

## What the numbers are, precisely

Scored population is the 10 `production-candidate` cases — allowlist-matched, so
a model genuinely is consulted about them. Excluded and retained in the task file
as evidence:

- **4 `floor-excluded`** — never allowlist-matched. `identityFor` returns null and
  the scan tick surfaces them without classifying, so no model is ever asked.
- **1 `invalid-unwinnable`** — renders byte-identical to another case carrying the
  opposite expected answer (ACT-1212). Unpassable by construction.
- **2 `contested-expectation`** — the models made the better argument; the
  expectation was withdrawn rather than scored against them.

`gemini-2.5-flash` is `n=6`, not 10: four calls errored during the run. Recorded
as 6 because the detector's noise-awareness is only protective if the sample size
it is given is true. Padding to 10 would manufacture a confident-looking
prediction out of a thin one — the precise failure this whole mirror exists to
prevent.

## Multi-machine posture

`unified` — a git-tracked source data file, identical on every machine by
construction, replicated by the same mechanism as the rest of the source tree. No
machine-local state, no per-machine divergence, nothing to reconcile.

## Rollback

Revert the commit. The detector returns to reporting `precondition-failed` for
this pair, which is its honest state when no baseline exists. No migration, no
persisted state, no cleanup.
