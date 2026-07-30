---
title: "Correction-learning promotion — the decided shape"
date: 2026-07-30
author: echo
machine: Mac Mini
status: decided-not-built
kind: decision
relates:
  - "docs/findings/2026-07-30-correction-loop-cannot-promote.md"
---

## What this decides

`docs/findings/2026-07-30-correction-loop-cannot-promote.md` established that the correction-learning loop
has recorded 37 corrections over 28 days and promoted zero preferences, for **two independent reasons**, and
that fixing either alone changes nothing. This document decides the shape of the fix. It does not build it.

It exists because the finding named three candidate shapes without choosing, and an unchosen design is the
thing that rots. **CMT-1133** carries it.

## Decision 1 — group at analyze time; do NOT change the dedupe key

The finding listed three options: constrain the distiller to emit a bounded class label and hash that; group
at analyze time by similarity; or reconcile at write time. The finding leaned toward the first as the most
structural. **On investigation that lean was wrong, and the reason is migration.**

`dedupeKey` is the stored identity of every `correction_records` row and the join key for
`correction_occurrences`. Changing how it is computed re-identifies all 37 existing rows: their occurrence
history either has to be migrated onto new keys or is orphaned. That is real risk for a loop that currently
produces nothing, and it buys nothing that grouping cannot.

**Decided: leave `dedupeKey` exactly as it is** — an exact hash of the normalized learning — so an identical
repeat still collapses as it does today, and no stored row changes identity. **Add grouping in
`CorrectionAnalyzer`**, which already loads the full record set (`this.ledger.list(...)`) and already loops
per record. The recurrence gate then evaluates over a **cluster of keys** rather than a single key.

Why this is the better shape, stated so it can be argued with:

- **No migration.** Stored identity is untouched; only the promotion decision changes.
- **A wrong cluster cannot corrupt data.** Clustering affects promotion only. A bad merge produces a
  wrong *preference*, which is reviewable and reversible, rather than a wrong *record*, which is not.
- **No taxonomy to invent.** The bounded-class-label option requires deciding, up front, what the classes of
  correction are. A wrong taxonomy mis-bins corrections permanently and is far harder to walk back than a
  tuned threshold.
- **It is where the evidence already is.** The analyzer has every record's text in memory at gate time. The
  ledger does not need to know about similarity at all.

**The threshold is the load-bearing risk and must be argued, not picked.** A wrong merge asserts a
preference the operator never expressed, which is worse than failing to promote. Two guards belong in the
implementation: cluster only within the same `kind` (a `user-preference` may never merge with an
`infra-gap`), and require a high similarity floor. Measured on the live corpus, the one genuine recurrent
family sits at Jaccard 0.75–0.89 pairwise while the next-nearest unrelated pair is far below — so a floor in
the 0.6–0.7 band separates them with margin on this data. **That is one corpus on one machine and is not
sufficient evidence to fix a constant**; the implementation must re-measure and record what it chose and why.

## Decision 2 — replace topic-diversity with session-diversity

The second defect is that no cluster crosses the gate even with perfect grouping. The gate requires
`minSupport 4` **and** `minDistinctDaysPreference 2` **and** `minDistinctTopicsPreference 2`. The one
recurrent family clears support twelve times over and fails both diversity prongs: **1 distinct day, 1
distinct topic** — twelve records inside seventeen minutes.

**The prongs are not wrong and must not be removed.** Twelve remarks in one conversation is one occasion, not
twelve, and something has to stop a single moment's mood becoming a standing preference. Support alone is
trivially satisfied by a burst.

What is wrong is the **topic** prong specifically, as a proxy. It assumes an operator whose corrections are
spread across topics. **33 of 37 records come from a single topic**, because that is where this operator does
the work — so the prong is close to unsatisfiable regardless of how good the grouping becomes.

**Decided: keep `minDistinctDays`, replace `minDistinctTopics` with `minDistinctSessions`.** A session
boundary is a genuine context reset — the agent's memory is rebuilt — so recurrence across sessions carries
the same evidence topic-diversity was reaching for ("this is a standing preference, not one conversation")
without assuming a topic distribution the operator does not have.

Rejected alternative, and why: making the topic prong *conditional* on the operator's observed topic spread.
It adapts the bar to the data, which sounds attractive and is actually worse — the bar becomes a function of
behaviour the operator does not know is being measured, so the same correction promotes or does not depending
on unrelated activity. A fixed prong on a better axis is more honest than a moving one on the wrong axis.

`session_id` is already a column on `correction_records`, so this is a counting change rather than a schema
change.

## What is NOT decided here

- **The similarity threshold constant.** Argued to a band above; the implementation must measure and justify.
- **Whether to enable `correction-analyzer`.** It is disabled and has never run. It must stay disabled until
  both changes land — the finding's central warning is that enabling it alone yields a zero that reads as
  health.
- **Whether promotion would have prevented today's violations.** It would not have. The two operational
  facts violated on 2026-07-30 were already injected at session boot and were violated anyway. Injection is
  necessary and not sufficient, and that is a separate open question this design does not touch.

## Honest limits

Every number here comes from one machine's ledger over 28 days. The mechanism lives in shared code so the
defect is expected to generalise, but that is an inference. And this document decides a shape; it is not a
spec, has not been through convergence review, and should be read as the argued starting point for one
rather than as a settled design.
