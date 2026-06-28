## What Changed

Mesh Self-Heal **G2 — core decision logic** (increment 1 of the nobody-serving alarm, `MESH-SELF-HEAL-SPEC` §3.2). Adds `src/core/nobodyPollingRecovery.ts`: the PURE, deterministic decision core for the silent-loss backstop — when NO machine is polling Telegram (the zombie-lease-holder state behind the message-drop incidents), exactly ONE fit machine must take over, never zero (drops), never two (the 409 poll-war).

- `electPollClaimant` — deterministic single-claimant election (F4-preferred-awake if fit, else lowest-machineId fit). Machine-agnostic: every machine elects the SAME claimant, which is the structural defense against split-brain double-claim.
- `decideNobodyPollingClaim` — reduces over the EXISTING B5 detector (`pollerCount.ts`): `ok`→no-op, `dual`→veto (claiming into 2 pollers IS the 409 war), `indeterminate`→fail-closed, unconfirmed silence→await, peer-confirmed global outage→hold, confirmed silence→elect + claim/stand-down/escalate.
- `decidePostCasSelfReverify` — "CAS-win is necessary but not sufficient": re-check live local poll-freshness before serving; on self-unfit, relinquish + self-exclude.
- `NobodyPollingLedger` — evaluable soak evidence (episodes, claims, stand-downs, self-exclusions, vetoes), mirroring G3's close-the-loop ledger.

This increment is **pure decision logic, NOT yet wired** to any tick, route, or actuation — it has ZERO runtime effect until the next increment (the `/mesh-selfheal/g2` observe route + enforce-mode actuation via the existing poll-follows-lease lever) consumes it.

## Evidence

- `tests/unit/nobodyPollingRecovery.test.ts` — 18 unit tests covering both sides of every decision boundary (election: preferred-fit / preferred-unfit / no-fit / determinism; verdict reduction: ok/dual/indeterminate/await/hold/claim/stand-down/escalate; self-reverify: fresh→serve / stale→relinquish; ledger accounting). All green; typecheck clean.

## What to Tell Your User

Nothing changes yet — this is inert internal decision logic for the upcoming "nobody-serving alarm," not yet active anywhere. When the full feature lands (a later increment), it will detect the "nobody is polling Telegram" state across your machines and have exactly one fit machine take over automatically, so messages stop dropping when a machine goes quiet. No action needed.

## Summary of New Capabilities

- None user-facing in this increment. New internal module `src/core/nobodyPollingRecovery.ts` (pure decision core) consumed by a later wiring increment; no route, config flag, or runtime surface added yet.
