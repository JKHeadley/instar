<!-- bump: patch -->

## What Changed

Instar now has a shared Jev-first path for bounded yes/no decisions. It records the full scrubbed context locally, Jev's confidence, the incumbent verdict when called, and why a case was handed off. Uncertain answers, errors, missing Jev credentials, and audit samples use the existing model path. The first connection is the commitment detector. It runs in shadow on development agents and stays off elsewhere, so Jev does not yet skip commitment checks.

A read-only `/jev-first/summary` route reports observed Jev calls, settlement share, errors, and disagreements. It leaves big-model token savings unmeasured until a live before-and-after comparison exists.

## What to Tell Your User

The first shared Jev-first path is ready for measurement. It is watching the promise detector on this development agent, while the usual model still decides every case. The summary will show actual work moved to Jev once a candidate passes a fresh quality test and goes live. No savings are claimed yet.

## Summary of New Capabilities

- A reusable, auditable Jev-first decision path with the existing model as fallback.
- A local summary of Jev calls and actual settled decisions.

## Evidence

Unit tests cover confidence bands, failure fallback, audit calls, provenance writes, one-provider operation, and migration awareness. Integration tests exercise the summary route and recorded decisions. The end-to-end lifecycle test boots the real server and scans a commitment with no Jev key. The first commitment replay missed its precision bar, so the shortcut remains in shadow.
