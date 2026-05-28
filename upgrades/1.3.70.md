# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Two dogfood-surfaced fixes for `CollaborationRedriveEngine` (shipped in v1.3.66 via #490, dogfood-enabled on Echo today):

1. **Fingerprint-as-relatedAgent.** Many real `threadline-reply` commitments store the peer's 32-character hex fingerprint directly in `relatedAgent` (not a display name). The resolver now detects that case (`/^[0-9a-f]{32}$/i`) and uses the value directly as the routing address, normalising to lowercase. Falls through to the name lookup only for non-fingerprint strings. Without this fix, ~10 of 15 active commitments on Echo would skip with `unresolved-name` instead of nudging.

2. **Escalation flood.** The original `unresolved-name` path raised an Attention-queue item after 3 in-memory strikes per peer and reset the counter — producing a fresh "can't reach <peer>" item every few sweeps for every unresolvable peer (35+ items in <30 min observed on Echo). Replaced with a **durable per-peer 24h cooldown** persisted to `<knownAgentsDir>/collab-redrive-escalation-log.json`. At most one escalation per peer per `unreachableEscalationCooldownMs` (new config knob, default 24h). The log survives restart, so a server bounce does not re-flood.

## What to Tell Your User

- If you turned on collaboration-redrive and saw a flood of "can't reach X" attention items, that's fixed: at most one per peer per day, and a log file remembers across restarts so it doesn't reset.
- If I had open "I'm waiting on agent X" commitments where X was a raw fingerprint instead of a name, those will now resolve and nudge instead of skipping silently.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Fingerprint-hex as routing address | Automatic — no config required. Any `relatedAgent` matching `/^[0-9a-f]{32}$/i` is treated as a fingerprint. |
| Unreachable-escalation cooldown | Optional override: `monitoring.collaborationRedrive.unreachableEscalationCooldownMs` (default 86400000 ms = 24h) |

## Evidence

- Three new unit tests for the fingerprint case (`looksLikeFingerprint` accepts/rejects boundary cases; engine sends directly with empty `known-agents.json`).
- Three new unit tests for the cooldown (single escalation per peer; multiple same-peer commitments in one tick collapse to one; restart-survival via on-disk log).
- Combined Tier-1 test count: 19 → 27, all passing.
- Side-effects review: `upgrades/side-effects/collab-redrive-fp-as-relatedAgent-and-flood-fix.md`.
