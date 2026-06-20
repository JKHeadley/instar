/**
 * Phase 2 #7 (multimachine-lease-poll-robustness audit) — startup config-coherence
 * checks. Surfaces incoherent multi-machine config combinations that silently
 * degrade behavior (the 2026-06-20 audit: meshTransport disabled while session
 * transfer is live left the pair on single-rope fragility under transfer load —
 * the worst-of-both state my morning band-aid created).
 *
 * SIGNAL only — these are WARNINGS, never a startup REJECT. A hard reject would
 * refuse fleet boot on a config the audit showed is the SHIPPED default in some
 * combinations (F-CLAMP1: default TTL 60s < tick 120s would itself trip a naive
 * invariant). So the checker returns warnings the caller logs (+ optionally an
 * Attention item); it never throws.
 *
 * Pure + deterministic → fully unit-testable.
 */

export interface ConfigCoherenceWarning {
  code: string;
  message: string;
}

interface MultiMachineLike {
  meshTransport?: { enabled?: boolean; priorities?: Record<string, number> };
  sessionPool?: { stage?: string; enabled?: boolean };
  leaseTtlMs?: number;
}

/**
 * @param mm the resolved `multiMachine` config block.
 * @param isMultiMachine whether this agent actually runs multi-machine (has a
 *   machine identity / a peer). On a single-machine agent these combinations are
 *   harmless no-ops, so we don't warn.
 */
export function checkMultiMachineConfigCoherence(
  mm: MultiMachineLike | undefined,
  isMultiMachine: boolean,
): ConfigCoherenceWarning[] {
  const warnings: ConfigCoherenceWarning[] = [];
  if (!mm || !isMultiMachine) return warnings;

  // 1) Mesh transport disabled while session transfer is LIVE — the worst-of-both
  //    state: the pool actively moves sessions but the transport reverts to a
  //    single (flaky) rope, reintroducing the lease flap under transfer load.
  const transferLive = mm.sessionPool?.enabled !== false && mm.sessionPool?.stage === 'live-transfer';
  if (mm.meshTransport?.enabled === false && transferLive) {
    warnings.push({
      code: 'mesh-off-while-live-transfer',
      message:
        'multiMachine.meshTransport.enabled=false while sessionPool.stage=live-transfer on a multi-machine agent — ' +
        'session transfer is active but the mesh is single-rope, reintroducing the lease flap. Set meshTransport.enabled=true.',
    });
  }

  // 2) Mesh rope priorities must be DISTINCT positive integers (a tie makes rope
  //    selection nondeterministic).
  const pri = mm.meshTransport?.priorities;
  if (pri && typeof pri === 'object') {
    const vals = Object.values(pri).filter((v) => typeof v === 'number');
    const bad = vals.filter((v) => !Number.isInteger(v) || v <= 0);
    if (bad.length > 0) {
      warnings.push({ code: 'mesh-priority-nonpositive', message: `multiMachine.meshTransport.priorities must be positive integers; got ${JSON.stringify(bad)}.` });
    }
    if (new Set(vals).size !== vals.length) {
      warnings.push({ code: 'mesh-priority-collision', message: `multiMachine.meshTransport.priorities has duplicate values (${JSON.stringify(vals)}) — rope selection is nondeterministic.` });
    }
  }

  return warnings;
}
