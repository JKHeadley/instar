# Capability registry Increment 0

## What Changed

Added the dark, local-only capability-registry schema, validation funnel,
doorway/manifest and scan-state adapters, deterministic digest serializer,
status derivation, and atomic self-projection writer.

## What to Tell Your User

This increment is intentionally unmounted: no route, peer traffic, mesh verb,
heartbeat emission, or routing consumer was added.

## Summary of New Capabilities

- Bounded v6 projection envelope with closed enums and width clamps.
- Real local doorway manifest and scan-state source adapters.
- Deterministic fact digest, conflict-aware status matrix, and atomic writer.
