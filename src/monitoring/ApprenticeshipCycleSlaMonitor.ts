import type { ApprenticeshipCycleRecord, ApprenticeshipCycleStore } from './ApprenticeshipCycleStore.js';

export interface ApprenticeshipCycleSlaConfig {
  enabled?: boolean;
  overdueAfterMinutes?: number;
}

export interface ApprenticeshipCycleSlaOverdue {
  id: string;
  instanceId: string;
  cycleNumber: number;
  ageMinutes: number;
  createdAt: string;
}

export interface ApprenticeshipCycleSlaAttention {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  sourceContext: string;
}

export interface ApprenticeshipCycleSlaMonitorOptions {
  store: Pick<ApprenticeshipCycleStore, 'list'>;
  config?: ApprenticeshipCycleSlaConfig;
  now?: () => Date;
  raiseAttention?: (item: ApprenticeshipCycleSlaAttention) => Promise<unknown> | unknown;
}

export interface ApprenticeshipCycleSlaTickResult {
  enabled: boolean;
  overdue: ApprenticeshipCycleSlaOverdue[];
  raised: string[];
}

const DEFAULT_OVERDUE_AFTER_MINUTES = 120;
const MAX_SCAN_CYCLES = 500;

function normalizeOverdueAfterMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_OVERDUE_AFTER_MINUTES;
  return Math.max(1, Math.floor(n));
}

function toOverdue(cycle: ApprenticeshipCycleRecord, nowMs: number, thresholdMinutes: number): ApprenticeshipCycleSlaOverdue | null {
  if (cycle.status !== 'open') return null;
  const createdMs = Date.parse(cycle.createdAt);
  if (!Number.isFinite(createdMs)) return null;
  const ageMinutes = Math.floor((nowMs - createdMs) / 60_000);
  if (ageMinutes <= thresholdMinutes) return null;
  return {
    id: cycle.id,
    instanceId: cycle.instanceId,
    cycleNumber: cycle.cycleNumber,
    ageMinutes,
    createdAt: cycle.createdAt,
  };
}

export class ApprenticeshipCycleSlaMonitor {
  private readonly store: Pick<ApprenticeshipCycleStore, 'list'>;
  private readonly config: Required<ApprenticeshipCycleSlaConfig>;
  private readonly now: () => Date;
  private readonly raiseAttention: ((item: ApprenticeshipCycleSlaAttention) => Promise<unknown> | unknown) | null;
  private readonly raisedCycleIds = new Set<string>();

  constructor(opts: ApprenticeshipCycleSlaMonitorOptions) {
    this.store = opts.store;
    this.config = {
      enabled: opts.config?.enabled === true,
      overdueAfterMinutes: normalizeOverdueAfterMinutes(opts.config?.overdueAfterMinutes),
    };
    this.now = opts.now ?? (() => new Date());
    this.raiseAttention = opts.raiseAttention ?? null;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  listOverdue(instanceId?: string): ApprenticeshipCycleSlaOverdue[] {
    if (!this.config.enabled) return [];
    const nowMs = this.now().getTime();
    return this.store
      .list({ instanceId, limit: MAX_SCAN_CYCLES })
      .map((cycle) => toOverdue(cycle, nowMs, this.config.overdueAfterMinutes))
      .filter((item): item is ApprenticeshipCycleSlaOverdue => item !== null);
  }

  async tick(instanceId?: string): Promise<ApprenticeshipCycleSlaTickResult> {
    if (!this.config.enabled) return { enabled: false, overdue: [], raised: [] };
    const overdue = this.listOverdue(instanceId);
    const raised: string[] = [];
    if (!this.raiseAttention) return { enabled: true, overdue, raised };

    for (const cycle of overdue) {
      if (this.raisedCycleIds.has(cycle.id)) continue;
      this.raisedCycleIds.add(cycle.id);
      raised.push(cycle.id);
      await this.raiseAttention({
        id: `apprenticeship-cycle-overdue-${cycle.id}`,
        title: 'Apprenticeship cycle overdue',
        summary:
          `Cycle ${cycle.cycleNumber} for ${cycle.instanceId} has been open for ` +
          `${cycle.ageMinutes} minute(s), past the ${this.config.overdueAfterMinutes}-minute SLA.`,
        category: 'apprenticeship',
        priority: 'LOW',
        sourceContext: 'apprenticeship-cycle-sla',
      });
    }
    return { enabled: true, overdue, raised };
  }
}
