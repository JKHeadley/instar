# Side-Effects Review — WS4.3 role-guard-at-spawn (a state-writing job is refused on a read-only standby)

**Spec:** docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md (review-convergence + approved:true). **Parent:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions.
**Ships DARK** behind `multiMachine.seamlessness.ws43RoleGuard` (default false). Single-machine / flag-off agents are a strict no-op.
**Files:** src/scheduler/JobScheduler.ts, src/commands/server.ts, src/core/types.ts, src/config/ConfigDefaults.ts, src/core/PostUpdateMigrator.ts, src/scaffold/templates.ts, tests/unit/lint-dev-agent-dark-gate.test.ts (golden line-map)

## What changed

1. **JobScheduler.ts (the spawn-boundary re-check):** `triggerJob` gains a role-guard check, placed right after the machine-scope check and BEFORE the claim/capacity/spawn path. When a role-guard provider is wired AND `job.writesState` AND the provider reports `enabled && !holdsLease`, the trigger is REFUSED (`'skipped'`, no throw, no spawn): a `role-guard` skip-ledger row + a `job_skipped` state event (`gateReason: 'role-guard'`) + a best-effort deduped attention callback. The provider is read LIVE on every trigger (never cached), so a mid-run demotion takes effect on the next tick — the TOCTOU fix, same family as WS1.1's `_ownershipReadForDrain`. Wired via a new `setRoleGuard(provider, onRefused?)` injector.
2. **server.ts (the wiring):** at the existing scheduler-Telegram wiring point (inside `if (scheduler)`, where `coordinator` + `config` + `telegram` are all in scope), `scheduler.setRoleGuard(...)` is called with a provider that reads `multiMachine.seamlessness.ws43RoleGuard` from config and `coordinator.holdsLease()` LIVE, and an `onRefused` that raises ONE per-slug deduped attention item (Agent-Health lane, LOW) so the operator learns a state-writing job couldn't run on this read-only standby.
3. **types.ts:** new optional `JobDefinition.writesState?: boolean` (additive, default-absent ⇒ not guarded), new `SkipReason` member `'role-guard'`, and the `seamlessness.ws43RoleGuard?: boolean` config-type field.
4. **ConfigDefaults.ts:** new `ws43RoleGuard: false` sibling under `multiMachine.seamlessness`. Deliberately NOT named `enabled` → outside the dev-agent dark-gate lint by construction.
5. **PostUpdateMigrator.ts + templates.ts:** a Job-Scheduler awareness bullet — `generateClaudeMd` (new agents) + an idempotent content-sniffed (`ws43RoleGuard`) `migrateClaudeMd` additive patcher anchored after the `/jobs` Trigger line (existing agents).

## Blast radius

- **Config-gated AND opt-in per job.** With `ws43RoleGuard` false (the fleet default) the provider returns `enabled:false` and the guard is a strict no-op. Even with the flag ON, ONLY jobs that explicitly carry `writesState: true` are ever considered — no existing job is affected until it opts in.
- **Topology-dead on a single machine.** A single-machine agent always holds the lease (`holdsLease()` ⇒ true), so the guard never fires regardless of the flag.
- **No new route, no new MeshRpc verb, no broadcast.** The re-route is by construction — the cron fires on every machine and only the lease-holder's pass clears the guard. The attention item rides the existing Agent-Health lane (calm, deduped, never a per-event topic).
- **Cannot block safe work.** The guard can only ever REFUSE a state-writing job that would have run on a read-only standby; a throwing provider degrades to spawn-proceeds (today's behavior).

## Risk + mitigation

- **Risk:** a broken/throwing provider wedges the scheduler. **Mitigation:** the provider call is try/caught; a throw resolves to `{ enabled:false, holdsLease:true }` so the spawn proceeds — the safe direction (never gate on a broken signal). Unit-tested.
- **Risk:** the attention callback errors and swallows the refusal. **Mitigation:** the refusal (skip + ledger + event) happens BEFORE the callback; the callback is in its own try/catch. The refusal is the load-bearing safety; the heads-up is best-effort. Unit-tested.
- **Risk:** the deduped attention item floods on a flapping lease. **Mitigation:** per-slug dedup id (`agent:ws43-role-guard:<slug>`) + Agent-Health lane (suppression-deduped, single calm topic) + the universal topic-creation budget backstop.
- **Risk:** a legitimately state-writing job never runs because no machine holds the lease. **Mitigation:** exactly one machine always holds the lease in a healthy mesh; the heads-up names the situation so the operator sees it if a genuine no-writable-machine condition persists.

## Migration parity

- `ws43RoleGuard: false` reaches existing agents via the generic config add-missing path (sibling under the already-migrated `multiMachine.seamlessness` block). The CLAUDE.md awareness bullet ships in `generateClaudeMd` + an idempotent content-sniffed (`ws43RoleGuard`) `migrateClaudeMd` patcher anchored after the `/jobs` Trigger line. The Job-Scheduler section heading is UNCHANGED → feature-delivery-completeness stays green (sub-bullet into an already-tracked section, the WS4.1 precedent).
- `JobDefinition.writesState` is additive — older agents' job parsers ignore the unknown field, so a jobs.json carrying it is back-compatible.

## Dark-gate line-map

- `ws43RoleGuard` is NOT an inline `enabled:` line, so the attributor sees no NEW attributed path. BUT inserting the flag's comment block into ConfigDefaults.ts shifted every `enabled: false` line from `sessionPool.enabled` onward by +13. The EXPECTED golden map in `tests/unit/lint-dev-agent-dark-gate.test.ts` was recomputed via `attributeEnabledFalsePaths('src/config/ConfigDefaults.ts')` on the merged tree and updated by hand. Verified: 24/24 green.

## Rollback

- Revert the squash commit. Dark-by-default means nothing was live; no data migration, no state repair. The `role-guard` skip-ledger rows + `job_skipped` events (only written when an operator enabled the flag AND a state-writing job was refused) are inert append-only observability data.
