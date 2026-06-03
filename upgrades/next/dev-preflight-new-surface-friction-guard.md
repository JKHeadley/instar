# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Adds `instar dev:preflight`, a verify-only contributor preflight for PRs that touch new server
surfaces.

The command runs lint, runs the CapabilityIndex discoverability unit tests, and scans the diff
against main for newly added Express route registrations. If the scan sees a new top-level route
prefix that is not claimed in `CAPABILITY_INDEX`, it prints an advisory warning.

The route scan is intentionally not authority. It is a best-effort regex over added diff lines, not
an AST parser, and it never edits source. The command exits nonzero only when lint or the explicit
discoverability/CapabilityIndex test invocation fails.

The safe git funnel now also treats `git diff` as an explicitly allowed source-tree read-tier verb
when the caller opts into `sourceTreeReadOk`, so this preflight can inspect an Instar checkout
without bypassing `SafeGitExecutor`.

## What to Tell Your User

- **Instar has a contributor preflight for new surfaces**: "Before a PR, I can run a development
  preflight that checks lint, capability discoverability, and warns if a newly added route prefix may
  need a CapabilityIndex classification."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Developer preflight guard | `instar dev:preflight` runs lint, CapabilityIndex discoverability tests, and an advisory diff scan for unclassified new route prefixes. |
| Route-prefix warning heuristic | Added route registrations in the diff warn when their top-level prefix is absent from `CAPABILITY_INDEX`; warnings do not fail the command. |

## Evidence

Verification:

- Unit: route-detection heuristic covers missing prefix, existing prefix, no routes, and exit-code
  aggregation.
- Integration: fixture diff command path verifies the summary, warning output, and real-failure exit
  behavior.
- E2E: `dist/cli.js dev:preflight` exits clean on the current tree.
- Dogfood: `node dist/cli.js dev:preflight` ran lint, discoverability tests, and the route heuristic
  with exit 0.
- Docs: docs coverage passed after adding the CLI reference entry.
