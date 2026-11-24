import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { initializeLocalHistoryFirstPermits, recordLocalHistoryFirstPermit, recordLocalHistoryFirstPermitObservation,
  type LocalHistoryFirstPermit } from '../../src/import/LocalHistoryFirstPermit.js';
import { privateImportDatabasePath } from '../../src/import/privateImportState.js';

const directories: string[] = [], connections: Database.Database[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'first permit fixture cleanup' });
  }
});

const draft: LocalHistoryFirstPermit = {
  operationId: '0'.repeat(32), previewId: '1'.repeat(32), applyRequestId: '2'.repeat(32),
  intentFingerprint: '3'.repeat(64), generation: '4'.repeat(64), runId: '5'.repeat(32),
  reservationId: '6'.repeat(32), previewAllocation: '7'.repeat(32), previewSha256: '8'.repeat(64),
  uploadFingerprint: '9'.repeat(64), deadline: 1_900_000_000_000, permitId: 'a'.repeat(32),
  fileIndex: 0, destinationBinding: 'b'.repeat(64), mutationKind: 'claim', planDigest: 'c'.repeat(64), plannedBytes: 4096,
};
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-permit-'));
  directories.push(root);
  const staging = path.join(root, 'local-history-upload');
  fs.mkdirSync(staging, { mode: 0o700 });
  const filename = privateImportDatabasePath(staging, 'jobs.sqlite');
  const db = new Database(filename); connections.push(db);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.exec(`CREATE TABLE upload_operations (id TEXT PRIMARY KEY, phase TEXT, tag TEXT, deadline INTEGER, fingerprint TEXT);
    CREATE TABLE upload_previews (id TEXT PRIMARY KEY, allocation TEXT, sha256 TEXT)`);
  db.prepare('INSERT INTO upload_operations VALUES (?, ?, ?, ?, ?)')
    .run(draft.operationId, 'prepared', 'r-' + draft.generation + '-' + draft.operationId, draft.deadline, draft.uploadFingerprint);
  db.prepare('INSERT INTO upload_previews VALUES (?, ?, ?)').run(draft.operationId, draft.previewAllocation, draft.previewSha256);
  initializeLocalHistoryFirstPermits(db);
  return { db, filename };
}
const phase = (db: Database.Database) => db.prepare('SELECT phase FROM upload_operations').get();
const records = (db: Database.Database) => db.prepare('SELECT * FROM local_history_first_permits').all();
const recordInTransaction = (db: Database.Database, input = draft) => db.transaction(() => recordLocalHistoryFirstPermit(db, input)).immediate();

it('requires a caller transaction and a FULL-sync jobs connection', () => {
  const { db } = fixture();
  expect(() => recordLocalHistoryFirstPermit(db, draft)).toThrow('first-permit-database');
  db.pragma('synchronous = NORMAL');
  expect(() => recordInTransaction(db)).toThrow('first-permit-database');
  expect(phase(db)).toEqual({ phase: 'prepared' });
  expect(records(db)).toEqual([]);
});

it.each([
  { generation: 'f'.repeat(64) }, { deadline: draft.deadline + 1 }, { uploadFingerprint: 'f'.repeat(64) },
  { previewSha256: 'f'.repeat(64) }, { previewAllocation: 'f'.repeat(32) },
])('rejects stale durable input without consuming preview', patch => {
  const { db } = fixture();
  expect(() => recordInTransaction(db, { ...draft, ...patch })).toThrow('first-permit-conflict');
  expect(phase(db)).toEqual({ phase: 'prepared' });
  expect(records(db)).toEqual([]);
});

it('rolls back phase change if the second write fails and the outer caller catches it', () => {
  const { db } = fixture();
  db.exec(`CREATE TRIGGER fixture_refusal BEFORE INSERT ON local_history_first_permits
    BEGIN SELECT RAISE(ABORT, 'synthetic write refusal'); END;`);
  db.transaction(() => {
    expect(() => recordLocalHistoryFirstPermit(db, draft)).toThrow('synthetic write refusal');
    expect(phase(db)).toEqual({ phase: 'prepared' });
  }).immediate();
  expect(records(db)).toEqual([]);
});

it('rolls back a successful savepoint when the outer transaction rolls back', () => {
  const { db } = fixture();
  expect(() => db.transaction(() => {
    expect(recordLocalHistoryFirstPermit(db, draft)).toBe('recorded');
    expect(phase(db)).toEqual({ phase: 'applying' });
    throw new Error('synthetic outer rollback');
  }).immediate()).toThrow('synthetic outer rollback');
  expect(phase(db)).toEqual({ phase: 'prepared' });
  expect(records(db)).toEqual([]);
});

it('reopens one committed first slot and observes replay without modifying it', () => {
  const { db, filename } = fixture();
  expect(recordInTransaction(db)).toBe('recorded');
  db.close();
  const reopened = new Database(filename); connections.push(reopened);
  reopened.pragma('synchronous = FULL');
  expect(phase(reopened)).toEqual({ phase: 'applying' });
  expect(records(reopened)).toEqual([draft]);
  expect(recordInTransaction(reopened, { ...draft, permitId: 'd'.repeat(32) })).toBe('already-recorded');
  expect(() => recordInTransaction(reopened, { ...draft, applyRequestId: 'd'.repeat(32) })).toThrow('first-permit-conflict');
  expect(records(reopened)).toEqual([draft]);
});

it('rejects unbounded and unexpected fields before changing phase', () => {
  const { db } = fixture();
  expect(() => recordInTransaction(db, { ...draft, plannedBytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow('first-permit-invalid');
  expect(() => recordInTransaction(db, { ...draft, confirmationChallenge: 'unexpected private field' } as LocalHistoryFirstPermit))
    .toThrow('first-permit-invalid');
  expect(phase(db)).toEqual({ phase: 'prepared' });
  expect(records(db)).toEqual([]);
});

it('refuses a same-shaped STRICT table lacking the operation primary key', () => {
  const { db } = fixture();
  const { sql } = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'local_history_first_permits'").get() as { sql: string };
  db.exec('ALTER TABLE local_history_first_permits RENAME TO retained_fixture');
  db.exec(sql.replace('operationId TEXT PRIMARY KEY NOT NULL', 'operationId TEXT NOT NULL'));
  expect(() => recordInTransaction(db)).toThrow('first-permit-schema');
  expect(phase(db)).toEqual({ phase: 'prepared' });
  expect(records(db)).toEqual([]);
});

it('retains stop and an exact late acknowledgement across reopen without changing the issued slot', () => {
  const { db, filename } = fixture();
  const acknowledgement = { kind: 'acknowledge', digest: 'e'.repeat(64) } as const;
  expect(() => recordLocalHistoryFirstPermitObservation(db, draft, acknowledgement)).toThrow('first-permit-database');
  expect(recordInTransaction(db)).toBe('recorded');
  const observe = db.transaction((observation: Parameters<typeof recordLocalHistoryFirstPermitObservation>[2]) =>
    recordLocalHistoryFirstPermitObservation(db, draft, observation));
  expect(observe.immediate({ kind: 'stop' })).toEqual({ stopRequested: true, acknowledgementDigest: null });
  expect(observe.immediate(acknowledgement)).toEqual({ stopRequested: true, acknowledgementDigest: acknowledgement.digest });
  db.close();
  const reopened = new Database(filename); connections.push(reopened);
  reopened.pragma('synchronous = FULL');
  expect(reopened.transaction(() => recordLocalHistoryFirstPermitObservation(reopened, draft, acknowledgement)).immediate())
    .toEqual({ stopRequested: true, acknowledgementDigest: acknowledgement.digest });
  expect(() => reopened.transaction(() => recordLocalHistoryFirstPermitObservation(reopened, draft, {
    kind: 'acknowledge', digest: 'f'.repeat(64),
  })).immediate()).toThrow('first-permit-conflict');
  expect(records(reopened)).toEqual([draft]);
  expect(phase(reopened)).toEqual({ phase: 'applying' });
});

it('refuses wrong bindings and rolls back a matching observation with its outer transaction', () => {
  const { db } = fixture();
  const progress = () => db.prepare('SELECT * FROM local_history_first_permit_progress').all();
  expect(recordInTransaction(db)).toBe('recorded');
  expect(() => db.transaction(() => recordLocalHistoryFirstPermitObservation(db, { ...draft, runId: 'f'.repeat(32) }, {
    kind: 'stop',
  })).immediate()).toThrow('first-permit-conflict');
  expect(() => db.transaction(() => {
    recordLocalHistoryFirstPermitObservation(db, draft, { kind: 'stop' });
    expect(progress()).toHaveLength(1);
    throw new Error('synthetic outer rollback');
  }).immediate()).toThrow('synthetic outer rollback');
  expect(progress()).toEqual([]);
  expect(records(db)).toEqual([draft]);
});

it('refuses to inherit a matching-operation progress row with no original slot', () => {
  const { db } = fixture();
  db.prepare('INSERT INTO local_history_first_permit_progress VALUES (?, ?, ?)').run(draft.operationId, 1, 'd'.repeat(64));
  expect(() => recordInTransaction(db)).toThrow('first-permit-conflict');
  expect(phase(db)).toEqual({ phase: 'prepared' });
  expect(records(db)).toEqual([]);
});
