/**
 * singleMachineFailoverGapWiring — the boot-wiring factory that builds the pure
 * SingleMachineFailoverGapDetector's injected deps from the real server managers.
 *
 * Kept in a SEPARATE module from the detector core (increment 1) so that branch
 * stays cleanly rebasable — the detector module has zero imports of real managers,
 * and this file is the only place the neutral `FailoverGapAttention` shape is
 * adapted into the real attention-queue input.
 *
 * The adaptation (the load-bearing mapping the wiring test pins):
 *   FailoverGapAttention { title, body, priority:'high', dedupKey, source }
 *     → AttentionItemInput { id: dedupKey, title, summary: body,
 *                            category: 'monitoring', priority: 'HIGH',
 *                            sourceContext: source }
 */
import {
  SingleMachineFailoverGapDetector,
  type SingleMachineFailoverGapDetectorDeps,
  type FailoverGapAttention,
} from './SingleMachineFailoverGapDetector.js';

/** The attention-item input the real TelegramAdapter.createAttentionItem consumes. */
export interface FailoverGapAttentionItemInput {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
}

/** A minimal read over the machine-pool capacities (mirrors MachinePoolRegistry.getCapacities()). */
export interface MachineCapacityView {
  machineId: string;
  online?: boolean;
}

/** Real-manager deps the factory maps into the detector's injected callbacks. */
export interface SingleMachineFailoverGapWiringDeps {
  /** Dark gate (the resolved config's `enabled`). */
  enabled: () => boolean;
  /** Dry-run mode (the resolved config's `dryRun`). */
  dryRun: () => boolean;
  /** Live capacities read (self + peers). Absent registry → treat as empty. */
  getCapacities: () => MachineCapacityView[];
  /** This machine's id (excluded from the online-peer count). */
  selfMachineId: () => string | null;
  /** True when multiMachine is configured/enabled on this agent at all. */
  multiMachineEnabled: () => boolean;
  /** Count of active autonomous runs right now (the work that needs a failover target). */
  getActiveAutonomousRunCount: () => number;
  /** Adapter into the real attention queue (createAttentionItem — fire-and-forget). */
  createAttentionItem: (item: FailoverGapAttentionItemInput) => void;
  /** Optional structured audit sink (forwarded verbatim to the detector). */
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * Build the injected deps from real managers and return the constructed detector.
 * The online-peer count is derived from live capacities (online AND not-self); the
 * gap mode (peer-offline vs not-configured) rides `multiMachineEnabled`.
 */
export function makeSingleMachineFailoverGapDetector(
  deps: SingleMachineFailoverGapWiringDeps,
): SingleMachineFailoverGapDetector {
  const injected: SingleMachineFailoverGapDetectorDeps = {
    enabled: deps.enabled,
    dryRun: deps.dryRun,
    getMeshMembership: () => {
      const self = deps.selfMachineId();
      const onlinePeerCount = deps
        .getCapacities()
        .filter((c) => c.online === true && c.machineId !== self).length;
      return { multiMachineEnabled: deps.multiMachineEnabled(), onlinePeerCount };
    },
    getActiveAutonomousRunCount: deps.getActiveAutonomousRunCount,
    raiseAttention: (item: FailoverGapAttention) => {
      deps.createAttentionItem({
        id: item.dedupKey,
        title: item.title,
        summary: item.body,
        category: 'monitoring',
        priority: 'HIGH',
        sourceContext: item.source,
      });
    },
    audit: deps.audit,
  };
  return new SingleMachineFailoverGapDetector(injected);
}
