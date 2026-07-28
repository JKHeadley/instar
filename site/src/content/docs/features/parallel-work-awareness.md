---
title: Parallel-Work Awareness
description: A cross-topic activity index and an overlap councilor so an agent knows what all its hands are doing at once.
---

When an agent runs across many topics and sessions at once, it can lose track of what its
"other hands" are doing -- and start work in one topic that another topic already finished.
Parallel-Work Awareness is the antidote: it lets the agent see, in one place, what every
topic is currently working on, and (proactively) notices when two topics overlap.

It is built deliberately as a thin layer over the existing Topic-Intent data -- it does
**not** introduce a new per-topic store. The whole feature is signal-only: it never gates,
blocks, or mutates anything; it only informs.

## The cross-topic index (`ParallelActivityIndex`)

The `ParallelActivityIndex` is a read-only aggregator over the per-topic intent files. For
each topic it derives a one-line current `focus` (from the topic's stated goals/decisions),
a set of high-specificity `tags` (entities, file paths, identifiers -- generic boilerplate
is stripped so two topics that both say "fix the test" do not look alike), how fresh the
topic is, and whether a session is live on it. The `ParallelActivityIndex` exposes this as a
`TopicActivity` list through the read endpoint:

```bash
curl -H "Authorization: Bearer $AUTH" "http://localhost:4042/parallel-work/activities"
```

The response is `{ count, runningCount, activities: [{ topicId, focus, tags, running, updatedAt }] }`.
Because the `ParallelActivityIndex` reads existing Topic-Intent state, there is no new write
path to remember and nothing to migrate.

## The overlap detector (`ParallelWorkOverlap`)

`ParallelWorkOverlap` is the pure logic that decides whether two topics are genuinely working
on the same thing. To avoid a noisy councilor (a false-positive nudge is worse than silence),
`ParallelWorkOverlap` applies several containment rules: an **activity gate** (only recently
worked-on topics are compared), **IDF/specificity weighting** (a shared *rare* term like a
component or file name counts far more than a generic word), a requirement of at least one
shared high-specificity tag, and strict self-exclusion. Each detected `OverlapPair` carries
the shared tags and a stable signature; `ParallelWorkOverlap` also provides the hysteresis
helper that keeps a slowly-evolving focus from re-firing the same overlap.

## The councilor (`ParallelWorkSentinel`)

The `ParallelWorkSentinel` is the proactive part -- the willpower-trap fix. Instead of relying
on the agent to *remember* to check the index, the `ParallelWorkSentinel` ticks on a cadence,
runs `ParallelWorkOverlap` over the current activities, and emits exactly one `OverlapNudge`
per genuinely-fresh overlap. A pair-keyed cooldown plus signature hysteresis means the
`ParallelWorkSentinel` never re-nags about an overlap you have already seen and never
stampedes. It is a signal-only `EventEmitter`: the nudge informs, and the agent decides.

The `ParallelWorkSentinel` ships **dark** -- it is off by default (`monitoring.parallelWorkSentinel.enabled`)
and graduates only after it is shown to be quiet. When on, every transition (nudged, deduped)
is audited to `logs/sentinel-events.jsonl`, and a nudge surfaces to the user as a calm
councilor heads-up.

Spec: `docs/specs/parallel-activity-coherence.md`.
