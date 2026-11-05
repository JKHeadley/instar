<!-- bump: patch -->

## What Changed

Adds the unwired core of the Conversations hierarchy (docs/specs/conversation-effort-hierarchy-v3.md): typed conversation and effort references, an event validator, a deterministic reducer that only trusts events whose authority receipt is verified and never lets an agent placement displace an owner's, a projection that filters by viewer before it counts or searches, an append-only event file, and an erasable store for effort titles. Nothing calls it yet, and no route, setting or screen changes.

## What to Tell Your User

Nothing changes for you yet. This is groundwork for a future Conversations view that groups your topics under the work they belong to; it stays switched off and hidden until the parts that keep it identical on every machine are finished and proven.

## Summary of New Capabilities

None user-facing. Internal building blocks for the Conversations hierarchy: NodeRef identity, receipt-first graph reduction, viewer-filtered projection, a durable event file, and erasable effort headers.

## Evidence

36 unit tests across the three modules pass, including regressions for six reducer defects found in an executable review of the first draft (owner precedence, common-ancestor conflict, cycle authority, All reachability, held predecessors, effort-under-conversation). All 51 pre-commit lint steps pass.
