# Instar Upgrade Guide

## What Changed

- Added Migration-Consumer Completeness as a constitutional standard.
- Added a contract registry and lint that require canonical migration producers, consumers, and validators to move together.
- Enrolled Threadline's canonical inbound store and reply-validation boundary as the first protected contract.

## What to Tell Your User

Instar's internal migrations now carry a stronger completion check. When one component becomes the new source of truth, the development process verifies that every declared authorization and validation consumer moves with it, reducing failures where half the system uses the new authority while another half silently uses the old one.

## Summary of New Capabilities

- Canonical migrations have an explicit, reviewable producer/consumer/validator contract.
- Local commits and CI refuse producer-only migrations that leave declared consumers or validators behind.

## Evidence

- `docs/STANDARDS-REGISTRY.md` — Migration-Consumer Completeness.
- `scripts/lint-migration-consumer-completeness.js`.
- `tests/unit/migration-consumer-completeness-lint.test.ts`.
