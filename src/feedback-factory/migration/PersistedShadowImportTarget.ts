/**
 * PersistedShadowImportTarget.ts — a DURABLE, on-disk AS-IS import sink for the
 * pre-click cutover integrity gate (spec §2.4; feedback-factory-migration.md §2.5).
 *
 * Why this exists (and why it is NOT `InMemoryImportTarget`):
 *
 * `cutoverReadiness.ts` hard-gates the operator's IRREVERSIBLE cutover click on
 * `ready = integrity.passed && parity.cleared && !parity.stale`. The integrity leg
 * greens ONLY when `recordIntegrityReport(passingReport)` is called. The existing
 * import-DRYRUN route is deliberately walled off from that path (its report goes to
 * `importDryRunReportPath`, never `integrityReportPath`) precisely so an EPHEMERAL,
 * in-memory rehearsal can never quietly green an irreversible gate.
 *
 * The pre-click integrity gate therefore needs a target that is a step more real than
 * the in-memory dry-run: a **persisted** shadow the import physically lands in and is
 * read back FROM DISK, so the recorded integrity report corresponds to a durable,
 * inspectable artifact — not an in-process Map that vanishes with the process. The
 * shadow is a VERIFICATION target, never canonical: the canonical production import
 * (Portal's apply-clusters / the real Prisma write) happens AFTER the click. This
 * mirrors `InMemoryImportTarget`'s contract exactly (same `ImportTarget` interface,
 * same dup-PK refusal, same `schemaDescriptor() === null` → the runner derives the
 * dry-run schema), differing ONLY in where the rows live.
 *
 * Backing store: two newline-delimited JSON files (`clusters.jsonl`, `feedback.jsonl`)
 * under a caller-supplied directory. JSONL (not SQLite) keeps the target dependency-free
 * so the out-of-process integrity-pass runner bundles cleanly (no native module). Each
 * AS-IS import APPENDS one row; `readBack*` parses the file. Duplicate PKs are refused
 * before the append (mirrors the DB @id constraint the real adapter would hit). The
 * shadow directory is disposable — `dispose()` removes it after the gate has run.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ImportTarget,
  type RawRow,
  DuplicateImportIdError,
} from './importRunner.js';
import type { SchemaDescriptor } from './importIntegrity.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

/** Resolve a row's primary-key id from the AS-IS field aliases (mirrors importRunner's pickId). */
function pickId(row: RawRow, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

export class PersistedShadowImportTarget implements ImportTarget {
  private readonly clustersPath: string;
  private readonly feedbackPath: string;
  // In-memory PK sets enforce the @id constraint at import time (the durable readback
  // is still the file). Sets are rebuilt from disk on construction so a reused dir is
  // duplicate-safe across processes.
  private readonly clusterIds = new Set<string>();
  private readonly feedbackIds = new Set<string>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.clustersPath = join(dir, 'clusters.jsonl');
    this.feedbackPath = join(dir, 'feedback.jsonl');
    // Rebuild PK sets from any rows already on disk (idempotent reuse / crash recovery).
    for (const r of this.readJsonl(this.clustersPath)) {
      const id = pickId(r, 'clusterId', 'cluster_id', 'id');
      if (id) this.clusterIds.add(id);
    }
    for (const r of this.readJsonl(this.feedbackPath)) {
      const id = pickId(r, 'feedbackId', 'feedback_id', 'id');
      if (id) this.feedbackIds.add(id);
    }
  }

  private readJsonl(path: string): RawRow[] {
    if (!existsSync(path)) return [];
    const txt = readFileSync(path, 'utf8');
    const out: RawRow[] = [];
    for (const line of txt.split('\n')) {
      if (!line) continue;
      out.push(JSON.parse(line) as RawRow);
    }
    return out;
  }

  importClusterAsIs(row: RawRow): void {
    const id = pickId(row, 'clusterId', 'cluster_id', 'id');
    if (!id) throw new Error('cluster row has no resolvable id (clusterId/cluster_id/id) — cannot import');
    if (this.clusterIds.has(id)) throw new DuplicateImportIdError('cluster', id);
    this.clusterIds.add(id);
    appendFileSync(this.clustersPath, JSON.stringify(row) + '\n');
  }

  importFeedbackAsIs(row: RawRow): void {
    const id = pickId(row, 'feedbackId', 'feedback_id', 'id');
    if (!id) throw new Error('feedback row has no resolvable id (feedbackId/feedback_id/id) — cannot import');
    if (this.feedbackIds.has(id)) throw new DuplicateImportIdError('feedback', id);
    this.feedbackIds.add(id);
    appendFileSync(this.feedbackPath, JSON.stringify(row) + '\n');
  }

  readBackClusters(): RawRow[] {
    return this.readJsonl(this.clustersPath);
  }

  readBackFeedback(): RawRow[] {
    return this.readJsonl(this.feedbackPath);
  }

  /**
   * No real schema descriptor — like the in-memory dry-run target, the runner derives
   * the target schema from readback + the canonical accepted-status contract. (A future
   * real Prisma adapter would return its actual descriptor here.)
   */
  schemaDescriptor(): SchemaDescriptor | null {
    return null;
  }

  /** Remove the on-disk shadow. Call after the integrity gate has run + the report is recorded. */
  dispose(): void {
    SafeFsExecutor.safeRmSync(this.dir, { recursive: true, force: true, operation: 'PersistedShadowImportTarget.dispose' });
  }
}
