# Side effects: Always available and the app key replace, as one change

This combines three reviewed PRs so they need one verify run: #3351 (the same Mac replaces its own lost app key), #3354 (Always available guards) and #3357 (the before-login Claude sign-in). Each one's side-effects note, plain-language note and release note are included unchanged:
- `upgrades/side-effects/replace-app-key.md`
- `upgrades/side-effects/always-available-guards.md`
- `upgrades/side-effects/always-available-token.md`

## Merge
They were merged in that order onto main with no conflicts. The shared files (`src/cli.ts` and the spec files) merged cleanly, and the spec copies are identical. Typecheck is clean, and the three targeted unit files pass together (48/48).

## Review
Each part had its own independent review, which concurred (two rounds each). The combination adds no new code.

## Fix (2026-11-18): the local-owner route knows its machine on a single-Mac agent

Local Verify failed `tests/e2e/mac-app-creates-agent-alive.test.ts` at 5e421f7. Cause: the route took this machine's id only from `MobilePairingService.deps.selfMachineId`, which `AgentServer` sets from the multi-machine coordinator, and the coordinator is passed only when multi-machine is enabled. A single-Mac agent (the Mac app's normal case) therefore enrolled its app with `localBinding.machineId: null`, and `--replace-app-key` was always refused there (the plan refused "made before this agent knew which computer it is on"; the route refused `machine-identity-missing`). The unit tests injected `selfMachineId`, so only the production-boot e2e saw it.

Fix: `ownMachineId(stateDir)` (moved from `install.ts` to `core/localOwnerTicket.ts`) reads `machine/identity.json`; the route uses `deps.selfMachineId ?? ownMachineId(stateDir)`. The install command already planned from that same file, so the plan and the server now agree. `deps.selfMachineId` itself is unchanged, so no other pairing behaviour moves.

- Over-block: none new; the route still refuses a replace when neither source names a machine.
- Under-block: the identity file is the agent's own 0600 state, the same source the install command trusts; a local user who can write it can already write the ticket. No new principal gains anything.
- Multi-machine: when the coordinator is on, its id is used as before (it is the same file's id).
- Interactions: `localBindingOk` still receives `deps.selfMachineId`; with it null the machine check is skipped exactly as before, so devices bound under the file id keep working.
- Rollback: revert the commit.

Second-pass review (independent subagent, 2026-11-18): Concur with the review. Every existing gate (same-Mac loopback, one-time ticket, key proof) runs before the fallback; the coordinator loads its id from the same `machine/identity.json`, so the ids agree when multi-machine is turned on later. The unit test "a single-Mac agent (no multi-machine coordinator) binds and replaces using its own machine identity file" covers the fallback.
