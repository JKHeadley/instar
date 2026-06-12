# Upgrade Guide — Dashboard: idle machine vs broken machine, finally distinguishable

<!-- bump: patch -->

## What Changed

The dashboard sessions view rendered NOTHING for a pool machine with zero running
sessions — visually identical to a machine that is offline or unreachable. Live
incident 2026-06-12 (topic 13481): minutes after the pool-tile status filter shipped,
an idle-but-healthy Mac Mini disappeared from the sessions view entirely and the
operator reasonably read it as a regression.

The sessions view now renders an explicit state row for every pool machine that has
no session tiles: **"online — no active sessions"** when its heartbeat is live, or
**"not reachable — last seen <t>"** when it is not. Data comes from the existing
`GET /pool` machine inventory on the existing 15-second pool poll — no new routes, no
server changes. Machines that have session tiles get no redundant row (their tiles
already carry the machine badge). Pool disabled or single-machine: the strip is never
rendered — strict no-op, locked by test. This is WS4.2 of the converged
multi-machine-seamlessness spec (`docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md`,
3-round convergence, 91 findings addressed), whose audit and ELI16 companion ship in
this same PR.

## What to Tell Your User

- "Your dashboard's session list now tells you the state of every machine, even the
  quiet ones — an idle machine says 'online — no active sessions' instead of showing
  nothing, so you can always tell a resting machine from a broken one."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-machine empty-state in the sessions view | Automatic — open the dashboard sessions list on any multi-machine pool |

## Evidence

- New test file `tests/unit/dashboard-machineEmptyState.test.ts` (6 tests, at-rest
  HTML/JS assertions following the established dashboard test pattern) — proven
  failing 6/6 against the pre-change file, all pass on the fix. Covers: the
  single-machine no-op gate, both honest state strings, the zero-sessions branch,
  no-duplicate-rows reconciliation, no redundant rows for busy machines, and HTML
  escaping of machine-provided strings.
- `tests/integration/pool-routes.test.ts` extended to lock the `/pool` contract field
  (`selfReportedLastSeen`) the strip consumes.
- Side-effects artifact: `upgrades/side-effects/multi-machine-seamlessness-ws42.md`.
- Spec: `docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md` (converged + approved) with
  convergence report `docs/specs/reports/multi-machine-seamlessness-convergence.md`.
