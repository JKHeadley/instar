<!-- internal-only -->
# Upgrade Guide — Local History Store Content Plans

## What Changed

The private history store can now prepare one opaque, writer-bound content plan before an append or manifest replacement. Execution enforces the exact serialized-content ceiling before writing. Existing conversation writes share that serialization path. Attachment first publication uses an exclusive temporary file and atomic first-name link.

This is a dormant foundation. It supplies no copy consent, real disk reservation, claim-database accounting, apply worker or app import action. Those remain tracked in topic143810. <!-- tracked: topic-143810 -->

## Evidence

Focused real-store checks cover exact UTF8 content, torn-tail separators, whole manifest replacement, insufficient ceilings, wrong/reused/stale plans, changed destination files and opened inodes, reentrant serialization, duplicate overflow and reconciliation after a real interrupted append. Existing source-ownership checks pass. Complete frozen-head verification remains with the coordinator; no release or full-import readiness is claimed.
