# Upgrade Guide — Local History Store Content Plans

## What Changed

The private history store can now prepare one opaque, writer-bound content plan before an append or manifest replacement. Execution enforces the exact serialized-content ceiling before writing. Existing conversation writes share that serialization path. Attachment first publication uses an exclusive temporary file and atomic first-name link.

This is a dormant foundation. It supplies no copy consent, real disk reservation, claim-database accounting, apply worker or app import action. Those remain tracked in topic143810. <!-- tracked: topic-143810 -->

## What to Tell Your User

“I have added a safeguard that checks how much conversation content a local-history write will produce before it starts. Importing through the app is still being built; this update does not turn it on.”

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Exact content-size plans for local-history writes | A foundation for the upcoming import flow. There is no new control to use yet. |
| Explicit recovery evidence for failed temporary writes | Internal handling preserves unresolved files instead of silently assuming nothing was written. |

## Evidence

Focused real-store checks cover exact UTF8 content, torn-tail separators, whole manifest replacement, insufficient ceilings, wrong/reused/stale plans, changed destination files and opened inodes, reentrant serialization, duplicate overflow and reconciliation after a real interrupted append. Existing source-ownership checks pass. Complete frozen-head verification remains with the coordinator; no release or full-import readiness is claimed.
