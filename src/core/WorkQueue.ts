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

export function scoreWorkItem(item: WorkItem): number {
  const explicit = item.priority ? PRIORITY[item.priority] : 0;
  const directed = item.userDirected ? 50 : 0;
  const age = Math.min(30, Math.max(0, item.ageDays)) * 2;
  const urgency = Math.max(0, Math.min(100, item.urgency));
  const goals = item.goalAlignment.length > 0 ? 10 : 0;
  return explicit + directed + urgency + age + goals;
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
