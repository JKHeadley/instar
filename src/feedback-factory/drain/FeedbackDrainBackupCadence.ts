import type { BackupSnapshot } from '../../core/types.js';

export const FEEDBACK_DRAIN_BACKUP_CADENCE_STAGE = {
  canonicalPipelineId: 'feedback-factory',
  stage: 'backup-cadence',
} as const;

export interface FeedbackDrainBackupAdapter {
  listSnapshots(): BackupSnapshot[];
  createSnapshot(trigger: BackupSnapshot['trigger']): BackupSnapshot;
}

/** Bounded RPO authority: hourly at most, plus unconditional control-plane checkpoints. */
export class FeedbackDrainBackupCadence {
  constructor(
    private readonly backups: FeedbackDrainBackupAdapter,
    private readonly clock: () => number = Date.now,
    private readonly rpoMs = 60 * 60 * 1000,
  ) {}

  maybeHourly(beforeSnapshot?: () => void): BackupSnapshot | null {
    const latest = this.backups.listSnapshots()
      .map((snapshot) => Date.parse(snapshot.createdAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    if (latest !== undefined && this.clock() - latest < this.rpoMs) return null;
    beforeSnapshot?.();
    return this.backups.createSnapshot('feedback-hourly');
  }

  afterPromotion(): BackupSnapshot { return this.backups.createSnapshot('feedback-promotion'); }
  afterFailover(): BackupSnapshot { return this.backups.createSnapshot('feedback-failover'); }
}
