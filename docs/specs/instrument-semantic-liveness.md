---
title: "Instrument Semantic Liveness"
slug: "instrument-semantic-liveness"
author: "instar-codey"
status: "implemented"
approved: true
origin: "Echo mentor-lane finding, 2026-08-01"
---

# Instrument Semantic Liveness

## Problem

An instrument can execute on schedule while being unable to respond honestly to
the world. Two live mechanisms established the boundary:

1. A delivery canary collapsed a peer being unavailable and a reachable peer
   violating the typed delivery contract into the same hard failure.
2. Alignment scoring allowed any one legacy qualitative confidence value to
   poison the whole 30-day score, so new numeric rows could not repair the
   verdict until the old row aged out.

Repeated constancy is not sufficient evidence. An empty conflict register is a
negative control: it can remain empty indefinitely and is still live because a
real conflict would populate it. The predicate is semantic incapacity, not a
history pattern.

## Decisions

### 1. Source reporting, not a central guesser

Script instruments may emit one final line beginning with
`INSTAR_INSTRUMENT_ASSESSMENT=` followed by JSON. The scheduler validates and
preserves the report in job state. It never infers a verdict from repeated
output, and it never treats process exit status as proof that a measurement was
available.

The report contains:

- `status`: `assessed` or `unassessable`;
- `verdict`: `pass`, `fail`, or `none` (only `none` is valid when unassessable);
- a nonempty source-owned reason;
- `populationSize`, `sampleSize`, and `excludedSampleSize`;
- named exclusion counts and exact `sampleCoverage`.

The parser rejects inconsistent totals, coverage, or status/verdict pairs. An
ordinary script that emits no marker remains an ordinary script.

### 2. No global N floor

There is no run-count threshold. No value of N can prove semantic incapacity:
the conflict register can correctly report the same outcome for a million runs,
while a broken canary can collapse distinct states on its first run. History may
support an advisory investigation, but authority comes from the source contract
and its declared cohort.

### 3. One cohort for a composite

Alignment uses only decisions with measurable numeric confidence as one common
cohort for all four components. Rows with missing or invalid confidence are
excluded from conflict freedom, confidence, principle consistency, and journal
health alike. This prevents a remedy from introducing mixed denominators.

The API publishes both sides: `sampleSize` is the measured cohort;
`populationSize` is every row in the period; exclusions are split into missing
and invalid confidence; and `sampleCoverage` makes partial evidence explicit.
If the common cohort is empty the response stays honestly unassessable. Once one
valid row exists, valid new input can move the score immediately without
rewriting legacy data or inventing a numeric meaning for qualitative labels.

### 4. Availability is not conformance

The live delivery canary classifies each peer arm as assessed or unavailable.
A reachable, typed mesh response is assessed and may pass or fail. A transport
error or an untyped edge/gateway HTTP response is excluded and lowers coverage;
neither creates a delivery-contract finding or a retry-triggering nonzero exit.
The local registry arm remains measured, so the suite can report a partial
assessment without calling every peer reachable.

### 5. Retry convergence is independent

Script job retries retain their episode counter across `retry:*` triggers. A
fresh cron or explicit trigger begins a new episode; successful subprocess
completion clears it. Entering `pending` also preserves the durable consecutive-
failure streak; only real success resets that counter. A persistent script
failure therefore follows the six declared delays and stops until the next cron
window instead of resetting to the one-minute delay forever.

## Compatibility and rollback

All fields are additive except the clarified alignment `sampleSize` meaning. It
now means the cohort actually scored; consumers needing the old population
count use `populationSize`. Existing journal rows remain untouched. Scripts that
do not opt into the marker protocol behave exactly as before. Code rollback is
safe; no persistent migration is required.

## Verification

- Parser tests accept assessed and unassessable reports, reject incoherent
  source claims, and use repeated empty conflicts as the negative control.
- Scheduler tests preserve source reports and prove a persistent script failure
  stops after six escalating retries.
- Alignment tests prove legacy invalid/missing rows cannot darken valid new
  input and prove every component uses the same cohort.
- The live Echo canary source was syntax-checked after adopting unavailable
  exclusions and the source-reported field. Its real peer probe classified a
  live HTTP 530 edge response as unavailable, reported 1/2 measured coverage,
  emitted no finding, and exited zero.
