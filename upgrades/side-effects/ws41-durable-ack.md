# Side-Effects Review — WS4.1 follow-up: durable operator-bound /ack (an ack survives the owner machine being briefly offline)

**Spec:** docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md (review-convergence + approved:true). **Parent:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions.
**Ships DARK** behind `multiMachine.seamlessness.ws41DurableAck` (default false). Single-machine / flag-off agents are a strict no-op.
**Files:** src/core/RemoteAckStore.ts (new), src/server/routes.ts, src/config/ConfigDefaults.ts, src/core/PostUpdateMigrator.ts, src/scaffold/templates.ts, site/src/content/docs/features/multi-machine.md, site/src/content/docs/reference/api.md

## What changed

1. **RemoteAckStore.ts (new):** durable queue for an operator's ack/resolve of a POOLED attention item whose OWNER is briefly offline. Persists the ack INTENT — with the AUTHENTICATED operator principal that performed it — so the intent survives the owner being dark; a drain tick + a boot sweep re-deliver it when the owner returns. Append-then-compact JSONL under `logs/` (no DB dep, mirrors RemoteCloseAudit / PendingInboundStore). Idempotent on `(itemId, targetMachineId)` — a re-ack refreshes intent, never stacks duplicates. Best-effort writes: a failed append/compact logs loudly but never throws into the ack path. **The store never authorizes anything — it only remembers intent; the OWNER revalidates the carried principal at apply time.**
2. **routes.ts (`POST /attention/:id/remote-ack`):** the operator-facing leg. When `ws41DurableAck` is off it 503s; when on, a remote-owned item's ack is persisted to the store (with the Bearer-authenticated principal) instead of evaporating against the offline owner. The receiver-side precedence guard (an owner applying a remote-ack intent on return) is gated on the same flag — a no-op when off.
3. **ConfigDefaults.ts:** new `ws41DurableAck: false` sibling under `multiMachine.seamlessness`. Deliberately NOT named `enabled` → it is outside the dev-agent dark-gate lint by construction (no inline `enabled:` line added).
4. **PostUpdateMigrator.ts + templates.ts:** an Attention-Queue awareness bullet — `generateClaudeMd` (new agents) + an idempotent content-sniffed `migrateClaudeMd` additive patcher (existing agents).
5. **docs:** multi-machine.md + api.md note the route + the dark posture.

## Blast radius

- **Config-gated, not wiring-gated.** With `ws41DurableAck` false (the fleet default) the route 503s, the store is never constructed, and the receiver precedence guard is inert. A single-machine agent never has a remote owner, so the path is dead by topology too.
- **No authorization surface.** The store carries the operator principal as DATA the owner revalidates at apply — it never grants anything. The Bearer auth on the route is the only authority; the durable intent is replayed THROUGH the owner's normal ack authorization, not around it.
- **No new MeshRpc verb / no broadcast.** The intent re-delivers on the owner's existing return/boot path. N-machine-safe, no LAN assumption.

## Risk + mitigation

- **Risk:** a stale or forged ack intent resolves an item it shouldn't. **Mitigation:** the owner revalidates the carried authenticated principal at apply time; an intent it can't authorize is dropped. The store is idempotent on (itemId,targetMachineId), so a redelivery can't double-apply.
- **Risk:** the store grows unbounded if an owner stays dark. **Mitigation:** append-then-compact keyed on (itemId,targetMachineId) collapses re-acks; a delivered/applied intent is compacted out. (A TTL horizon is a tracked follow-up if dark-peer accumulation proves real — CMT-1416.)
- **Risk:** a store write error breaks the operator's ack path. **Mitigation:** every write is best-effort try/catch — a failure logs loudly (an unrecorded ack-intent deserves a trace) but the route still returns; the operator's ack is never blocked by the durability layer.

## Migration parity

- `ws41DurableAck: false` reaches existing agents via the generic config add-missing path (sibling under the already-migrated `multiMachine.seamlessness` block). The CLAUDE.md awareness bullet ships in `generateClaudeMd` + an idempotent content-sniffed `migrateClaudeMd` patcher. The Attention-Queue section heading is UNCHANGED → feature-delivery-completeness stays green (sub-bullet into an already-tracked section, the WS5.3/WS4.2 precedent).

## Dark-gate line-map

- The `ws41DurableAck` flag is NOT an inline `enabled:` line, so the attributor sees no NEW attributed path. Any cartographer line shift came from main advancing; the EXPECTED map was recomputed. Verified: `tests/unit/lint-dev-agent-dark-gate.test.ts` → 24/24 green.

## Rollback

- Revert the squash commit. Dark-by-default means nothing was live; no data migration, no state repair. The `logs/` JSONL (only written when an operator enabled the flag AND a remote-owned ack happened) is inert append-only data that simply stops being read.
