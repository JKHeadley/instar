---
title: Jev-first decision path
status: draft
owner: Echo
created: 2026-11-03
---

# Jev-first decision path

## Problem and evidence

On Echo in the seven days to 3 November, internal checks used about 484 million input and output tokens. Jev used roughly 4 million, mostly adding new checks rather than replacing larger-model work. The most expensive existing decision points are the outbound message gate (117 million), self-stop gate (60 million), topic-intent arc check (59 million), and completion-claim verifier (57 million). The shared `JevCascade` already selects uncertain answers for a referee, but each caller still builds its own HTTP request, logging and fallback. A common decision path must let Jev settle bounded, measured questions, and always use the incumbent when Jev cannot safely decide.

## Decision and authority

The registered decision point remains the sole authority. Jev may be its first model only after that point passes its own shadow replay bar. A low-context detector never gains a separate block path. The point declares its full question, context builder, direction-aware confidence band, output mapping, incumbent model call, and promotion stage. A hard-block check cannot promote while any confidently unsafe clear remains in its prespecified sample. Jev's answer is a model judgment over the same bounded state the incumbent would see, not a regex or score threshold acting without context.

## Shared call contract

- Stable point id and prompt version, pinned Jev model, question set and per-question yes/no bounds. A `cannot-tell` or unparseable answer is uncertain.
- The caller supplies the complete relevant state. Secrets are scrubbed before external transmission. Oversize or scrub failure routes to the incumbent and records why; no silent truncation.
- On an enabled point with a Jev key, call Jev within a bounded deadline. All confident answers may settle only if every required question is covered. A point that needs structured details from the incumbent may declare only the safe yes or no direction as settleable; the other direction invokes the incumbent even when Jev is confident. Any uncertain, missing, late, malformed, or wrong-model answer invokes the incumbent's existing call. A random, recorded audit share also invokes the incumbent and uses the incumbent verdict if they disagree.
- With no Jev key, or with the point disabled, call the incumbent exactly as before. A one-provider agent continues delivering the feature.
- The incumbent route is selected from a fresh, task-matched Instar benchmark when available. If there is no usable benchmark for that exact task and prompt, retain the point's current model and mark the benchmark gap in each record; never invent benchmark support.

## Records and review

Use `JudgmentProvenanceLog` for one local, bounded, secret-scrubbed full-context row per decision. Put the content under `_contentFull` so the served redacted projection and peer replication cannot contain it. The row also records question version, all Jev probabilities, stage, band, call times, handoff reason, incumbent model/verdict, final verdict, audit disagreement, and outcome link or named grading gap. A write failure is visible in metrics; the path falls back to the incumbent if it cannot record the context needed to audit a Jev-settled decision. Existing decision-quality correlation ids connect later outcomes.

A read-only aggregate reports for each point: total calls, Jev-settled share, handoff share and reasons, audited disagreement, measured model tokens avoided, error rate, and sample size. It must distinguish observed saved tokens from estimates. The twice-weekly Jev review consumes this aggregate, tunes the weakest point on held-out rows, advances a candidate, and scans new LLM call sites.

## Rollout and reversal

The shared path ships dark. Each point progresses from shadow to Echo-live only after prespecified quality and coverage bars pass on real rows. Fleet stays dark. A live, per-point switch returns to the incumbent immediately without a restart. A Jev outage or missing key automatically takes the same route. Config and template changes migrate idempotently to existing agents, and the agent template explains the capability.

The first commitment replay missed its bar. Its factory therefore clamps a requested `live` stage to `shadow` in code. A future promotion requires a code change with the held-out batch evidence, so a config edit alone cannot grant it authority.

## Required tests

Unit: direction-aware bands, no-key and every failure fallback, audit sampling, model mismatch, oversize context, record failure, and exact decision metadata. Integration: a real point through HTTP routes records a joined decision and reports aggregate savings; one-provider flow returns the incumbent verdict. E2E: production boot with no Jev key keeps the feature alive; Echo dev flag reaches the real gateway, metrics and provenance dependencies are non-null. Replay each promoted point on a held-out corpus with both positive and negative labels, including the safety direction and a fixed threshold before scoring.
