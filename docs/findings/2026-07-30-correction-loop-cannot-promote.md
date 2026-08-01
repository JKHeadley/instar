---
title: "The correction-learning loop has never promoted a preference, and two independent defects stand in the way"
date: 2026-07-30
author: echo
machine: Mac Mini
severity: high
status: open
kind: finding
relates:
  - "docs/findings/2026-07-30-councilor-correctness-three-passes.md"
  - "docs/STANDARDS-REGISTRY.md"
---

## The claim

The Correction & Preference Learning Sentinel is **enabled** and has been recording for **28 days**. It
holds **37 corrections across 14 distinct days**. It has promoted **zero** preferences —
`.instar/preferences.json` has never been written — so nothing is injected at session start and the
`selfViolationSignal` detector has nothing to detect against.

There are **two independent reasons**, and fixing either alone changes nothing. That is the load-bearing
point: the obvious repair produces a still-zero result that reads like health.

## Why this was worth measuring

On 2026-07-30 the operator corrected this agent on three points and observed that all three had been given
"multiple times now". Two of them **were already recorded** as boot-injected operational facts and were
violated anyway. Turning a repeated correction into durable enforcement is exactly this loop's job, so the
first question is whether the loop works. It does not, and the reasons are mechanical rather than tuning.

## Defect 1 — the dedupe key cannot collapse the text the loop actually stores

`CorrectionLedger.dedupeKey(kind, learning)` is `kind:sha256(normalizeLearning(learning))`, where
`normalizeLearning` lowercases, strips non-alphanumerics, drops a 40-word stop list, **sorts the remaining
tokens**, and joins them. Two records share a key only if their content-word multisets are **identical**.
One differing word yields a different key. Recurrence is then counted per exact key —
`... FROM correction_occurrences WHERE dedupe_key = @dedupeKey ...` — and there is no clustering,
similarity match, or grouping anywhere in `CorrectionAnalyzer` (verified by search with a positive control
on the class name and a negative control on a nonsense token; the file's single mention of clustering
explicitly assigns it to the separate `/feedback` path).

The function's own comment states the intent it does not achieve:

> *"Stop-words stripped before hashing so semantically-identical learnings phrased differently collapse to
> ONE dedupeKey."*

It cannot, because the distiller emits free prose averaging **15.9 content words** per record. A 16-word
bag must match exactly.

| measurement | value |
|---|---|
| correction records | **37** |
| distinct normalized forms | **37** |
| occurrence rows / distinct keys | 37 / **37** |
| record pairs at Jaccard 1.00 (the only ones that dedupe) | **0** of 666 |
| maximum `occurrenceCount` across all records | **1** |

Nothing has ever deduped. And the loop *did* see recurrence: on 2026-07-09 it recorded the operator's
"give me links to plans and walk me through the approval steps" correction **twelve times in seventeen
minutes**, in twelve different phrasings, producing twelve keys each sitting at one occurrence against a
threshold of four. Two samples, both real records:

- *"Provide direct links to relevant plans and walk the user through any required approval steps explicitly
  instead of assuming they already know the process."*
- *"Provide direct links to any plans and explicitly walk the user through approval steps instead of
  assuming they already know the process."*

## Defect 2 — even with perfect grouping, nothing in 28 days would promote

This is the half that makes the obvious fix insufficient, and it is only visible if you test it.

Clustering all 37 records by single-link Jaccard ≥ 0.5 — a **generous** grouping chosen deliberately to
favour the loop — yields 26 clusters. Exactly one has more than a single member: the 12-record family
above. Applying the real gate (`minSupport 4` **and** `minDistinctDaysPreference 2` **and**
`minDistinctTopicsPreference 2`):

| clusters | crossing the gate with perfect dedupe |
|---|---|
| 26 | **0** |

The one recurrent family clears `minSupport` twelve times over and fails both diversity prongs: **1
distinct day, 1 distinct topic**. Every other cluster is a singleton.

**The diversity prongs are not wrong — they are defending against exactly this burst.** Twelve records in
seventeen minutes is one conversation, not twelve occasions; counting it as support-12 would promote a
preference on a single moment's evidence. The prongs are the correct guard.

What that exposes instead is a **distribution problem**: 33 of 37 records come from a single topic
(29723), because that is where this operator does the work. For such an operator
`minDistinctTopicsPreference: 2` is close to unsatisfiable, so genuine cross-day recurrence in one topic
can never promote no matter how good the dedupe becomes. Whether topic-diversity is the right proxy for
"this is a real standing preference rather than one conversation's mood" is a design question this finding
raises and does not answer.

## The obvious fix does not work, and someone will try it

`correction-analyzer` is **disabled and has never run** (`enabled: false`, `lastRun: null`). Enabling it is
the natural first move and it addresses neither defect. Run against the current ledger it would evaluate 37
keys, find every one at a single occurrence against a threshold of four, promote nothing, and emit a zero
that reads as *"the loop works, there is simply nothing recurrent yet."*

That reading is false and is worse than the present silence, because it converts a structural defect into
an apparently-healthy measurement. **Enable the job only alongside a grouping mechanism, and only once the
diversity prongs have been reconsidered — otherwise the zero will be misread.**

## What is NOT claimed

- **Not** that the stop-word normalization is careless. It is a sound collapse for short constrained
  phrases and is defeated by 16-word LLM prose. The mismatch is between two components, not a fault in
  either alone.
- **Not** that `minSupport: 4` is mis-tuned. Lowering it would not help — the maximum observed count is
  one, and the family that would clear it fails on diversity instead.
- **Not** that the diversity prongs should be removed. The 12-in-17-minutes burst is the argument *for*
  them. What is questioned is topic-diversity specifically, as a proxy, for a single-topic operator.
- **Not** a claim about other agents. Every number is this machine's ledger. The mechanism lives in shared
  code so the defect is expected to generalise, but that is an inference and has not been measured
  elsewhere.
- **Not** a diagnosis of why the analyzer ships disabled. That is plausibly a deliberate rollout posture;
  it was not investigated.
- **Not** a claim that promoting preferences would have prevented the 2026-07-30 violations. Those facts
  were already injected at boot and were violated anyway — which suggests injection is necessary and not
  sufficient, and is its own open question.

## Direction for a fix (design questions, not patches)

**For defect 1 — how do semantically-equal corrections come to share a key?**

1. **Constrain the distiller's output** so the key is exact by construction: emit a bounded class label
   alongside the prose, hash the label, keep the sentence for human reading only. This removes the need to
   collapse free text at all, and bounded enum buckets have precedent in this codebase. It changes the
   distiller contract.
2. **Group at analyze time** by similarity over open records. Cheapest, but introduces a threshold needing
   its own justification — and a wrong threshold merges distinct corrections, which is worse than failing
   to merge, because a merged preference asserts something the operator never said.
3. **Reconcile at write time** by reusing an existing key on match. One grouping decision in one place, but
   puts a similarity judgement on the write path.

Shape 1 best fits "Structure beats Willpower": grouping becomes correct by construction rather than by a
tuned comparison. That is a recommendation, not a decision.

**For defect 2 — what evidence should stand for "a real standing preference"?** Distinct days is a
defensible proxy for durability. Distinct topics is a proxy for generality that a single-topic operator
cannot produce. Candidate directions include making the topic prong conditional on the operator's actual
topic spread, or replacing it with a separate-conversation-session prong. Not decided here.

## How to reproduce

Read `correction_records`, apply `CorrectionLedger.normalizeLearning`, and compare distinct normalized
forms against total rows — equality means nothing has ever deduped. Then cluster by Jaccard and apply the
gate thresholds to each cluster. **Both checks are needed**: the first alone finds defect 1 and leaves the
impression that fixing it is sufficient. The signature of the pair is a corpus whose maximum pairwise
similarity is high, whose maximum occurrence count is one, and whose only multi-member cluster is confined
to a single day.
