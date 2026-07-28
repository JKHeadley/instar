---
title: "Fixture — no-op remediation + unitless latency + unknown class (FAILS Standard B, rules B2/B3/B4)"
---

# Fixture spec — a self-heal that games the escalation gate

## Self-heal declaration

- class: minor
- max-attempts: 5
- max-wall-clock: 10m
- backoff: exponential
- dedupe-key: watcher-id
- breaker: stop after 3 flaps
- max-notification-latency: 300
- audit-location: logs/x.jsonl
- remediation-actions:

(remediation-actions is empty — the no-op that flips selfHealAttempted=true without
doing anything; max-notification-latency is a bare number with no units; class is
not a recognized severity class.)
