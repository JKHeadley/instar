# Throughput counts now name their time window

## What Changed

The deliverable-completion factor now carries explicit window metadata on both blocker-lifecycle reads. Summary identifies its rolling-hour scope; trend identifies its rolling-day scope, UTC buckets, and partial current day. Pool reads preserve and validate the labels.

## Evidence

Focused unit, pool-integration, and authenticated real-server E2E coverage verifies the exact labels alongside unchanged completion counts.

## What to Tell Your User

The summary and trend counts may differ because they deliberately use independently selected windows. Each result now states its own window beside the number, so a 24-hour zero and a seven-day ten no longer look like contradictory measurements.

## Summary of New Capabilities

Blocker-lifecycle completion counts are self-describing across local and multi-machine reads.
