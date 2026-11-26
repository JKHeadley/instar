---
title: Measurement Evidence
description: Read outcome contracts, independent coverage, retained methods and explicit gaps without mistaking activity for improvement.
---

Measurement explains what an effort intends to change and what evidence supports its results. A completed job, a busy feature or a successful test is not by itself an improvement verdict. These views are advisory; they do not grant permission to promote a feature or change its configuration.

## Start with coverage

The independent inventory view compares existing feature, decision, job, effort and capability registries with their declared measurements. `MeasurementCoverage` owns this read projection, rather than creating another registry. A missing link, invalid contract, stale evidence, ambiguous subject or unavailable inventory stays visible. Source completeness means the inventories answered; it does not mean every useful outcome has been measured.

Work-item counts include initiative records and records from `CommitmentTracker`.
Several records can describe the same work; this is not a count of unique
improvement efforts. Commitment identifiers retain their source origin and
status, without sharing conversation excerpts. These records currently have no
measurement-subject link and cannot borrow an initiative's proof. Adding a source
changes the census denominator; it is not itself evidence of improvement or
regression.

`MeasurementSubject` binds generic measurements to their declared subject and origin. Generic effort and job plans use the existing initiative owner. A capability uses its existing inventory identity; decision-quality plans use the existing canonical decision grades. Identical names on different subjects do not make their evidence interchangeable. Parent links come from existing initiative, accounting and ladder composition relationships. A parent's good result cannot supply missing component evidence.

## Read an outcome

`MaturationOutcome` projects an optional outcome contract's intended result, baseline, method version, required samples and quality safeguards alongside current evidence. Foreign-origin, future, stale, before-baseline and insufficient-sample evidence do not become verified comparisons. A measurement contract is a declaration; it is not proof that the baseline was captured before an intervention.

`FeatureMetricsLedger` retains the feature telemetry and canonical winning decision grades. The decision adapter reads those grades instead of inferring correctness from activity. `BenchmarkDivergenceAnalyzer` separately checks evidence health such as sample floors, unknown or orphan shares, maturity lag and review cadence. Neither a passing activity threshold nor a quiet benchmark establishes an improved outcome.

## Read retained history

`BlockerLifecycleLedger` remains the observation and evaluation store. `BlockerLifecycleService` exposes its bounded summary and trend reads at `GET /blocker-lifecycle/summary` and `GET /blocker-lifecycle/trend`. Historical status totals count evaluations. `latestByStatus` counts each evaluated feature's latest retained result within the requested window; it is not the denominator of all installed features. Use independent coverage for that denominator.

The history read includes when an evaluation was due, when it ran, its evidence time, contract identity, rung, metric count and missed slots. A matching adjacent contract and rung does not prove cadence continuity. Older peers may lack these fields; unavailable detail remains a gap.

`MeasurementTrend` keeps numeric samples bound to their source, origin, method and exact evaluation. A changed policy, rung or incompatible capture breaks a line rather than implying continuity. Omitted-point counts distinguish a bounded response from complete history. `MeasurementContractVersion` retains full immutable method definitions for referenced versions when available, with explicit missing, unreadable or omitted definitions. A hash alone is not a readable historical method.

## What the view cannot decide

`MaturationLadderService` retains the existing ladder and move owner. The outcome views do not install a universal promotion floor, capture a production baseline automatically, or enforce the meaning of every conversational improvement claim. Missing evidence must remain visible, and ordinary services remain available. A recurring reviewer can use these signals to investigate and act within its existing authority; its existence alone is not evidence that the effort improved.

Retained evidence is bounded. Limits and omissions are part of the result, not permission to manufacture samples or treat an unreadable source as healthy. When comparing machines, read the selected origin explicitly and preserve each source's failures.
