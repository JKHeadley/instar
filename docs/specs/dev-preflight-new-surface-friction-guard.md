---
approved: true
review-convergence: "single-author-code-grounded-2026-06-03"
parent-principle: "Structure beats Willpower"
eli16-overview: dev-preflight-new-surface-friction-guard.eli16.md
---

# Dev Preflight New-Surface Friction Guard

## Problem

The CapabilityIndex discoverability lint already prevents a new route prefix from shipping without a
classification. The miss still shows up late: an author can forget the classification, run unrelated
tests, and only learn about it when the full lint/test path trips. That creates avoidable review
friction on every new surface.

## Design

Add a developer-only CLI command: `instar dev:preflight`.

The command is verify-only. It never mutates source, never edits `CAPABILITY_INDEX`, and never gates
the server. It runs:

- `pnpm lint`
- `npx vitest run tests/unit/capabilities-discoverability.test.ts tests/unit/CapabilityIndex.test.ts`
- a best-effort diff heuristic against main that scans added lines for Express route registrations
  like `app.get('/prefix')` or `router.post('/prefix')`

The heuristic extracts the top-level route prefix and warns when the prefix is absent from
`CAPABILITY_INDEX`. It is intentionally regex-based rather than AST-based: the goal is early
friction, not authority. The canonical guard remains the discoverability tests.

## Exit Semantics

The command exits nonzero only when lint or the discoverability/CapabilityIndex test invocation
fails. Route-prefix findings are advisory warnings and must not block a PR by themselves.

## Constraints

- No source mutation.
- No automatic CapabilityIndex edits.
- No server runtime gate.
- No route-heuristic failure exit code.
- Diff lookup failure only warns; it does not make the command fail.

## Verification

Unit tests cover route detection, missing-prefix warnings, existing-prefix cleanliness, no-route
cleanliness, and exit-code aggregation. Integration tests run the command against fixture diff data
and verify summary/exit behavior. E2E exercises `dist/cli.js dev:preflight` after build on the
current tree.
