# Include commitments in measurement coverage

## What Changed

The existing measurement census also reads the commitment tracker. Separate
origin/id identities prevent collisions, and missing sources remain explicit.
The shared view uses identifiers and status without copying conversation text.

## What to Tell Your User

The measurement view includes tracked promises as well as initiative work items.
Its counts are tracking records: linked records can refer to the same work, and
a record without measurements remains a visible gap.

## Summary of New Capabilities

- Commitment records appear in the existing coverage read.
- Counts distinguish tracking records from distinct outcomes.

## Evidence

Focused tests cover identity collisions, missing sources, privacy, unchanged
measurement binding and bounded large inventories. An actual AgentServer test
creates an isolated commitment through the existing API and reads it through
the real board route. No production samples or new control authority are added.
