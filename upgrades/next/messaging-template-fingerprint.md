# Automated messaging template fingerprints

## What Changed

Automated tone-gate decisions now carry a stable template fingerprint and verdict in the existing provenance rows.

## What to Tell Your User

Repeated automated messages can now be measured as one template family, showing consistency and repeated LLM spend without changing delivery behavior.

## Summary of New Capabilities

- Volatile-span normalization for ids, numbers, and timestamps.
- Deterministic SHA-256 template fingerprints.
- Observe-only provenance fields for automated tone-gate verdicts.
