# Codex task self-continuation

## What Changed

Codex agents can now keep ordinary multi-step work moving across turn boundaries from an explicit, bounded per-topic checklist. The existing trusted Stop hook continues only while unchecked tasks remain and stops immediately for an operator stop, disable switch, expired duration, turn ceiling, or invalid state.

## Evidence

Focused store and real-hook tests cover exact task parsing, first-turn ownership binding, empty-list completion, session mismatch, generation-ordered operator stop, duration and turn ceilings, state tampering, dark rollback, audit privacy, and Codex-safe Stop output.

## What to Tell Your User

Long multi-step Codex work no longer has to wait for another nudge after every response. It keeps going from an honest checklist and stops cleanly when the list is done or you stop it.

## Summary of New Capabilities

- Two independent bounds prevent runaway continuation.
- Operator stop ordering does not depend on machine clocks.
- Decisions are audited without storing task prose or raw session identifiers.
- The feature ships off by default and can be disabled without restarting.
