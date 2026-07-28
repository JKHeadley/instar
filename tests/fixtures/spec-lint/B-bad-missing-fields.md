---
title: "Fixture — self-heal declaration missing required brakes (FAILS Standard B, rule B1)"
---

# Fixture spec — a watcher with an under-declared self-heal

## Self-heal declaration

- class: recoverable
- max-attempts: 5
- remediation-actions:
  - re-register-flag

(Missing: max-wall-clock, backoff, dedupe-key, breaker, max-notification-latency,
audit-location — an unbounded heal is exactly the compounding-loop failure P19 forbids.)
