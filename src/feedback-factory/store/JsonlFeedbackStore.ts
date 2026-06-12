/**
 * JsonlFeedbackStore.ts — the DURABLE canonical FeedbackStore for the operated
 * instance (post-cutover authority under the migration spec's Option B: Echo's
 * instance keeps its OWN canonical copy; Portal never opens a write door).
 *
 * Backing format: newline-delimited JSON, one file per entity family
 * (`feedback.jsonl`, `clusters.jsonl`, `dispatches.jsonl`) under a caller-supplied
 * directory. The format is DELIBERATELY the same shape `PersistedShadowImportTarget`
 * writes (one full row per line, keyed by feedbackId/clusterId), so the proven AS-IS
 * import artifact seeds this store directly — the cutover import output IS the
 * canonical store, no translation step (fewer integrity risks at the one-way door).
 *
 * Mutation model: append-only log with LAST-WRITE-WINS on load. Every mutation
 * appends the FULL updated row; on construction all lines are folded into a Map by
 * id (later lines supersede earlier). A file with one row per entity — exactly what
 * the import produces — is therefore a valid, already-compact log. When superseded
 * lines pile up past a threshold the file is compacted at construction time via an
 * atomic temp+rename rewrite (crash mid-compaction leaves the original intact).
 *
 * JSONL (not SQLite) for the same reason as PersistedShadowImportTarget: dependency-
 * free, no native module, trivially inspectable, and append durability is a plain
 * appendFileSync. Volume is fleet feedback — low write rate; the import's measured
 * 148k-row artifact parses in well under a second.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedbackItem, Cluster } from '../processor/types.js';
import type { ReopenDecision } from '../processor/reopen.js';
import type { DispatchRecord } from '../dispatch/dispatch.js';
import type { FeedbackStore, FeedbackMetrics } from './FeedbackStore.js';

/** Compact a file at load when more than half its lines are superseded AND it has real volume. */
const COMPACT_MIN_LINES = 1000;
const COMPACT_SUPERSEDED_RATIO = 0.5;

interface LoadResult<T> {
  rows: Map<string, T>;
  totalLines: number;
}

export class JsonlFeedbackStore implements FeedbackStore {
  private readonly feedbackPath: string;
  private readonly clustersPath: string;
  private readonly dispatchesPath: string;

  private feedback: Map<string, FeedbackItem>;
  private clusters: Map<string, Cluster>;
  private dispatches: Map<string, DispatchRecord>;
  private counts: FeedbackMetrics = { captured: 0, created: 0, merged: 0, reopened: 0 };

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.feedbackPath = join(dir, 'feedback.jsonl');
    this.clustersPath = join(dir, 'clusters.jsonl');
    this.dispatchesPath = join(dir, 'dispatches.jsonl');

    this.feedback = this.loadAndMaybeCompact<FeedbackItem>(this.feedbackPath, (r) =>
      pickId(r, 'feedbackId', 'feedback_id', 'id'),
    );
    this.clusters = this.loadAndMaybeCompact<Cluster>(this.clustersPath, (r) =>
      pickId(r, 'clusterId', 'cluster_id', 'id'),
    );
    this.dispatches = this.loadAndMaybeCompact<DispatchRecord>(this.dispatchesPath, (r) =>
      pickId(r, 'dispatchId', 'dispatch_id', 'id'),
    );
  }

  private loadAndMaybeCompact<T extends Record<string, unknown>>(
    path: string,
    idOf: (row: Record<string, unknown>) => string,
  ): Map<string, T> {
    const { rows, totalLines } = loadJsonl<T>(path, idOf);
    const superseded = totalLines - rows.size;
    if (totalLines >= COMPACT_MIN_LINES && superseded / totalLines >= COMPACT_SUPERSEDED_RATIO) {
      // Atomic rewrite: full snapshot to a temp file in the same dir, then rename.
      const tmp = `${path}.compact.tmp`;
      writeFileSync(tmp, [...rows.values()].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      renameSync(tmp, path);
    }
    return rows;
  }

  private appendFeedback(row: FeedbackItem): void {
    appendFileSync(this.feedbackPath, JSON.stringify(row) + '\n', 'utf8');
  }

  private appendCluster(row: Cluster): void {
    appendFileSync(this.clustersPath, JSON.stringify(row) + '\n', 'utf8');
  }

  // ── FeedbackStore ──────────────────────────────────────────────────────────

  getUnprocessedFeedback(): FeedbackItem[] {
    return [...this.feedback.values()]
      .filter((f) => (f.status ?? 'unprocessed') === 'unprocessed')
      .sort((a, b) => String(a.receivedAt ?? '').localeCompare(String(b.receivedAt ?? '')));
  }

  getActiveClusters(): Cluster[] {
    return [...this.clusters.values()].filter((c) => c.status !== 'resolved');
  }

  getCluster(clusterId: string): Cluster | undefined {
    return this.clusters.get(clusterId);
  }

  upsertClusterFromItem(clusterId: string, item: FeedbackItem): void {
    const existing = this.clusters.get(clusterId);
    if (existing) {
      existing.reportCount = (existing.reportCount ?? 0) + 1;
      this.appendCluster(existing);
    } else {
      const created: Cluster = {
        clusterId,
        title: item.title,
        description: item.description,
        type: item.type,
        reportCount: 1,
      };
      this.clusters.set(clusterId, created);
      this.appendCluster(created);
      this.counts.created++;
    }
  }

  mergeIntoCluster(clusterId: string, _item: FeedbackItem): void {
    const c = this.clusters.get(clusterId);
    if (c) {
      c.reportCount = (c.reportCount ?? 0) + 1;
      this.appendCluster(c);
    }
    this.counts.merged++;
  }

  applyReopen(clusterId: string, decision: ReopenDecision): void {
    const c = this.clusters.get(clusterId);
    if (!c) return;
    c.status = decision.newStatus;
    if (decision.bumpRecurrence) c.recurrenceCount = (c.recurrenceCount ?? 0) + 1;
    const field = decision.annotateField;
    const prior = (c[field] as string) ? `${c[field]}\n\n` : '';
    c[field] = prior + decision.note;
    this.appendCluster(c);
    this.counts.reopened++;
  }

  markProcessed(feedbackId: string, clusterId: string): void {
    const f = this.feedback.get(feedbackId);
    if (f) {
      f.status = 'processing';
      f.clusterId = clusterId;
      this.appendFeedback(f);
    }
    this.counts.captured++;
  }

  hasFeedback(feedbackId: string): boolean {
    return this.feedback.has(feedbackId);
  }

  addFeedback(item: FeedbackItem): void {
    const row: FeedbackItem = { status: 'unprocessed', ...item };
    this.feedback.set(item.feedbackId, row);
    this.appendFeedback(row);
  }

  listDispatches(filter?: { since?: string; type?: string }): DispatchRecord[] {
    return [...this.dispatches.values()]
      .filter((d) => d.active !== false)
      .filter((d) => !filter?.since || String(d.createdAt ?? '') >= filter.since)
      .filter((d) => !filter?.type || d.type === filter.type)
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  }

  findDispatchByTitle(title: string): DispatchRecord | undefined {
    return [...this.dispatches.values()].find((d) => d.title === title);
  }

  createDispatch(record: DispatchRecord): void {
    const row: DispatchRecord = { active: true, ...record };
    this.dispatches.set(record.dispatchId, row);
    appendFileSync(this.dispatchesPath, JSON.stringify(row) + '\n', 'utf8');
  }

  metrics(): FeedbackMetrics {
    return { ...this.counts };
  }

  /** Read-only size snapshot for the status surface. */
  sizes(): { feedback: number; clusters: number; dispatches: number } {
    return { feedback: this.feedback.size, clusters: this.clusters.size, dispatches: this.dispatches.size };
  }
}

function loadJsonl<T>(path: string, idOf: (row: Record<string, unknown>) => string): LoadResult<T> {
  const rows = new Map<string, T>();
  let totalLines = 0;
  if (!existsSync(path)) return { rows, totalLines };
  const txt = readFileSync(path, 'utf8');
  for (const line of txt.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    totalLines++;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const id = idOf(parsed);
      if (id) rows.set(id, parsed as T);
    } catch {
      // A torn/corrupt line (e.g. crash mid-append) is skipped, never fatal:
      // every complete later line still loads, and the next mutation re-appends
      // a full row. Durability beats strictness for an append log.
    }
  }
  return { rows, totalLines };
}

/** Resolve a row's primary-key id from the AS-IS field aliases (mirrors importRunner's pickId). */
function pickId(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}
