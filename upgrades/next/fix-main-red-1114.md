# Main CI green again: route docs over their floor, own-suite probe no longer measures the host

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Two checks held every pull request on main.

Docs Coverage failed at route coverage 54% against a 55% floor. Twenty-two routes that were in no doc are now documented from their handlers, in a new reference page (`site/src/content/docs/reference/ledger-and-request-routes.md`, linked from the sidebar) and in the full route inventory of `reference/api.md`: the Blocker Ledger and Self-Unblock checklist runs (7), operator authorization requests (6), the Failure-Learning Loop reads (3) and the framework-issue ledger (6). Route coverage is now 56.6% (57% rounded).

`tests/integration/test-runner-bound-meta.test.ts` case (d2) failed on every GitHub run with "expected 3 to be greater than 4". The case checks that a Local Verify unit lane (a child the slot holder declared as its own suite) is not clamped to 4 workers, by measuring more than 4 probes running together. The child was started without a worker count, so its pool was vitest's default, CPU count minus 1: 15 on the Mac where the case was written, 3 on a 4-core GitHub runner. The run log shows exactly that: three probes held until the 4-second barrier deadline, then the last two ran. The code under test is unchanged and correct; the case measured the host. The child now asks for 5 workers (Local Verify likewise always asks its unit lane for an explicit count). A wrongly clamped child still measures at most 4, because the nested clamp outranks a command-line worker count (the existing CLI-proof case shows it), so the assertion still tells clamped from unclamped, on any host.

## Evidence

- `node scripts/docs-coverage.mjs --check`: route 57% (56.64% exact: of 1047 routes, 316 are in two or more docs, and routes in one doc count half), check passed. Before: 54% (54.35%).
- Case (d2) under a shim that makes vitest see 4 CPUs (as on a GitHub runner): fails with "expected 3 to be greater than 4" before the change, passes after. Whole file passes on the Studio after the change.
