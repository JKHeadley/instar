/**
 * Durable outcome ledger for correction class reviews.
 *
 * A row is keyed by the correction's machine-independent dedupeKey. It is
 * deliberately separate from CorrectionLedger.status: recurrence distillation
 * and class review are independent consumers of the same correction.
 */
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';
import { scrubSecrets } from './scrubSecrets.js';

export type CorrectionOrigin = 'operator-attributed' | 'agent-self';
export type ClassReviewFillState = 'pending' | 'filled' | 'dead-lettered';
export type StandardVerdict = 'covered' | 'needs-upgrade' | 'new-standard-needed' | 'not-applicable';
export type ProcessVerdict = 'covered' | 'process-gap' | 'not-applicable';
export type ReviewConfidence = 'low' | 'medium' | 'high';
export type OutcomeLifecycle = 'proposed' | 'ratified' | 'shipped' | 'rejected' | 'deferred' | 'expired-unreviewed' | 'no-action';
export type ReviewLifecycle = 'open' | 'parked' | 'resolved' | 'superseded' | 'reopened';
export type LifecycleAuthority = 'local-authoritative' | 'remote-advisory';

export interface ClassReviewObservation {
  correctionId: string;
  correctionOrigin: CorrectionOrigin;
  machineId: string;
  recordedAt: string;
}

export interface StandardReviewResult {
  verdict: StandardVerdict;
  standardRef?: string;
  proposedDelta?: string;
  isPolicyRelaxation: boolean;
}

export interface ProcessReviewResult {
  verdict: ProcessVerdict;
  proposedDelta?: string;
}

export interface ClassReviewRecord {
  dedupeKey: string;
  semanticClassId: string;
  observations: ClassReviewObservation[];
  effectiveOrigin: CorrectionOrigin;
  fillState: ClassReviewFillState;
  standardReview?: StandardReviewResult;
  processReview?: ProcessReviewResult;
  rationale?: string;
  confidence?: ReviewConfidence;
  standardOutcome: OutcomeLifecycle;
  processOutcome: OutcomeLifecycle;
  reviewLifecycle: ReviewLifecycle;
  lifecycleAuthority: LifecycleAuthority;
  authorityMachineId: string;
  recurrenceCount: number;
  deferredTrackingId?: string;
  supersededBy?: string;
  supersessionAudit?: { actor: string; reason: string; at: string };
  initiativeId?: string;
  actionId?: string;
  attemptCount: number;
  nextAttemptAt?: string;
  deadLetteredAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ClassReviewStoreOptions {
  dbPath: string;
  machineId: string;
}
export interface ClassReviewReplicationEmitter { emitPut(record: ClassReviewRecord): void; }
export interface ClassReviewRemoteReader {
  get(dedupeKey: string): ClassReviewRecord[];
  keys(): string[];
}

export interface CollapseCandidate {
  semanticClassId: string;
  standardRef?: string;
  descriptor: string;
  score: number;
  createdAt: string;
}
export interface ClassReviewHealth {
  total: number; open: number; parked: number; reopened: number; resolved: number; superseded: number;
  expiredUnreviewed: number; deferred: number; deadLettered: number;
  duplicateFragmentationGroups: number; duplicateFragmentationRecords: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS class_reviews (
  dedupe_key TEXT PRIMARY KEY,
  semantic_class_id TEXT NOT NULL,
  observations_json TEXT NOT NULL,
  effective_origin TEXT NOT NULL,
  fill_state TEXT NOT NULL,
  standard_review_json TEXT,
  process_review_json TEXT,
  rationale TEXT,
  confidence TEXT,
  standard_outcome TEXT NOT NULL,
  process_outcome TEXT NOT NULL,
  review_lifecycle TEXT NOT NULL,
  authority_machine_id TEXT NOT NULL DEFAULT '',
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  deferred_tracking_id TEXT,
  superseded_by TEXT,
  supersession_audit_json TEXT,
  initiative_id TEXT,
  action_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  dead_lettered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_class_reviews_lifecycle ON class_reviews(review_lifecycle, updated_at);
CREATE INDEX IF NOT EXISTS idx_class_reviews_semantic ON class_reviews(semantic_class_id);
`;

const TRUE_TERMINALS = new Set<OutcomeLifecycle>(['ratified', 'shipped', 'rejected', 'no-action']);

export class ClassReviewStore {
  private readonly db: BetterSqliteDatabase;
  private readonly machineId: string;
  private replicationEmitter: ClassReviewReplicationEmitter | null = null;
  private remoteReader: ClassReviewRemoteReader | null = null;

  constructor(opts: ClassReviewStoreOptions) {
    this.machineId = opts.machineId;
    if (opts.dbPath !== ':memory:') fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = NativeModuleHealer.openWithHealSync('ClassReviewStore', () => new Database(opts.dbPath));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.migrateColumns();
    registerSqliteHandle(() => { try { this.db.close(); } catch { /* already closed */ } });
  }

  setReplicationEmitter(emitter: ClassReviewReplicationEmitter | null): void { this.replicationEmitter = emitter; }
  setRemoteReader(reader: ClassReviewRemoteReader | null): void { this.remoteReader = reader; }

  ensureShell(input: { dedupeKey: string; correctionId: string; origin: CorrectionOrigin; recordedAt?: string }): ClassReviewRecord {
    const now = input.recordedAt ?? new Date().toISOString();
    const observation: ClassReviewObservation = {
      correctionId: input.correctionId,
      correctionOrigin: input.origin,
      machineId: this.machineId,
      recordedAt: now,
    };
    const existing = this.getLocal(input.dedupeKey);
    if (existing) {
      if (!existing.observations.some((o) => o.correctionId === input.correctionId && o.machineId === this.machineId)) {
        const observations = [...existing.observations, observation];
        const effectiveOrigin = observations.some((o) => o.correctionOrigin === 'operator-attributed')
          ? 'operator-attributed' : 'agent-self';
        const recurring = existing.fillState === 'filled'
          && [existing.standardOutcome, existing.processOutcome].some(outcome => ['rejected', 'deferred', 'expired-unreviewed'].includes(outcome));
        this.db.prepare(`UPDATE class_reviews SET observations_json=?, effective_origin=?,
          review_lifecycle=CASE WHEN ? THEN 'reopened' ELSE review_lifecycle END,
          standard_outcome=CASE WHEN ? AND standard_outcome IN ('rejected','deferred','expired-unreviewed') THEN 'proposed' ELSE standard_outcome END,
          process_outcome=CASE WHEN ? AND process_outcome IN ('rejected','deferred','expired-unreviewed') THEN 'proposed' ELSE process_outcome END,
          recurrence_count=recurrence_count+?, deferred_tracking_id=CASE WHEN ? THEN NULL ELSE deferred_tracking_id END,
          updated_at=?, version=version+1 WHERE dedupe_key=?`)
          .run(JSON.stringify(observations), effectiveOrigin, recurring ? 1 : 0, recurring ? 1 : 0,
            recurring ? 1 : 0, recurring ? 1 : 0, recurring ? 1 : 0, now, input.dedupeKey);
      }
      const updated = this.getLocal(input.dedupeKey)!;
      if (updated.version !== existing.version) this.emit(updated);
      return updated;
    }
    this.db.prepare(`INSERT INTO class_reviews
      (dedupe_key, semantic_class_id, observations_json, effective_origin, fill_state,
       standard_outcome, process_outcome, review_lifecycle, authority_machine_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 'proposed', 'proposed', 'open', ?, ?, ?)`)
      .run(input.dedupeKey, input.dedupeKey, JSON.stringify([observation]), input.origin, this.machineId, now, now);
    const created = this.getLocal(input.dedupeKey)!;
    this.emit(created);
    return created;
  }

  recordAttempt(dedupeKey: string, opts: { nextAttemptAt?: string; deadLetter?: boolean } = {}): ClassReviewRecord | null {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE class_reviews SET attempt_count=attempt_count+1, next_attempt_at=?,
      fill_state=CASE WHEN ? THEN 'dead-lettered' ELSE fill_state END,
      dead_lettered_at=CASE WHEN ? THEN ? ELSE dead_lettered_at END,
      updated_at=?, version=version+1 WHERE dedupe_key=?`)
      .run(opts.nextAttemptAt ?? null, opts.deadLetter ? 1 : 0, opts.deadLetter ? 1 : 0, now, now, dedupeKey);
    const updated = this.getLocal(dedupeKey);
    if (updated) this.emit(updated);
    return updated;
  }

  fill(dedupeKey: string, input: {
    standardReview: StandardReviewResult;
    processReview: ProcessReviewResult;
    rationale: string;
    confidence: ReviewConfidence;
    semanticClassId?: string;
    initiativeId?: string;
    actionId?: string;
  }): ClassReviewRecord | null {
    const standardReview = scrubStandard(input.standardReview);
    const processReview = scrubProcess(input.processReview);
    const standardOutcome: OutcomeLifecycle = ['covered', 'not-applicable'].includes(standardReview.verdict) ? 'no-action' : 'proposed';
    const processOutcome: OutcomeLifecycle = ['covered', 'not-applicable'].includes(processReview.verdict) ? 'no-action' : 'proposed';
    const lifecycle: ReviewLifecycle = TRUE_TERMINALS.has(standardOutcome) && TRUE_TERMINALS.has(processOutcome) ? 'resolved' : 'open';
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE class_reviews SET semantic_class_id=CASE WHEN fill_state='pending' THEN COALESCE(?, semantic_class_id) ELSE semantic_class_id END, fill_state='filled',
      standard_review_json=?, process_review_json=?, rationale=?, confidence=?, standard_outcome=?, process_outcome=?,
      review_lifecycle=?, initiative_id=?, action_id=?, next_attempt_at=NULL, updated_at=?, version=version+1
      WHERE dedupe_key=? AND fill_state='pending'`)
      .run(input.semanticClassId ?? null, JSON.stringify(standardReview), JSON.stringify(processReview),
        scrubSecrets(input.rationale), input.confidence, standardOutcome, processOutcome, lifecycle,
        input.initiativeId ?? null, input.actionId ?? null, now, dedupeKey);
    const updated = this.getLocal(dedupeKey);
    if (updated) this.emit(updated);
    return updated;
  }

  get(dedupeKey: string): ClassReviewRecord | null {
    const records = [this.getLocal(dedupeKey), ...(this.remoteReader?.get(dedupeKey) ?? [])]
      .filter((record): record is ClassReviewRecord => record !== null);
    return records.length ? mergeClassReviewRecords(records) : null;
  }

  /** Local single-writer view for authorization/admission decisions. */
  getAuthoritative(dedupeKey: string): ClassReviewRecord | null { return this.getLocal(dedupeKey); }

  private getLocal(dedupeKey: string): ClassReviewRecord | null {
    const row = this.db.prepare('SELECT * FROM class_reviews WHERE dedupe_key=?').get(dedupeKey) as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : null;
  }

  list(opts: { lifecycle?: ReviewLifecycle; limit?: number } = {}): ClassReviewRecord[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const rows = opts.lifecycle
      ? this.db.prepare(`SELECT * FROM class_reviews WHERE review_lifecycle=? ORDER BY updated_at DESC LIMIT ?`).all(opts.lifecycle, limit)
      : this.db.prepare(`SELECT * FROM class_reviews ORDER BY updated_at DESC LIMIT ?`).all(limit);
    const local = (rows as Record<string, unknown>[]).map((r) => this.fromRow(r));
    const keys = new Set([...local.map((record) => record.dedupeKey), ...(this.remoteReader?.keys() ?? [])]);
    return [...keys].flatMap((key) => {
      const merged = this.get(key);
      return merged && (!opts.lifecycle || merged.reviewLifecycle === opts.lifecycle) ? [merged] : [];
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  countOpen(): number {
    return this.list({ limit: 1000 }).filter((record) => ['open', 'parked', 'reopened'].includes(record.reviewLifecycle)).length;
  }

  health(): ClassReviewHealth {
    const records = this.list({ limit: 1000 });
    const standardGroups = new Map<string, Set<string>>();
    for (const record of records) {
      const ref = canonicalStandardRef(record.standardReview?.standardRef);
      if (!ref || record.reviewLifecycle === 'superseded') continue;
      const ids = standardGroups.get(ref) ?? new Set<string>(); ids.add(record.semanticClassId); standardGroups.set(ref, ids);
    }
    const fragmented = [...standardGroups.values()].filter(ids => ids.size > 1);
    const byKey = new Map(records.map(record => [record.dedupeKey, record]));
    const laterMerged = records.filter(record => record.reviewLifecycle === 'superseded' && record.supersededBy
      && byKey.get(record.supersededBy)?.semanticClassId !== record.semanticClassId);
    return {
      total: records.length,
      open: records.filter(r => r.reviewLifecycle === 'open').length,
      parked: records.filter(r => r.reviewLifecycle === 'parked').length,
      reopened: records.filter(r => r.reviewLifecycle === 'reopened').length,
      resolved: records.filter(r => r.reviewLifecycle === 'resolved').length,
      superseded: records.filter(r => r.reviewLifecycle === 'superseded').length,
      expiredUnreviewed: records.filter(r => r.standardOutcome === 'expired-unreviewed' || r.processOutcome === 'expired-unreviewed').length,
      deferred: records.filter(r => r.standardOutcome === 'deferred' || r.processOutcome === 'deferred').length,
      deadLettered: records.filter(r => r.fillState === 'dead-lettered').length,
      duplicateFragmentationGroups: fragmented.length + laterMerged.length,
      duplicateFragmentationRecords: fragmented.reduce((sum, ids) => sum + ids.size, 0) + laterMerged.length,
    };
  }

  hasFilled(dedupeKey: string): boolean { return this.getLocal(dedupeKey)?.fillState === 'filled'; }

  findBySemanticClass(semanticClassId: string): ClassReviewRecord[] {
    return this.list({ limit: 1000 }).filter((record) => record.semanticClassId === semanticClassId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Deterministic top-K preselection. Meaning adjudication remains with the
   * bounded structured LLM call; uncertainty yields no collapse. */
  collapseCandidates(summary: string, limit = 5): CollapseCandidate[] {
    const query = tokens(summary);
    if (query.size === 0) return [];
    return this.list({ limit: 1000 })
      .filter((record) => record.fillState === 'filled' && ['open', 'reopened'].includes(record.reviewLifecycle)
        && (record.standardOutcome === 'proposed' || record.processOutcome === 'proposed'))
      .map((record) => {
        const descriptor = [record.standardReview?.standardRef, record.standardReview?.proposedDelta,
          record.processReview?.proposedDelta, record.rationale].filter(Boolean).join(' ').slice(0, 500);
        return { semanticClassId: record.semanticClassId, standardRef: record.standardReview?.standardRef,
          descriptor, score: jaccard(query, tokens(descriptor)), createdAt: record.createdAt };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt) || a.semanticClassId.localeCompare(b.semanticClassId))
      .filter((candidate, index, all) => all.findIndex((other) => other.semanticClassId === candidate.semanticClassId) === index)
      .slice(0, Math.max(1, Math.min(limit, 5)));
  }

  transitionOutcome(dedupeKey: string, arm: 'standard' | 'process', outcome: OutcomeLifecycle): ClassReviewRecord | null {
    const current = this.getLocal(dedupeKey);
    if (!current || current.fillState !== 'filled') return current;
    const standardOutcome = arm === 'standard' ? outcome : current.standardOutcome;
    const processOutcome = arm === 'process' ? outcome : current.processOutcome;
    const reviewLifecycle: ReviewLifecycle = TRUE_TERMINALS.has(standardOutcome) && TRUE_TERMINALS.has(processOutcome)
      ? 'resolved' : (standardOutcome === 'deferred' || standardOutcome === 'expired-unreviewed'
        || processOutcome === 'deferred' || processOutcome === 'expired-unreviewed') ? 'parked' : 'open';
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE class_reviews SET standard_outcome=?, process_outcome=?, review_lifecycle=?, updated_at=?, version=version+1 WHERE dedupe_key=?`)
      .run(standardOutcome, processOutcome, reviewLifecycle, now, dedupeKey);
    const updated = this.getLocal(dedupeKey);
    if (updated) this.emit(updated);
    return updated;
  }

  reopen(dedupeKey: string): ClassReviewRecord | null {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE class_reviews SET review_lifecycle='reopened',
      standard_outcome=CASE WHEN standard_outcome IN ('rejected','deferred','expired-unreviewed') THEN 'proposed' ELSE standard_outcome END,
      process_outcome=CASE WHEN process_outcome IN ('rejected','deferred','expired-unreviewed') THEN 'proposed' ELSE process_outcome END,
      updated_at=?, version=version+1 WHERE dedupe_key=?`).run(now, dedupeKey);
    const updated = this.getLocal(dedupeKey);
    if (updated) this.emit(updated);
    return updated;
  }

  attachArtifacts(dedupeKey: string, input: { initiativeId?: string; actionId?: string }): ClassReviewRecord | null {
    const current = this.getLocal(dedupeKey);
    if (!current || current.fillState !== 'filled') return current;
    const initiativeId = input.initiativeId ? scrubSecrets(input.initiativeId).slice(0, 256) : null;
    const actionId = input.actionId ? scrubSecrets(input.actionId).slice(0, 256) : null;
    this.db.prepare(`UPDATE class_reviews SET initiative_id=COALESCE(initiative_id, ?), action_id=COALESCE(action_id, ?),
      updated_at=?, version=version+1 WHERE dedupe_key=? AND ((initiative_id IS NULL AND ? IS NOT NULL) OR (action_id IS NULL AND ? IS NOT NULL))`)
      .run(initiativeId, actionId, new Date().toISOString(), dedupeKey, initiativeId, actionId);
    const result = this.getLocal(dedupeKey); if (result && result.version !== current.version) this.emit(result); return result;
  }

  defer(dedupeKey: string, arm: 'standard' | 'process', trackingId: string): ClassReviewRecord | null {
    const safe = scrubSecrets(trackingId).trim().slice(0, 256);
    if (!safe) return this.getLocal(dedupeKey);
    const updated = this.transitionOutcome(dedupeKey, arm, 'deferred');
    if (!updated) return null;
    this.db.prepare(`UPDATE class_reviews SET deferred_tracking_id=?, updated_at=?, version=version+1 WHERE dedupe_key=?`)
      .run(safe, new Date().toISOString(), dedupeKey);
    const result = this.getLocal(dedupeKey); if (result) this.emit(result); return result;
  }

  ageExpiredUnreviewed(cutoff: Date, limit = 100, activeActionIds: ReadonlySet<string> = new Set()): ClassReviewRecord[] {
    const now = new Date().toISOString();
    const keys = (this.db.prepare(`SELECT dedupe_key FROM class_reviews WHERE fill_state='filled'
      AND review_lifecycle IN ('open','reopened') AND updated_at<? ORDER BY updated_at ASC LIMIT ?`)
      .all(cutoff.toISOString(), Math.max(1, Math.min(limit, 1000))) as Array<{ dedupe_key: string }>).map(r => r.dedupe_key);
    const changed: ClassReviewRecord[] = [];
    for (const key of keys) {
      const before = this.getLocal(key);
      if (before?.actionId && activeActionIds.has(before.actionId)) continue;
      this.db.prepare(`UPDATE class_reviews SET
        standard_outcome=CASE WHEN standard_outcome='proposed' THEN 'expired-unreviewed' ELSE standard_outcome END,
        process_outcome=CASE WHEN process_outcome='proposed' THEN 'expired-unreviewed' ELSE process_outcome END,
        review_lifecycle='parked', updated_at=?, version=version+1 WHERE dedupe_key=?`).run(now, key);
      const row = this.getLocal(key); if (row) { changed.push(row); this.emit(row); }
    }
    return changed;
  }

  supersede(dedupeKey: string, supersededBy: string, audit: { actor: string; reason: string }): ClassReviewRecord | null {
    const current = this.getLocal(dedupeKey);
    const successor = this.getLocal(supersededBy);
    if (!current || !successor || dedupeKey === supersededBy) return current;
    const at = new Date().toISOString();
    const entry = { actor: scrubSecrets(audit.actor).slice(0, 128), reason: scrubSecrets(audit.reason).slice(0, 1000), at };
    if (!entry.actor || !entry.reason) return current;
    this.db.prepare(`UPDATE class_reviews SET review_lifecycle='superseded', superseded_by=?, supersession_audit_json=?,
      updated_at=?, version=version+1 WHERE dedupe_key=? AND review_lifecycle!='superseded'`)
      .run(supersededBy, JSON.stringify(entry), at, dedupeKey);
    const result = this.getLocal(dedupeKey); if (result && result.version !== current.version) this.emit(result); return result;
  }

  static toApiView(record: ClassReviewRecord): ClassReviewRecord { return structuredClone(record); }

  private emit(record: ClassReviewRecord): void {
    try { this.replicationEmitter?.emitPut(record); } catch { /* replication never breaks local outcome */ }
  }

  private fromRow(r: Record<string, unknown>): ClassReviewRecord {
    return {
      dedupeKey: String(r.dedupe_key), semanticClassId: String(r.semantic_class_id),
      observations: JSON.parse(String(r.observations_json)) as ClassReviewObservation[],
      effectiveOrigin: r.effective_origin as CorrectionOrigin, fillState: r.fill_state as ClassReviewFillState,
      ...(r.standard_review_json ? { standardReview: JSON.parse(String(r.standard_review_json)) as StandardReviewResult } : {}),
      ...(r.process_review_json ? { processReview: JSON.parse(String(r.process_review_json)) as ProcessReviewResult } : {}),
      ...(r.rationale ? { rationale: String(r.rationale) } : {}),
      ...(r.confidence ? { confidence: r.confidence as ReviewConfidence } : {}),
      standardOutcome: r.standard_outcome as OutcomeLifecycle, processOutcome: r.process_outcome as OutcomeLifecycle,
      reviewLifecycle: r.review_lifecycle as ReviewLifecycle,
      lifecycleAuthority: 'local-authoritative', authorityMachineId: String(r.authority_machine_id || this.machineId),
      recurrenceCount: Number(r.recurrence_count ?? 0),
      ...(r.deferred_tracking_id ? { deferredTrackingId: String(r.deferred_tracking_id) } : {}),
      ...(r.superseded_by ? { supersededBy: String(r.superseded_by) } : {}),
      ...(r.supersession_audit_json ? { supersessionAudit: JSON.parse(String(r.supersession_audit_json)) as ClassReviewRecord['supersessionAudit'] } : {}),
      ...(r.initiative_id ? { initiativeId: String(r.initiative_id) } : {}),
      ...(r.action_id ? { actionId: String(r.action_id) } : {}),
      attemptCount: Number(r.attempt_count), ...(r.next_attempt_at ? { nextAttemptAt: String(r.next_attempt_at) } : {}),
      ...(r.dead_lettered_at ? { deadLetteredAt: String(r.dead_lettered_at) } : {}),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at), version: Number(r.version),
    };
  }

  private migrateColumns(): void {
    const columns = new Set((this.db.prepare('PRAGMA table_info(class_reviews)').all() as Array<{ name: string }>).map(c => c.name));
    const additions: Array<[string, string]> = [
      ['authority_machine_id', `TEXT NOT NULL DEFAULT ''`], ['recurrence_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['deferred_tracking_id', 'TEXT'], ['superseded_by', 'TEXT'], ['supersession_audit_json', 'TEXT'],
    ];
    for (const [name, sql] of additions) if (!columns.has(name)) this.db.exec(`ALTER TABLE class_reviews ADD COLUMN ${name} ${sql}`);
    this.db.prepare(`UPDATE class_reviews SET authority_machine_id=? WHERE authority_machine_id=''`).run(this.machineId);
  }
}

function scrubStandard(value: StandardReviewResult): StandardReviewResult {
  return {
    verdict: value.verdict,
    ...(value.standardRef ? { standardRef: scrubSecrets(value.standardRef) } : {}),
    ...(value.proposedDelta ? { proposedDelta: scrubSecrets(value.proposedDelta) } : {}),
    isPolicyRelaxation: value.isPolicyRelaxation === true,
  };
}

function scrubProcess(value: ProcessReviewResult): ProcessReviewResult {
  return {
    verdict: value.verdict,
    ...(value.proposedDelta ? { proposedDelta: scrubSecrets(value.proposedDelta) } : {}),
  };
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((token) => token.length >= 3).slice(0, 200));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
export function canonicalStandardRef(value: string | undefined): string {
  return (value ?? '').replace(/<\/?replicated-untrusted-data>/g, '').trim().toLowerCase();
}

/** Lifecycle-monotonic fold: observations commute/add; filled beats pending or
 * dead-lettered; true terminal outcomes never regress to proposed. The newest
 * authoritative transition supplies text/ids after these monotonic clamps. */
export function mergeClassReviewRecords(records: ClassReviewRecord[]): ClassReviewRecord {
  const ordered = [...records].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.version - b.version);
  let merged = structuredClone(ordered[0]);
  for (const next of ordered.slice(1)) {
    const observations = [...merged.observations, ...next.observations].filter((observation, index, all) =>
      all.findIndex((candidate) => candidate.correctionId === observation.correctionId && candidate.machineId === observation.machineId) === index);
    const fillState: ClassReviewFillState = merged.fillState === 'filled' || next.fillState === 'filled' ? 'filled'
      : merged.fillState === 'dead-lettered' || next.fillState === 'dead-lettered' ? 'dead-lettered' : 'pending';
    // Lifecycle dispositions are single-writer state. A peer can contribute
    // observations and filled judgment text, but never ratify/reject/close the
    // local operator's row through a replicated value.
    const authority = records.find(record => record.lifecycleAuthority === 'local-authoritative') ?? merged;
    const standardOutcome = authority.standardOutcome;
    const processOutcome = authority.processOutcome;
    const reviewLifecycle: ReviewLifecycle = authority.reviewLifecycle;
    const advanced = next.version >= merged.version ? next : merged;
    merged = {
      ...advanced, observations,
      ...(authority.fillState === 'filled' ? {
        semanticClassId: authority.semanticClassId,
        standardReview: authority.standardReview,
        processReview: authority.processReview,
        rationale: authority.rationale,
        confidence: authority.confidence,
        initiativeId: authority.initiativeId,
        actionId: authority.actionId,
      } : {}),
      effectiveOrigin: observations.some((observation) => observation.correctionOrigin === 'operator-attributed') ? 'operator-attributed' : 'agent-self',
      fillState, standardOutcome, processOutcome, reviewLifecycle,
      lifecycleAuthority: authority.lifecycleAuthority,
      authorityMachineId: authority.authorityMachineId,
      attemptCount: merged.attemptCount,
      version: Math.max(merged.version, next.version),
      createdAt: merged.createdAt < next.createdAt ? merged.createdAt : next.createdAt,
      updatedAt: merged.updatedAt > next.updatedAt ? merged.updatedAt : next.updatedAt,
    };
  }
  return merged;
}

function mergeOutcome(a: OutcomeLifecycle, b: OutcomeLifecycle): OutcomeLifecycle {
  if (a === b) return a;
  if (TRUE_TERMINALS.has(b)) return b;
  if (TRUE_TERMINALS.has(a)) return a;
  const rank: Record<OutcomeLifecycle, number> = { proposed: 0, deferred: 1, 'expired-unreviewed': 1, ratified: 2, shipped: 3, rejected: 2, 'no-action': 2 };
  return rank[b] >= rank[a] ? b : a;
}
