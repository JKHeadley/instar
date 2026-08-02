# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Cartographer now has an inert verified-root authority that separates explicit
root selection from repository verification and paid authoring permission. It
distinguishes the agent home, the active project checkout, and the Instar source
checkout; records the canonical path, remote identity, and exact revision; and
refuses contradictory repository evidence. A selected root without a readable
Git revision remains eligible for structural hierarchy maintenance but cannot
authorize paid semantic work.

Cartographer state can also be isolated by an authority-minted root namespace,
preventing two verified projects from sharing one index. Existing runtime
behavior and the legacy state location remain unchanged until the live consumer
lands separately.

## What to Tell Your User

- “This release lays the verified-root foundation for project-aware
  Cartographer navigation. It does not change live navigation yet.”
- “Structural project maps remain available when Git revision information is
  unavailable, while paid authoring stays withheld until the root is verified.”

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Explicit root selection by provenance | Available to the upcoming live Cartographer consumer |
| Canonical repository and revision verification | Automatic whenever the new authority is invoked |
| Structural-only degradation for missing Git identity | Automatic; paid authoring remains off |
| Per-root Cartographer state isolation | Supply an authority-minted root namespace when constructing a tree |
| Structured trust-decision evidence | Bind the required recorder to a durable machine-local log |

## Evidence

Twenty focused root-authority tests and fourteen legacy tree tests cover noisy
agent homes, real Instar source-tree verification, stale lookalikes, explicit
port mismatches, missing Git revisions, revision drift, namespace isolation,
structured decision evidence, and fail-closed recorder behavior. The full
Cartographer unit set passes 121 checks. TypeScript, repository lint, build, and
diff validation also pass, and an independent second-pass reviewer concurred
after all trust-boundary findings were fixed.
