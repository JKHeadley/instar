# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

Solo Codex agents now feed real rollout quota windows into the global job/session load-shed brake.

## What to Tell Your User

A solo Codex agent stops starting work when its five-hour or weekly account window is exhausted. Missing, stale, unreadable, or incomplete Codex quota data now pauses new work conservatively instead of failing open into an unknown wall.

## Summary of New Capabilities

- Authoritative `codex-rollout` quota state for the global brake.
- Healthy Codex windows allow work; exhausted windows shed it.
- Missing or invalid Codex readings persist explicit uncertainty and fail safe.
- Existing Claude OAuth-authoritative and JSONL-degraded behavior remains unchanged.

## Evidence

Scoped unit coverage exercises both sides of the gate and every uncertainty boundary. Collector-to-manager integration proves persisted wall shedding and replacement of prior healthy headroom when the reader disappears. Full lint, build, and CI matrix gate release.
