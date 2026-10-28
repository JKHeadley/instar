---
bump: patch
---

## What Changed

The decision-quality read view now includes a separate, read-only section for
scheduled script-result supervision. It reads direct Jev and outage-replacement
call records from the durable job-supervision journal and checks their coverage
against independent job-run history. The section shows provider/model, prompt
hash, verdict, cost, and later independent grade for each call, with missing
records and unknown grades visible. Pool reads strip peer data to a small
allowlist. These direct calls are not counted as IntelligenceRouter decisions.
Jev result decisions remain off.

## What to Tell Your User

The audit view can now show each Jev check of a scheduled script result, its
cost, and whether later evidence showed it was right. Missing records are
visible instead of making the accuracy number look better. This prepares the
quality review; it does not switch on Jev decisions yet.

## Summary of New Capabilities

- Read `directJobSupervision` from `/decision-quality` for a local call audit.
- Use `?scope=pool` to see which machines supplied that audit and which did not.

## Evidence

Unit tests check missing-record denominators, per-call identity, independent
grade linkage, and privacy. Authenticated route tests check local data and
hostile peer stripping. A production-shaped lifecycle test checks the section
is alive with a real scheduler and journal. The full suite and CI are release
gates.
