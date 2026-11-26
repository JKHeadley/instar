/** Persistence only. The active parent must verify current consent, the child
 * and writer lease, and real disk reservation before calling this recorder. */
import path from 'node:path';
import Database from 'better-sqlite3';
import { privateImportDatabasePath } from './privateImportState.js';

const MAX_ROWS = 1024;
const TABLE = 'local_history_first_permits';
const PROGRESS = 'local_history_first_permit_progress';
const fields = [
  'operationId', 'previewId', 'applyRequestId', 'intentFingerprint', 'generation', 'runId', 'reservationId',
  'previewAllocation', 'previewSha256', 'uploadFingerprint', 'deadline', 'permitId', 'fileIndex', 'destinationBinding',
  'mutationKind', 'planDigest', 'plannedBytes',
] as const;

export interface LocalHistoryFirstPermit {
  operationId: string;
  previewId: string;
  applyRequestId: string;
  intentFingerprint: string;
  generation: string;
  runId: string;
  reservationId: string;
  previewAllocation: string;
  previewSha256: string;
  uploadFingerprint: string;
  deadline: number;
  permitId: string;
  fileIndex: number;
  destinationBinding: string;
  mutationKind: 'claim' | 'append' | 'flush';
  planDigest: string;
  plannedBytes: number;
}

function refuse(reason: 'database' | 'schema' | 'invalid' | 'conflict' | 'capacity'): never {
  throw new Error('local-history-first-permit-' + reason);
}
function hex(value: unknown, length: number): boolean {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
}
function validate(record: LocalHistoryFirstPermit): void {
  if (!record || typeof record !== 'object' || Object.keys(record).length !== fields.length
    || fields.some(field => !Object.hasOwn(record, field))
    || ![record.operationId, record.previewId, record.applyRequestId, record.runId, record.reservationId,
      record.previewAllocation, record.permitId].every(value => hex(value, 32))
    || ![record.intentFingerprint, record.generation, record.previewSha256, record.uploadFingerprint,
      record.destinationBinding, record.planDigest].every(value => hex(value, 64))
    || !Number.isSafeInteger(record.deadline) || record.deadline <= 0
    || !Number.isSafeInteger(record.plannedBytes) || record.plannedBytes <= 0
    || !Number.isSafeInteger(record.fileIndex) || record.fileIndex < 0 || record.fileIndex >= MAX_ROWS
    || !['claim', 'append', 'flush'].includes(record.mutationKind)) refuse('invalid');
}

function jobsConnection(db: Database.Database, transaction: boolean): void {
  if (!(db instanceof Database) || !db.open || db.readonly || db.inTransaction !== transaction) refuse('database');
  const file = path.resolve(db.name), directory = path.dirname(file);
  if (path.basename(file) !== 'jobs.sqlite' || path.basename(directory) !== 'local-history-upload'
    || privateImportDatabasePath(directory, 'jobs.sqlite', { readOnly: true }) !== file
    || db.pragma('journal_mode', { simple: true }) !== 'delete'
    || db.pragma('synchronous', { simple: true }) !== 2) refuse('database');
}

function validateSchema(db: Database.Database): void {
  const table = db.prepare('SELECT strict FROM pragma_table_list WHERE schema = ? AND name = ?').get('main', TABLE) as
    { strict: number } | undefined;
  const columns = db.prepare(`PRAGMA main.table_info(${TABLE})`).all() as
    Array<{ name: string; type: string; pk: number; notnull: number; dflt_value: unknown }>;
  if (table?.strict !== 1 || columns.length !== fields.length || columns.some((column, index) =>
    column.name !== fields[index] || column.pk !== (index === 0 ? 1 : 0) || column.notnull !== 1 || column.dflt_value !== null
    || column.type !== (['deadline', 'fileIndex', 'plannedBytes'].includes(column.name) ? 'INTEGER' : 'TEXT'))) refuse('schema');
}

function validateProgressSchema(db: Database.Database): void {
  const table = db.prepare('SELECT strict FROM pragma_table_list WHERE schema = ? AND name = ?').get('main', PROGRESS) as
    { strict: number } | undefined;
  const columns = db.prepare(`PRAGMA main.table_info(${PROGRESS})`).all() as
    Array<{ name: string; type: string; pk: number; notnull: number; dflt_value: unknown }>;
  const expected = [['operationId', 'TEXT', 1, 1], ['stopRequested', 'INTEGER', 0, 1], ['acknowledgementDigest', 'TEXT', 0, 0]];
  if (table?.strict !== 1 || columns.length !== expected.length || columns.some((column, index) => {
    const [name, type, pk, required] = expected[index];
    return column.name !== name || column.type !== type || column.pk !== pk || column.notnull !== required || column.dflt_value !== null;
  })) refuse('schema');
}

export function initializeLocalHistoryFirstPermits(db: Database.Database): void {
  jobsConnection(db, false);
  db.exec(`CREATE TABLE IF NOT EXISTS main.${TABLE} (
    operationId TEXT PRIMARY KEY NOT NULL,
    previewId TEXT NOT NULL, applyRequestId TEXT NOT NULL, intentFingerprint TEXT NOT NULL,
    generation TEXT NOT NULL, runId TEXT NOT NULL, reservationId TEXT NOT NULL,
    previewAllocation TEXT NOT NULL, previewSha256 TEXT NOT NULL, uploadFingerprint TEXT NOT NULL,
    deadline INTEGER NOT NULL CHECK(deadline > 0), permitId TEXT NOT NULL,
    fileIndex INTEGER NOT NULL CHECK(fileIndex >= 0 AND fileIndex < 1024), destinationBinding TEXT NOT NULL,
    mutationKind TEXT NOT NULL CHECK(mutationKind IN ('claim','append','flush')),
    planDigest TEXT NOT NULL, plannedBytes INTEGER NOT NULL CHECK(plannedBytes > 0)
  ) STRICT`);
  validateSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS main.${PROGRESS} (
    operationId TEXT PRIMARY KEY NOT NULL,
    stopRequested INTEGER NOT NULL CHECK(stopRequested IN (0, 1)),
    acknowledgementDigest TEXT CHECK(acknowledgementDigest IS NULL OR length(acknowledgementDigest) = 64)
  ) STRICT`);
  validateProgressSchema(db);
}

/** Startup-only bounded inventory. A legacy connection may have no permit table. */
export function readLocalHistoryFirstPermitInventory(db: Database.Database): LocalHistoryFirstPermit[] {
  jobsConnection(db, false);
  const entry = db.prepare('SELECT type FROM main.sqlite_schema WHERE name = ?').get(TABLE) as { type: string } | undefined;
  if (!entry) return [];
  if (entry.type !== 'table') refuse('schema');
  validateSchema(db);
  const records = db.prepare(`SELECT * FROM main.${TABLE} LIMIT ?`).all(MAX_ROWS + 1) as LocalHistoryFirstPermit[];
  if (records.length > MAX_ROWS) refuse('capacity');
  for (const record of records) validate(record);
  return records;
}

/** Verify the exact committed slot in the worker's private jobs database.
 * This is a read-only prerequisite. The caller must still prove actual child
 * and writer custody and invoke only its matching one-shot mutation plan. */
export function verifyCommittedLocalHistoryFirstClaim(stateDir: string, expected: LocalHistoryFirstPermit): void {
  const permit = { ...expected };
  validate(permit);
  if (!path.isAbsolute(stateDir) || permit.mutationKind !== 'claim' || permit.fileIndex !== 0) refuse('invalid');
  const directory = path.join(stateDir, 'local-history-upload');
  const filename = privateImportDatabasePath(directory, 'jobs.sqlite', { readOnly: true });
  const db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    db.transaction(() => {
      validateSchema(db);
      const row = db.prepare(`SELECT * FROM main.${TABLE} WHERE operationId = ?`)
        .get(permit.operationId) as LocalHistoryFirstPermit | undefined;
      if (!row) refuse('conflict');
      validate(row);
      if (fields.some(field => row[field] !== permit[field])) refuse('conflict');
      const operation = db.prepare(`SELECT 1 FROM main.upload_operations
        WHERE id = ? AND phase = 'applying' AND tag = ? AND deadline = ? AND fingerprint = ?`)
        .get(permit.operationId, 'r-' + permit.generation + '-' + permit.operationId, permit.deadline, permit.uploadFingerprint);
      if (!operation) refuse('conflict');
    })();
  } finally { db.close(); }
}

/** The caller holds its jobs transaction. A nested savepoint prevents a partial
 * consume if the caller catches a write error and later commits. This function
 * never commits that outer transaction or authorizes delivery. */
export function recordLocalHistoryFirstPermit(db: Database.Database, input: LocalHistoryFirstPermit): 'recorded' | 'already-recorded' {
  jobsConnection(db, true);
  const record = { ...input };
  validate(record);
  validateSchema(db);
  return db.transaction(() => {
    const existing = db.prepare(`SELECT * FROM main.${TABLE} WHERE operationId = ?`).get(record.operationId) as LocalHistoryFirstPermit | undefined;
    if (existing) {
      validate(existing);
      if (existing.previewId !== record.previewId || existing.applyRequestId !== record.applyRequestId
        || existing.intentFingerprint !== record.intentFingerprint) refuse('conflict');
      return 'already-recorded' as const;
    }
    const progress = db.prepare('SELECT type FROM main.sqlite_schema WHERE name = ?').get(PROGRESS) as { type: string } | undefined;
    if (progress) {
      if (progress.type !== 'table') refuse('schema');
      validateProgressSchema(db);
      if (db.prepare(`SELECT 1 FROM main.${PROGRESS} WHERE operationId = ?`).get(record.operationId)) refuse('conflict');
    }
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM main.${TABLE}`).get() as { count: number };
    if (!Number.isSafeInteger(count) || count >= MAX_ROWS) refuse('capacity');
    const tag = 'r-' + record.generation + '-' + record.operationId;
    const changed = db.prepare(`UPDATE main.upload_operations SET phase = 'applying'
      WHERE id = ? AND phase = 'prepared' AND tag = ? AND deadline = ? AND fingerprint = ?
      AND EXISTS (SELECT 1 FROM main.upload_previews WHERE id = ? AND allocation = ? AND sha256 = ?)`)
      .run(record.operationId, tag, record.deadline, record.uploadFingerprint,
        record.operationId, record.previewAllocation, record.previewSha256);
    if (changed.changes !== 1) refuse('conflict');
    db.prepare(`INSERT INTO main.${TABLE} (${fields.join(', ')}) VALUES (${fields.map(field => '@' + field).join(', ')})`).run(record);
    return 'recorded' as const;
  })();
}

type FirstPermitBinding = Pick<LocalHistoryFirstPermit, 'operationId' | 'permitId' | 'runId' | 'generation'>;
type FirstPermitObservation = { kind: 'stop' } | { kind: 'acknowledge'; digest: string };

/** Observations for the exact already-issued slot. The actual coordinator
 * must establish child/message custody before recording an acknowledgement.
 * These facts do not clear the retained slot or authorize another permit. */
export function recordLocalHistoryFirstPermitObservation(db: Database.Database, binding: FirstPermitBinding,
  observation: FirstPermitObservation): { stopRequested: boolean; acknowledgementDigest: string | null } {
  jobsConnection(db, true);
  validateSchema(db);
  validateProgressSchema(db);
  const { operationId, permitId, runId, generation } = binding;
  const kind = observation.kind;
  const observedDigest = kind === 'acknowledge' ? observation.digest : null;
  if (![operationId, permitId, runId].every(value => hex(value, 32)) || !hex(generation, 64)
    || (kind !== 'stop' && (kind !== 'acknowledge' || !hex(observedDigest, 64)))) refuse('invalid');
  const slot = db.prepare(`SELECT * FROM main.${TABLE} WHERE operationId = ?`).get(operationId) as LocalHistoryFirstPermit | undefined;
  if (!slot || slot.permitId !== permitId || slot.runId !== runId || slot.generation !== generation) refuse('conflict');
  validate(slot);

  const previous = db.prepare(`SELECT stopRequested, acknowledgementDigest FROM main.${PROGRESS} WHERE operationId = ?`)
    .get(operationId) as { stopRequested: number; acknowledgementDigest: string | null } | undefined;
  if (previous && (previous.stopRequested !== 0 && previous.stopRequested !== 1
    || previous.acknowledgementDigest !== null && !hex(previous.acknowledgementDigest, 64))) refuse('invalid');
  const priorDigest = previous?.acknowledgementDigest ?? null;
  if (priorDigest && observedDigest && priorDigest !== observedDigest) refuse('conflict');
  const stopRequested = kind === 'stop' || previous?.stopRequested === 1;
  const acknowledgementDigest = priorDigest ?? observedDigest;
  if (!previous || previous.stopRequested !== Number(stopRequested) || previous.acknowledgementDigest !== acknowledgementDigest) {
    db.prepare(`INSERT INTO main.${PROGRESS} (operationId, stopRequested, acknowledgementDigest) VALUES (?, ?, ?)
      ON CONFLICT(operationId) DO UPDATE SET stopRequested = excluded.stopRequested,
        acknowledgementDigest = excluded.acknowledgementDigest`).run(operationId, Number(stopRequested), acknowledgementDigest);
  }
  return { stopRequested, acknowledgementDigest };
}
