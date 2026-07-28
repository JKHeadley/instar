# Guard inspectability summary — Plain-English Overview

> The one-line version: the guard-health readout now says when a critical protection cannot be inspected, instead of letting an empty gap list look like proof that every critical path is protected.

## The problem in one breath

The guard inventory has a list of load-bearing guards that are silently unguarded. That list is intentionally narrow: a missing, errored, stale, or runtime-contradicting guard is already alarming under its own posture class, so adding it to the gap class would produce two alarms for one problem. But the read surface did not explain that distinction. A reader could see an empty gap list and honestly conclude that no critical path was unguarded even though a load-bearing guard could not be inspected at all.

## What already exists

- **Guard posture rows** — classify each guard as confirmed, stale, missing, errored, off, dry-run, or runtime-divergent.
- **Load-bearing gap list** — names critical guards that are silently off by default or stuck in dry-run past their soak window.
- **Guard posture probe** — alarms missing, errored, stale, and runtime-divergent guards under their existing classes, without duplicating a load-bearing-gap alarm.

## What this adds

The summary returned by the guards read endpoint gains a separate list of load-bearing guards whose posture is uninspectable. The list contains only the four existing loud classes: missing, errored, stale while on, and enabled in configuration while reporting off at runtime.

This is additive observability. It does not change a guard row's classification, enable or disable any guard, alter the load-bearing gap definition, or create another probe anomaly.

## The safeguards

**Prevents a false all-clear.** A clean gap list can now be read beside the uninspectable list, so absence from one class is not mistaken for proof of complete inspection.

**Prevents double-alarming.** The probe remains unchanged. A load-bearing guard with an errored getter still produces one existing errored anomaly and no load-bearing-gap episode.

**Refuses regression at every live seam.** Unit coverage proves all four allowed postures and the no-double-alarm rule. Integration and end-to-end coverage call the real authenticated guards route and require the new list to survive the response.

## What ships when

One additive summary field ships with the existing guards endpoint. Older consumers can ignore it; consumers that need an honest critical-path reading can use it immediately.

## What you actually need to decide

Does the PR preserve the existing classification and alarm behavior while making incomplete load-bearing inspection explicit?
