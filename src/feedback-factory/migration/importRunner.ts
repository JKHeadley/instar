/**
 * importRunner.ts — the end-to-end Phase-2/4 AS-IS import executor (spec §2.4).
 *
 * `importIntegrity.ts` ships the pure integrity-gate CORE (checksums, fingerprint
 * scan, schema-equivalence, FK check, sequence plan); this module is the RUNNER
 * that drives a real import through it: read the full source export → pre-import
 * fingerprint-uniqueness scan (abort BEFORE any write on a collision) → import
 * rows AS-IS parent-before-child → read back what actually landed → run the full
 * integrity gate over source-vs-readback. The gate verdict therefore attests what
 * the TARGET stores, never what the runner intended to write.
 *
 * Two execution modes share this one code path:
 *   - DRY-RUN (available now): target = {@link InMemoryImportTarget}. Proves the
 *     import pipeline on REAL production data with zero durable writes. Its report
 *     persists to a SEPARATE dry-run path and NEVER greens the canonical
 *     `integrity-gate-pass` readiness condition — readiness honesty: `ready` must
 *     mean the real data migration ran, not a rehearsal.
 *   - REAL (creds-gated, Phase 0/G1.4): target = the cloud Prisma adapter (a thin
 *     {@link ImportTarget} shim wrapping one transaction + the synthetic
 *     post-import insert). Only THAT run records to the canonical report path.
 *
 * Rows are handled as raw `Record<string, unknown>` end to end — AS-IS means every
 * field survives verbatim, including fields this codebase has never heard of.
 */

import type { Cluster, FeedbackItem } from '../processor/types.js';
import { V1_TO_V2_STATUS, V2_STATES } from '../processor/transitions.js';
import {
  CURATED_CLUSTER_FIELDS,
  CURATED_FEEDBACK_FIELDS,
  runIntegrityGate,
  scanFingerprintUniqueness,
  type FingerprintCollision,
  type IntegrityReport,
  type SchemaDescriptor,
} from './importIntegrity.js';

/** A raw row exactly as the source export delivered it. */
export type RawRow = Record<string, unknown>;

/** The full source export the import consumes (clusters + the feedback rows that reference them). */
export interface ImportSourceData {
  clusters: RawRow[];
  feedback: RawRow[];
}

/**
 * The write/readback seam an import target must provide. The REAL adapter wraps a
 * cloud DB transaction; tests and dry-runs use {@link InMemoryImportTarget}. The
 * readback methods are load-bearing: the integrity gate verifies what the target
 * RETURNS, so an adapter that silently mangles a row on write is caught by the
 * per-row checksum comparison — intent is never trusted over observation.
 */
export interface ImportTarget {
  /** Persist one cluster row AS-IS (every field verbatim). Throws on a duplicate clusterId (PK). */
  importClusterAsIs(row: RawRow): void;
  /** Persist one feedback row AS-IS. Throws on a duplicate feedbackId (PK). */
  importFeedbackAsIs(row: RawRow): void;
  /** Every cluster row as the target now stores it. */
  readBackClusters(): RawRow[];
  /** Every feedback row as the target now stores it. */
  readBackFeedback(): RawRow[];
  /**
   * The target's real schema descriptor, when it has one (the Prisma adapter
   * reports its actual enum + column types). Null → the runner derives a
   * descriptor from the readback rows (dry-run mode).
   */
  schemaDescriptor(): SchemaDescriptor | null;
}

/** Duplicate-PK import error (mirrors the DB constraint the real adapter would hit). */
export class DuplicateImportIdError extends Error {
  constructor(kind: 'cluster' | 'feedback', id: string) {
    super(`duplicate ${kind} id "${id}" — AS-IS import refuses to overwrite an already-imported row`);
    this.name = 'DuplicateImportIdError';
  }
}

const pickId = (row: RawRow, ...keys: string[]): string => {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
};

/**
 * In-memory ImportTarget — the dry-run/test implementation. Deep-copies on write
 * AND on readback so neither side can mutate stored state through a shared
 * reference; refuses duplicate ids the way the real PK constraint would.
 */
export class InMemoryImportTarget implements ImportTarget {
  private clusters = new Map<string, RawRow>();
  private feedback = new Map<string, RawRow>();

  importClusterAsIs(row: RawRow): void {
    const id = pickId(row, 'clusterId', 'cluster_id', 'id');
    if (!id) throw new Error('cluster row has no resolvable id (clusterId/cluster_id/id) — cannot import');
    if (this.clusters.has(id)) throw new DuplicateImportIdError('cluster', id);
    this.clusters.set(id, structuredClone(row));
  }

  importFeedbackAsIs(row: RawRow): void {
    const id = pickId(row, 'feedbackId', 'feedback_id', 'id');
    if (!id) throw new Error('feedback row has no resolvable id (feedbackId/feedback_id/id) — cannot import');
    if (this.feedback.has(id)) throw new DuplicateImportIdError('feedback', id);
    this.feedback.set(id, structuredClone(row));
  }

  readBackClusters(): RawRow[] {
    return [...this.clusters.values()].map((r) => structuredClone(r));
  }

  readBackFeedback(): RawRow[] {
    return [...this.feedback.values()].map((r) => structuredClone(r));
  }

  /** No real schema — the runner derives one from readback (dry-run mode). */
  schemaDescriptor(): SchemaDescriptor | null {
    return null;
  }
}

/**
 * Every status literal the canonical (Instar) instance accepts on an AS-IS import:
 * the v2 lifecycle states, the full legacy v1 vocabulary (AS-IS preserves the raw
 * literal; the processor normalizes at READ time via `normalizeStatus`), and the
 * terminal-only legacy literal `legacy_closed`.
 */
export function canonicalAcceptedStatusValues(): string[] {
  return [...new Set([...V2_STATES, ...Object.keys(V1_TO_V2_STATUS), 'legacy_closed'])];
}

/**
 * Derive a SchemaDescriptor by OBSERVATION: the distinct status literals the rows
 * actually use + a field→typeof map over `fields`. Mixed-type fields surface as
 * 'mixed' (a divergence the equivalence check will flag, by design). null/undefined
 * are skipped — absence is not a type.
 */
export function deriveSchemaDescriptor(rows: RawRow[], fields: readonly string[]): SchemaDescriptor {
  const statusValues = new Set<string>();
  const fieldTypes: Record<string, string> = {};
  for (const row of rows) {
    const s = row['status'];
    if (typeof s === 'string' && s.length > 0) statusValues.add(s);
    for (const f of fields) {
      const v = row[f];
      if (v === null || v === undefined) continue;
      const t = typeof v;
      if (fieldTypes[f] === undefined) fieldTypes[f] = t;
      else if (fieldTypes[f] !== t) fieldTypes[f] = 'mixed';
    }
  }
  return { statusValues: [...statusValues].sort(), fieldTypes };
}

export interface ImportRunResult {
  /** The full integrity-gate verdict over source-vs-readback (null when aborted pre-import). */
  report: IntegrityReport | null;
  /** What the run actually wrote. Zero on a pre-import abort. */
  imported: { clusters: number; feedback: number };
  /**
   * Non-null when the run aborted BEFORE any write: the pre-import
   * fingerprint-uniqueness scan found collisions a human must resolve first
   * (spec §2.4 — an AS-IS import would abort on @unique mid-transaction or
   * silently collapse the colliding clusters).
   */
  abortedPreImport: { reason: 'fingerprint-collision'; collisions: FingerprintCollision[] } | null;
  /** True only when the run imported AND the integrity gate passed. */
  passed: boolean;
}

/**
 * Execute the AS-IS import end to end. Parent-before-child (clusters, then the
 * feedback rows that FK onto them); the integrity gate runs over what the target
 * READS BACK, not what was sent. Source schema is derived from the source rows;
 * target schema comes from the adapter when it has one, else from the readback.
 */
export function runImport(source: ImportSourceData, target: ImportTarget): ImportRunResult {
  // Pre-import gate: fingerprint uniqueness on the SOURCE, before any write.
  const collisions = scanFingerprintUniqueness(source.clusters as unknown as Cluster[]);
  if (collisions.length > 0) {
    return {
      report: null,
      imported: { clusters: 0, feedback: 0 },
      abortedPreImport: { reason: 'fingerprint-collision', collisions },
      passed: false,
    };
  }

  // AS-IS import, parent before child.
  for (const c of source.clusters) target.importClusterAsIs(c);
  for (const f of source.feedback) target.importFeedbackAsIs(f);

  // Verify what LANDED.
  const backClusters = target.readBackClusters();
  const backFeedback = target.readBackFeedback();

  const checksumFields = [...new Set<string>([...CURATED_CLUSTER_FIELDS, ...CURATED_FEEDBACK_FIELDS])];
  // statusValues come from CLUSTERS ONLY — the lifecycle vocabulary the
  // equivalence check guards is the cluster one; feedback rows carry their own
  // processing-state domain ('unprocessed'/'processed') that is not part of it.
  const sourceSchema: SchemaDescriptor = {
    statusValues: deriveSchemaDescriptor(source.clusters, checksumFields).statusValues,
    fieldTypes: deriveSchemaDescriptor([...source.clusters, ...source.feedback], checksumFields).fieldTypes,
  };
  const targetSchema: SchemaDescriptor = target.schemaDescriptor() ?? {
    // Dry-run derivation: accepted statuses are the canonical contract (catches a
    // Portal literal the Instar processor would not understand); field types are
    // observed from readback (catches type mangling through the import path).
    statusValues: canonicalAcceptedStatusValues(),
    fieldTypes: deriveSchemaDescriptor([...backClusters, ...backFeedback], checksumFields).fieldTypes,
  };

  const report = runIntegrityGate(
    { clusters: source.clusters as unknown as Cluster[], feedback: source.feedback as unknown as FeedbackItem[], schema: sourceSchema },
    { clusters: backClusters as unknown as Cluster[], feedback: backFeedback as unknown as FeedbackItem[], schema: targetSchema },
  );

  return {
    report,
    imported: { clusters: backClusters.length, feedback: backFeedback.length },
    abortedPreImport: null,
    passed: report.passed,
  };
}
