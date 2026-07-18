# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

Adds StandingDrive Slice 2: a closed deterministic action-derivation authority with auditable matched-rule and decision digests, safe project-relative path-prefix evaluation, fail-closed malformed-input handling, and cross-machine-stable rule selection.

## What to Tell Your User

StandingDrive still does not execute actions yet. This release makes its frozen-scope decision mechanically auditable and proves that a merely related action cannot expand the operator-authorized envelope.

## Summary of New Capabilities

- Produce a stable, audit-grade derivation result from a frozen drive envelope.
- Permit approved project-relative descendants without allowing traversal or absolute-path escape.
- Hold malformed, future-version, wrong-phase, non-enumerated, and constraint-mismatched requests without a model call.

## Evidence

- 30 focused StandingDrive schema and derivation tests pass; 50/50 combined with store and no-silent-fallback regressions.
- TypeScript build and full repository lint pass locally.
