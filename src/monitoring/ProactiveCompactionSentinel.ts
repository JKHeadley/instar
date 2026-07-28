/**
 * Proactively asks an idle autonomous Claude session to compact before it
 * reaches the context wall. The caller owns session discovery and the cadence;
 * this class owns the threshold, idle-boundary, dry-run, and anti-repeat gates.
 */

export interface ProactiveCompactionCandidate {
  sessionName: string;
  autonomous: boolean;
  framework?: string;
  contextRemainingPercent: number | null;
  workState: 'working' | 'idle' | 'indeterminate';
}

export interface ProactiveCompactionConfig {
  enabled?: boolean;
  dryRun?: boolean;
  /** Compact once used context reaches this percentage. Default 85. */
  thresholdUsedPercent?: number;
  /** Minimum spacing between actions for one session. Default 30 minutes. */
  cooldownMs?: number;
}

export interface ProactiveCompactionDeps {
  listCandidates: () => Promise<ProactiveCompactionCandidate[]>;
  triggerCompact: (sessionName: string) => boolean;
  now?: () => number;
  audit?: (event: ProactiveCompactionAuditEvent) => void;
}

export interface ProactiveCompactionAuditEvent {
  kind: 'would-compact' | 'compact-triggered' | 'compact-trigger-failed';
  sessionName: string;
  usedPercent: number;
  thresholdUsedPercent: number;
  at: number;
}

export class ProactiveCompactionSentinel {
  private readonly enabled: boolean;
  private readonly dryRun: boolean;
  private readonly thresholdUsedPercent: number;
  private readonly cooldownMs: number;
  private readonly lastActionAt = new Map<string, number>();
  private running = false;

  constructor(
    private readonly deps: ProactiveCompactionDeps,
    config: ProactiveCompactionConfig = {},
  ) {
    this.enabled = config.enabled === true;
    this.dryRun = config.dryRun !== false;
    this.thresholdUsedPercent = Math.min(99, Math.max(1, config.thresholdUsedPercent ?? 85));
    this.cooldownMs = Math.max(1_000, config.cooldownMs ?? 30 * 60_000);
  }

  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const now = this.deps.now?.() ?? Date.now();
      for (const candidate of await this.deps.listCandidates()) {
        if (!candidate.autonomous || candidate.framework !== 'claude-code') continue;
        if (candidate.workState !== 'idle' || candidate.contextRemainingPercent == null) continue;

        const usedPercent = 100 - candidate.contextRemainingPercent;
        if (usedPercent < this.thresholdUsedPercent) continue;
        const last = this.lastActionAt.get(candidate.sessionName);
        if (last != null && now - last < this.cooldownMs) continue;

        this.lastActionAt.set(candidate.sessionName, now);
        if (this.dryRun) {
          this.audit('would-compact', candidate.sessionName, usedPercent, now);
          continue;
        }
        const accepted = this.deps.triggerCompact(candidate.sessionName);
        this.audit(
          accepted ? 'compact-triggered' : 'compact-trigger-failed',
          candidate.sessionName,
          usedPercent,
          now,
        );
      }
    } finally {
      this.running = false;
    }
  }

  private audit(
    kind: ProactiveCompactionAuditEvent['kind'],
    sessionName: string,
    usedPercent: number,
    at: number,
  ): void {
    this.deps.audit?.({
      kind,
      sessionName,
      usedPercent,
      thresholdUsedPercent: this.thresholdUsedPercent,
      at,
    });
  }
}
