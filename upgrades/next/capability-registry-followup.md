# Capability registry manifest provenance

Manifest-derived capability rows now carry their manifest verification timestamp, activating the existing manifest-staleness status path. The adapter test no longer pins one model identifier.

## What Changed

The local registry now records when the reviewed doorway manifest was verified. That timestamp feeds the existing freshness calculation, allowing an old manifest to be classified as stale instead of appearing current. Tests remain resilient when the reviewed manifest rotates model names.

## What to Tell Your User

This is an internal reliability improvement. The agent can now tell when its local doorway catalog is old, while normal capability discovery and all user-facing routes remain unchanged.

## Summary of New Capabilities

Registry freshness can now detect stale canonical manifest evidence.
