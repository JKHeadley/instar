# Side-Effects Review — existing agents admitted to the first offer list (rollout step 5, off by default)

**Tier 1 by size, declared Tier 2 by risk** (a user-visible message to owners of existing agents once the switch is on; the parent spec's rollout gate). Spec: `docs/specs/recommended-services.md` (Rollout step 5 "Existing-agent first lists"; step 3 "Existing agents stay out until step 5, through the migration flag"). ELI16: `docs/specs/recommended-services-existing-agents.eli16.md`. Dark: `recommendedServices.offers.existingAgents` defaults to false.

**Size:** 3 source files, 2 test files; about 20 lines of source. **Effort:** no spec rounds; 1 commit attempt expected.

## Summary

- `types.ts`: `recommendedServices.offers.existingAgents?: boolean`.
- `recommendedServiceRoutes.ts`: `existingAgentsEnabled` dep; `admitExistingOwner()` runs at the start of every offer tick: when the switch is on, there is an owner, and the owner is not yet marked, `markMigrationComplete(stateDir, owner)` is written (the parent's per-owner migration-complete flag; permanent). Everything else about the list is unchanged: `offersLive` still needs the switch, the owner, the mark, a delivered first result and reach.
- `routes.ts`: the dep reads the config live.
- `CapabilityIndex.ts`: one sentence so an agent knows the switch exists.

## Decision-point inventory

- `admitExistingOwner` — add — deterministic admission on an operator-set switch; no judgment.

## 1. Over-block

- An existing agent with the switch off never gets the list, even if its owner would want it. That is the parent's rule (step 5 is the operator's decision per agent).

## 2. Under-block

- The switch is per agent config, so on a multi-machine agent each machine's operator sets it; the mark itself is in the per-machine prerequisites file, and the list's one-voice and replication rules are the parent's and unchanged. A machine with the switch off and a mark replicated from nowhere (it is not replicated) simply does not offer.
- The admission is permanent by design: turning the switch off does not un-mark. Stated in the ELI16.

## 3. Level-of-abstraction fit

The flag the parent spec already defined (`isMigrationComplete` per owner) gets its one missing writer for existing agents, at the one place that decides whether to offer. No new store, no new message path.

## 4. Signal vs authority compliance

- [x] No — no block/allow surface over content. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No heuristic at a competing-signals point.

## 5. Interactions

- **Offers:** the only consumer of the mark; the list still needs a delivered first result (existing agents record one at their next delivery after update, `routes.ts` records it on every delivery) and reach.
- **Legacy decline import (step 1):** already applied before any list; a legacy no stays a no in the list's candidate filter.
- **Maturation ladder:** the dev-agent rung of the parent's plan ("step 3 on the development agent with `offers.enabled` on") is reachable only through this switch on an existing development agent; without it the dev-agent rung could never run.

## 6. External surfaces

- Dark on the fleet. On an agent whose operator turns the switch on: one Telegram list to its owner, once, under the parent's existing rules.
- **Operator surface (Mobile-Complete):** the switch is a config setting the agent sets for its operator on request; the list itself is the existing Telegram message with buttons.

## 6b. Operator-surface quality

The list is the parent's; nothing new is shown.

## 7. Multi-machine posture

- The mark is in the per-machine prerequisites file (`machine-local-justification: physical-credential-locality` is not claimed; it is a per-machine admission beside the parent's per-machine `offers.enabled`, and the list's one-voice rule is the parent's: only the machine that can reach the person sends, and the offer rows replicate so a second machine never sends a second list).

## 8. Rollback cost

A revert removes the switch and the admission; marks already written stay (they are the parent's flag) and the parent's code reads them as before, so an admitted owner stays admitted. No data migration.

## Class-Closure Declaration

- `unbounded-self-action` → closure `n/a` (negative declaration). Reason: one idempotent mark per owner, written once on the existing bounded offer tick; the list itself keeps the parent's once-per-owner bound.

## Found problems, triaged

- None.

## Second-pass review

Not required by the Phase 5 list (no block/allow, no lifecycle, no gate); the change is twenty lines on a reviewed path. Tests: the integration test pins stays-out, admitted-once, and switch-off-takes-nothing-back; the wiring test pins the live config read.
