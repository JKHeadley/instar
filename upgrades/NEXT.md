# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

Adds the first backward-compatible StandingDrive schema slice: an optional extension on server-owned autonomous run records, deterministic scope/action validators, exact local-authority checks, fail-closed breaker reads, ANY-source operator-stop folding, and revision-guarded extension mutations.

## What to Tell Your User

No user-facing StandingDrive execution is enabled yet. This release establishes the reviewed durable schema and safety validators that later slices will compose with existing continuation, revival, lease, and operation gates.

## Summary of New Capabilities

- Represent a StandingDrive without creating a parallel lifecycle store.
- Validate frozen action scope deterministically without a model call.
- Preserve plain autonomous-run behavior when no StandingDrive extension exists.

## Evidence

- 17 StandingDrive schema/validator/store tests and 15 existing AutonomousRunStore tests pass.
- TypeScript build and full repository lint pass locally.
