/** Unified work-intake registry and deterministic ranking (v1). */
export type WorkSource = 'commitment' | 'evolution-action' | 'feedback' | 'topic';
export type WorkStatus = 'open' | 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';

export interface WorkItem {
  id: string;
  source: WorkSource;
  sourceRef: string;
  title: string;
  kind: string;
  goalAlignment: string[];
  urgency: number;
  ageDays: number;
  userDirected: boolean;
  status: WorkStatus;
  assignee: string | null;
  priority?: 'critical' | 'high' | 'medium' | 'low';
}

export interface WorkQueueReader {
  commitments(): WorkItem[];
  evolutionActions(): WorkItem[];
  feedback(): WorkItem[];
  topics(): WorkItem[];
}

const PRIORITY: Record<NonNullable<WorkItem['priority']>, number> = { critical: 100, high: 70, medium: 40, low: 10 };
/** Named scoring knobs: age can never bridge one explicit-priority band. */
export const AGE_SCORE_PER_DAY = 0.5;
export const MAX_AGE_SCORE = 20;
export const STALE_AFTER_DAYS = 30;
export const STALE_DISCOUNT_PER_DAY = 0.5;
export const MAX_STALE_DISCOUNT = 60;

function ageScore(ageDays: number): number {
  return Math.min(MAX_AGE_SCORE, Math.max(0, ageDays) * AGE_SCORE_PER_DAY);
}

function stalenessDiscount(ageDays: number): number {
  return Math.min(MAX_STALE_DISCOUNT, Math.max(0, ageDays - STALE_AFTER_DAYS) * STALE_DISCOUNT_PER_DAY);
}

export function scoreWorkItem(item: WorkItem): number {
  const explicit = item.priority ? PRIORITY[item.priority] : 0;
  const directed = item.userDirected ? 50 : 0;
  const age = ageScore(item.ageDays);
  const urgency = Math.max(0, Math.min(100, item.urgency));
  const goals = item.goalAlignment.length > 0 ? 10 : 0;
  return explicit + directed + urgency + age + goals - stalenessDiscount(item.ageDays);
}

export function normalizeAndRank(items: WorkItem[]): WorkItem[] {
  const deduped = new Map<string, WorkItem>();
  for (const item of items) {
    if (!item.id || item.status === 'completed' || item.status === 'cancelled') continue;
    const key = `${item.title.trim().toLowerCase()}\0${item.kind}`;
    const prior = deduped.get(key);
    if (!prior || scoreWorkItem(item) > scoreWorkItem(prior)) deduped.set(key, item);
  }
  return [...deduped.values()].sort((a, b) => scoreWorkItem(b) - scoreWorkItem(a) || a.id.localeCompare(b.id));
}

/** Unified work-intake registry: normalizes and ranks active cross-source work. */
export class WorkQueueRegistry {
  private ranked: WorkItem[] = [];
  constructor(private readonly reader: WorkQueueReader) {}
  rescore(): WorkItem[] {
    this.ranked = normalizeAndRank([
      ...this.reader.commitments(), ...this.reader.evolutionActions(),
      ...this.reader.feedback(), ...this.reader.topics(),
    ]);
    return this.ranked;
  }
  list(): WorkItem[] { return this.ranked.length ? [...this.ranked] : this.rescore(); }
}
