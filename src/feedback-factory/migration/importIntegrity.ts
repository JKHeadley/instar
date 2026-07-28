/**
 * importIntegrity.ts — the integrity-safe import core (spec §2.4).
 *
 * "Row counts + spot-check" is too weak to catch silent corruption of the irreplaceable
 * curated state. This module is the pure, deterministic core of the AS-IS import gate;
 * the real Prisma adapter wraps these in one transaction (parent-before-child FK order)
 * and runs the synthetic post-import insert. Keeping the logic pure makes the Phase-2
 * gate fully unit-testable without a database.
 *
 * The gate (spec §2.4): per-row curated-field checksums match (in vs out) + pre-import
 * fingerprint-uniqueness resolved + schema-equivalence holds + FK referential integrity
 * + a sequence reset computed so the next post-cutover insert cannot collide (P2002).
 */

import { createHash } from 'node:crypto';
import type { Cluster, FeedbackItem } from '../processor/types.js';

/**
 * Curated cluster fields whose exact preservation the checksum guards. The cluster table
 * is curated human/LLM judgment, not a cache — every one of these must survive AS-IS.
 */
export const CURATED_CLUSTER_FIELDS = [
  'clusterId',
  'title',
  'description',
  'type',
  'status',
  'fingerprint',
  'recurrenceCount',
  'reportCount',
  'createdAt',
  'fixedInVersion',
  'fixAppliedAt',
  'dispatchedAt',
  'governanceNotes',
  'processingNotes',
  'actionTaken',
  'researchNotes',
  'chronicCount',
] as const;

/** Curated feedback fields (the report rows linked to clusters). */
export const CURATED_FEEDBACK_FIELDS = [
  'feedbackId',
  'title',
  'description',
  'type',
  'status',
  'receivedAt',
  'instarVersion',
] as const;

/**
 * Canonicalize a value for checksumming so that semantically-identical rows hash equal
 * across the source→target hop. null and undefined and "" all collapse to "" (the
 * null-vs-empty governance-note distinction is asserted separately by schema-equivalence;
 * the checksum must not flap on it). Everything else is JSON-stringified.
 */
function canonicalValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
  return JSON.stringify(v);
}

/** Deterministic checksum over the named fields of a row (field order fixed by `fields`). */
export function curatedChecksum(row: Record<string, unknown>, fields: readonly string[]): string {
  const h = createHash('sha256');
  for (const f of fields) {
    h.update(f);
    h.update('\x1f'); // unit separator: field-name | value
    h.update(canonicalValue(row[f]));
    h.update('\x1e'); // record separator after each field (no cross-field run ambiguity)
  }
  return h.digest('hex');
}

export function clusterChecksum(cluster: Cluster): string {
  return curatedChecksum(cluster as Record<string, unknown>, CURATED_CLUSTER_FIELDS);
}
export function feedbackChecksum(item: FeedbackItem): string {
  return curatedChecksum(item as Record<string, unknown>, CURATED_FEEDBACK_FIELDS);
}

export interface ChecksumMismatch {
  id: string;
  kind: 'cluster' | 'feedback';
  reason: 'missing-in-target' | 'extra-in-target' | 'checksum-differs';
  sourceChecksum?: string;
  targetChecksum?: string;
}

/**
 * Compare source rows (Dawn's export) against imported rows (canonical instance) by id,
 * field-by-field via checksum. Returns every divergence — empty array == clean import.
 */
export function verifyImportChecksums(
  source: { clusters: Cluster[]; feedback: FeedbackItem[] },
  target: { clusters: Cluster[]; feedback: FeedbackItem[] },
): ChecksumMismatch[] {
  const out: ChecksumMismatch[] = [];

  const verify = <T extends Record<string, unknown>>(
    kind: 'cluster' | 'feedback',
    idField: string,
    src: T[],
    tgt: T[],
    checksum: (row: T) => string,
  ) => {
    const tgtById = new Map(tgt.map((r) => [String(r[idField]), r]));
    const seen = new Set<string>();
    for (const s of src) {
      const id = String(s[idField]);
      seen.add(id);
      const t = tgtById.get(id);
      if (!t) {
        out.push({ id, kind, reason: 'missing-in-target', sourceChecksum: checksum(s) });
        continue;
      }
      const sc = checksum(s);
      const tc = checksum(t);
      if (sc !== tc) out.push({ id, kind, reason: 'checksum-differs', sourceChecksum: sc, targetChecksum: tc });
    }
    for (const t of tgt) {
      const id = String(t[idField]);
      if (!seen.has(id)) out.push({ id, kind, reason: 'extra-in-target', targetChecksum: checksum(t) });
    }
  };

  verify('cluster', 'clusterId', source.clusters, target.clusters, (c) => clusterChecksum(c as Cluster));
  verify('feedback', 'feedbackId', source.feedback, target.feedback, (f) => feedbackChecksum(f as FeedbackItem));
  return out;
}

/** A set of clusters that collide on `fingerprint` (the @unique constraint would abort the import). */
export interface FingerprintCollision {
  fingerprint: string;
  clusterIds: string[];
}

/**
 * Pre-import uniqueness scan on the SOURCE: curated history may hold two clusters sharing a
 * fingerprint (after manual merges/edits). An AS-IS import would abort on @unique mid-txn or
 * silently collapse them — detect + surface BEFORE importing so a human resolves it.
 */
export function scanFingerprintUniqueness(clusters: Cluster[]): FingerprintCollision[] {
  const byFp = new Map<string, string[]>();
  for (const c of clusters) {
    const fp = typeof c.fingerprint === 'string' ? c.fingerprint : '';
    if (!fp) continue; // a missing fingerprint isn't a @unique collision
    const arr = byFp.get(fp) ?? [];
    arr.push(c.clusterId);
    byFp.set(fp, arr);
  }
  const out: FingerprintCollision[] = [];
  for (const [fingerprint, clusterIds] of byFp) {
    if (clusterIds.length > 1) out.push({ fingerprint, clusterIds });
  }
  return out;
}

/** A field whose value-domain differs between Dawn's schema and the canonical instance. */
export interface SchemaDivergence {
  field: string;
  kind: 'unknown-status-value' | 'type-mismatch' | 'missing-field';
  detail: string;
}

export interface SchemaDescriptor {
  /** Allowed lifecycle status values (enum or string union). */
  statusValues: string[];
  /** Field → declared type, for the fields the processor reads. */
  fieldTypes: Record<string, string>;
}

/**
 * Schema-equivalence assertion: every status value the SOURCE uses must be accepted by the
 * TARGET, and the field types must line up. Mismatched enums or a status the target rejects
 * would corrupt the import silently — surface it before the transaction.
 */
export function assertSchemaEquivalence(source: SchemaDescriptor, target: SchemaDescriptor): SchemaDivergence[] {
  const out: SchemaDivergence[] = [];
  const targetStatus = new Set(target.statusValues);
  for (const s of source.statusValues) {
    if (!targetStatus.has(s)) {
      out.push({ field: 'status', kind: 'unknown-status-value', detail: `target does not accept status "${s}"` });
    }
  }
  for (const [field, srcType] of Object.entries(source.fieldTypes)) {
    const tgtType = target.fieldTypes[field];
    if (tgtType === undefined) {
      out.push({ field, kind: 'missing-field', detail: `target schema has no field "${field}"` });
    } else if (tgtType !== srcType) {
      out.push({ field, kind: 'type-mismatch', detail: `source ${srcType} vs target ${tgtType}` });
    }
  }
  return out;
}

/** A feedback row pointing at a cluster that does not exist in the import set. */
export interface DanglingRef {
  feedbackId: string;
  clusterId: string;
}

/**
 * FK referential-integrity check (not just row counts): every feedback row that claims a
 * clusterId must resolve to an imported cluster. Run AFTER the parent-before-child import
 * to prove no dangling references survived.
 */
export function checkReferentialIntegrity(clusters: Cluster[], feedback: FeedbackItem[]): DanglingRef[] {
  const clusterIds = new Set(clusters.map((c) => c.clusterId));
  const out: DanglingRef[] = [];
  for (const f of feedback) {
    const cid = (f as Record<string, unknown>).clusterId;
    if (typeof cid === 'string' && cid.length > 0 && !clusterIds.has(cid)) {
      out.push({ feedbackId: f.feedbackId, clusterId: cid });
    }
  }
  return out;
}

/**
 * The next auto-increment value to set after importing explicit PKs, so the next NEW
 * post-cutover insert cannot collide (P2002). Returns maxNumericId + 1, or 1 if no numeric
 * ids were imported. Non-numeric ids are ignored (cuid/uuid PKs need no sequence reset).
 */
export function planSequenceReset(importedIds: Array<string | number>): number {
  let max = 0;
  for (const id of importedIds) {
    const n = typeof id === 'number' ? id : Number(id);
    if (Number.isFinite(n) && n > max) max = Math.floor(n);
  }
  return max + 1;
}

export interface IntegrityReport {
  fingerprintCollisions: FingerprintCollision[];
  schemaDivergences: SchemaDivergence[];
  checksumMismatches: ChecksumMismatch[];
  danglingRefs: DanglingRef[];
  sequenceResetTo: number;
  /** True only when EVERY check is clean — the Phase-2/4 import gate. */
  passed: boolean;
}

/**
 * Run the full integrity gate over a source export and its imported copy. `passed` is the
 * single Phase-2/4 gate boolean; any non-empty divergence list fails it.
 */
export function runIntegrityGate(
  source: { clusters: Cluster[]; feedback: FeedbackItem[]; schema: SchemaDescriptor },
  target: { clusters: Cluster[]; feedback: FeedbackItem[]; schema: SchemaDescriptor },
): IntegrityReport {
  const fingerprintCollisions = scanFingerprintUniqueness(source.clusters);
  const schemaDivergences = assertSchemaEquivalence(source.schema, target.schema);
  const checksumMismatches = verifyImportChecksums(source, target);
  const danglingRefs = checkReferentialIntegrity(target.clusters, target.feedback);
  const sequenceResetTo = planSequenceReset(target.clusters.map((c) => c.clusterId));
  const passed =
    fingerprintCollisions.length === 0 &&
    schemaDivergences.length === 0 &&
    checksumMismatches.length === 0 &&
    danglingRefs.length === 0;
  return { fingerprintCollisions, schemaDivergences, checksumMismatches, danglingRefs, sequenceResetTo, passed };
}
