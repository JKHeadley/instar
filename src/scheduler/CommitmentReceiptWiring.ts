import type { JobScheduler } from './JobScheduler.js';
import type { EvolutionManager } from '../core/EvolutionManager.js';

/** Shared production/test assembly: real durable identity lookup, never a no-op. */
export function wireCommitmentReceiptConsumption(scheduler: JobScheduler | null | undefined, evolution: EvolutionManager): void {
  scheduler?.setCommitmentFrontierActionReader(() => evolution.listCommitmentReceiptActions());
  evolution.setCommitmentReceiptModeProvider(() => scheduler?.commitmentReceiptModeEnabled() ?? false);
}
