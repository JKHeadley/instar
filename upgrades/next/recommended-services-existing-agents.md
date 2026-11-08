# Upgrade Guide — recommended-services-existing-agents

## What Changed

Rollout step 5 of `docs/specs/recommended-services.md` as a switch: `recommendedServices.offers.existingAgents` (default false). An agent created before the proactive offer shipped stays out of the first list until the switch is on; then its owner is marked migration-complete at the next offer tick (`admitExistingOwner` in `recommendedServiceRoutes.ts`, the parent's `markMigrationComplete` per owner) and the first list follows the same rules as a new agent's: after a delivered first result, once, from a machine that can reach the person. Turning the switch off again un-offers nothing: the mark is permanent and the list goes out once.

## What to Tell Your User

Nothing changes unless you ask for it. If you want an agent you already have to offer you its list of outside services once, say so; I turn the switch on and the list arrives after the agent's next delivered result.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Existing agent admitted to the first list | `recommendedServices.offers.existingAgents: true` beside `offers.enabled: true`; read live |

## Evidence

`tests/integration/recommended-services-offers.test.ts` (stays out; admitted once; switch-off takes nothing back), `tests/unit/recommended-services-wiring.test.ts` (live config read).
