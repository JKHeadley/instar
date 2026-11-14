import type { BackupSnapshot } from '../../core/types.js';

export const FEEDBACK_DRAIN_BACKUP_CADENCE_STAGE = {
  canonicalPipelineId: 'feedback-factory',
  stage: 'backup-cadence',
} as const;

export interface FeedbackDrainBackupAdapter {
  listSnapshots(): BackupSnapshot[];
  createSnapshot(trigger: BackupSnapshot['trigger']): BackupSnapshot;
}

export type HourlyOffThreadResult =
  | { started: true; done: Promise<BackupSnapshot> }
  | { started: false; reason: 'fresh' }
  | { started: false; reason: 'in-flight'; runningMs: number };

/** Bounded RPO authority: hourly at most, plus unconditional control-plane checkpoints. */
export class FeedbackDrainBackupCadence {
  private inFlightSince: number | null = null;
  /** Newest snapshot this process made, so a tick inside the hour reads nothing from disk. */
  private lastCreatedAt: number | null = null;

  constructor(
    private readonly backups: FeedbackDrainBackupAdapter,
    private readonly clock: () => number = Date.now,
    private readonly rpoMs = 60 * 60 * 1000,
  ) {}

  private due(): boolean {
    if (this.lastCreatedAt !== null && this.clock() - this.lastCreatedAt < this.rpoMs) return false;
    const latest = this.backups.listSnapshots()
      .map((snapshot) => Date.parse(snapshot.createdAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    return latest === undefined || this.clock() - latest >= this.rpoMs;
  }

  maybeHourly(beforeSnapshot?: () => void): BackupSnapshot | null {
    if (!this.due()) return null;
    beforeSnapshot?.();
    return this.backups.createSnapshot('feedback-hourly');
  }

  /**
   * The hourly snapshot with its bulk copy off the caller's thread.
   * `beforeSnapshot` and the start of `create` (its staging step) run
   * synchronously here, back to back, so the staged database is the one the
   * checkpoint just described. At most one snapshot is in flight; a tick that
   * finds one running starts nothing and says how long it has run.
   */
  maybeHourlyOffThread(
    create: (trigger: BackupSnapshot['trigger']) => Promise<BackupSnapshot>,
    beforeSnapshot?: () => void,
  ): HourlyOffThreadResult {
    if (this.inFlightSince !== null) return { started: false, reason: 'in-flight', runningMs: this.clock() - this.inFlightSince };
    if (!this.due()) return { started: false, reason: 'fresh' };
    beforeSnapshot?.();
    this.inFlightSince = this.clock();
    let pending: Promise<BackupSnapshot>;
    try {
      pending = create('feedback-hourly');
    } catch (error) {
      this.inFlightSince = null;
      throw error;
    }
    const done = pending.then(
      (snapshot) => {
        this.inFlightSince = null;
        const createdAt = Date.parse(snapshot.createdAt);
        if (Number.isFinite(createdAt)) this.lastCreatedAt = createdAt;
        return snapshot;
      },
      (error) => { this.inFlightSince = null; throw error; },
    );
    return { started: true, done };
  }

  afterPromotion(): BackupSnapshot { return this.backups.createSnapshot('feedback-promotion'); }
  afterFailover(): BackupSnapshot { return this.backups.createSnapshot('feedback-failover'); }
}
