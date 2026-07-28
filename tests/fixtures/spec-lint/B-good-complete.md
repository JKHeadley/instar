---
title: "Fixture — a complete self-heal declaration (PASSES Standard B)"
---

# Fixture spec — a watcher with a fully-declared bounded self-heal

The maturation watcher detects a live-but-unregistered flag and self-heals before
it ever raises an operator item.

## Self-heal declaration

- class: recoverable
- max-attempts: 5
- max-wall-clock: 10m
- backoff: exponential (2s base, x2, cap 60s)
- dedupe-key: watcher-id + break-signature
- breaker: stop-and-surface after 3 heals of the same break within 30m (flapping)
- max-notification-latency: 300s
- audit-location: logs/maturation-watcher.jsonl (scrubbed, metadata-only)
- remediation-actions:
  - re-register-flag (idempotency: flag-id; compensation: none — set is idempotent)
  - restart-tracker (idempotency: tracker-pid guard; compensation: kill-then-respawn)
  - re-deliver-report (idempotency: report-id; compensation: dedupe on report-id)
