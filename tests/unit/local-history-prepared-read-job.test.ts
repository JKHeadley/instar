import { afterEach, expect, it } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateImportDatabasePath } from '../../dist/import/privateImportState.js';
import { assertLocalHistoryDisposablePilotArtifact, assertLocalHistoryDisposablePilotState,
  LOCAL_HISTORY_DISPOSABLE_PILOT_LINES } from '../../dist/import/LocalHistoryDisposablePilot.js';
import { LocalHistoryDiskLedger } from '../../dist/import/LocalHistoryDiskLedger.js';
import { initializeLocalHistoryFirstPermits, recordLocalHistoryFirstPermit } from '../../dist/import/LocalHistoryFirstPermit.js';
import { acquireLocalHistoryStoreTemporaryAdmission, initializeLocalHistoryStoreTemporaryRuns,
  registerLocalHistoryStoreTemporaryRun } from '../../dist/import/LocalHistoryStoreTemporaryRun.js';
import { acquireLocalHistoryChild } from '../../dist/import/LocalHistoryChildCustody.js';
import { runLocalHistoryPreparedReadJob, type LocalHistoryPreparedReadJobOptions } from '../../dist/import/LocalHistoryPreparedReadJob.js';
import { parseLocalSessionLines } from '../../src/import/localSessionParsers.js';
import { localHistoryFirstClaimPlanDigest } from '../../src/import/LocalHistoryFirstClaimPlanBinding.js';
import { ImportedHistoryStore } from '../../src/import/ImportedHistoryStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
  recursive: true, force: true, operation: 'prepared read worker fixtures',
}); });
function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-read-job-')); dirs.push(stateDir);
  const syntheticSecret = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(12);
  const proposal = parseLocalSessionLines('codex', [
    JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session', cwd: '/synthetic/project' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'synthetic-user', role: 'user',
      content: [{ type: 'input_text', text: 'Synthetic secret message ' + syntheticSecret }] } }),
  ]);
  const bytes = Buffer.from(JSON.stringify(proposal));
  let released = 0, pid = 0, authorized = true;
  const opts: LocalHistoryPreparedReadJobOptions = {
    input: { stateDir, ownerUserId: 'synthetic-owner', maxArtifactBytes: 1024 * 1024,
      descriptors: [{ fileId: 'one', source: 'codex', expectedSessionId: 'synthetic-session', projectPath: '/synthetic/project',
        representation: proposal.representation, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] },
    async acquireChild() {
      const actual = acquireLocalHistoryChild(stateDir)!;
      return { custody: actual.custody, async registerChild(child) {
        if (!child.pid) throw new Error('fixture child did not start');
        pid = child.pid; await actual.registerChild(pid);
      },
        release() { if (pid) expect(() => process.kill(pid, 0)).toThrow(); actual.release(); released++; } };
    },
    authorized: () => authorized,
    async *chunks() { yield bytes; }, heapMiB: 128, perFileDeadlineMs: 10_000, rssBytes: 768 * 1024 * 1024,
  };
  return { opts, bytes, syntheticSecret, released: () => released, pid: () => pid, revoke: () => { authorized = false; } };
}
it('runs the actual fixed child and returns counts without message bodies or copied history', async () => {
  const f = fixture(); const result = await runLocalHistoryPreparedReadJob(f.opts);
  expect(result.preview.messages).toBe(1); expect(result.preview.newMessages).toBe(1);
  expect(result.preview.files[0].redactions).toBe(1);
  expect(JSON.stringify(result)).not.toContain('Synthetic secret message');
  expect(JSON.stringify(result)).not.toContain(f.syntheticSecret);
  expect(f.released()).toBe(1); expect(fs.existsSync(path.join(f.opts.input.stateDir, 'imported-history'))).toBe(false);
});
it('refuses invalid artifact bytes and releases only after the child closes', async () => {
  const f = fixture(); f.opts.input.descriptors[0] = { ...f.opts.input.descriptors[0], sha256: '0'.repeat(64) };
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-preview');
  expect(f.released()).toBe(1);
});
it('aborts a waiting input producer after actual child death', async () => {
  const f = fixture();
  f.opts.chunks = async function* (signal) {
    process.kill(f.pid(), 'SIGKILL');
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
  };
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-preview');
  expect(f.released()).toBe(1);
});
it('refuses copying a preview after owner access is revoked during input', async () => {
  const f = fixture();
  f.opts.chunks = async function* () { f.revoke(); yield f.bytes; };
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-not-authorized');
  expect(f.released()).toBe(1);
});
it('uses a deadline to abort an input producer that honors cancellation', async () => {
  const f = fixture(); f.opts.perFileDeadlineMs = 1200;
  f.opts.chunks = async function* (signal) {
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
  };
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-preview-timeout');
  expect(f.released()).toBe(1);
});

it('calculates first-claim allocation sizes in the fixed child for an existing destination', async () => {
  const f = fixture();
  const store = new ImportedHistoryStore(f.opts.input.stateDir);
  f.opts.input.includeFirstClaimPlan = true;
  const result = await runLocalHistoryPreparedReadJob(f.opts);
  const plan = result.preview.firstClaimPlan!;
  expect(plan.fileId).toBe('one');
  expect(plan.contentBytes).toBeGreaterThan(0);
  expect(plan.databaseCeilingBytes).toBeGreaterThan(0);
  expect(plan.journalBytes).toBeGreaterThan(0);
  const { ownerUserId, descriptors: [artifact] } = f.opts.input;
  const destination = result.preview.files[0].destinationFingerprint!;
  expect(plan.planDigest).toBe(localHistoryFirstClaimPlanDigest(ownerUserId, artifact, destination, plan));
  expect(plan.planDigest).not.toBe(localHistoryFirstClaimPlanDigest(ownerUserId, { ...artifact, sha256: 'f'.repeat(64) }, destination, plan));
  expect(plan.planDigest).not.toBe(localHistoryFirstClaimPlanDigest(ownerUserId, artifact, 'f'.repeat(64), plan));
  expect(plan.planDigest).not.toBe(localHistoryFirstClaimPlanDigest(ownerUserId, artifact, destination, { ...plan, journalBytes: plan.journalBytes + 1 }));
  expect(fs.existsSync(path.join(store.dir, 'source-claims.sqlite'))).toBe(false);
  expect(fs.readdirSync(path.join(store.dir, 'conversations'))).toEqual([]);
  expect(f.released()).toBe(1);
});

it('refuses first-claim planning if the destination store does not exist', async () => {
  const f = fixture();
  f.opts.input.includeFirstClaimPlan = true;
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-preview');
  expect(fs.existsSync(path.join(f.opts.input.stateDir, 'imported-history'))).toBe(false);
  expect(f.released()).toBe(1);
});

it('observes the exact first-claim plan while the real writer is held, then discards it', async () => {
  const f = fixture();
  const store = new ImportedHistoryStore(f.opts.input.stateDir);
  f.opts.input.includeFirstClaimPlan = true;
  let digest: string | undefined;
  f.opts.observeFirstClaimPlan = plan => {
    const other = new Database(path.join(store.dir, 'write-lock.sqlite'), { timeout: 0 });
    try {
      expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
      digest = plan.planDigest;
    } finally { other.close(); }
  };
  const result = await runLocalHistoryPreparedReadJob(f.opts);
  expect(digest).toBe(result.preview.firstClaimPlan?.planDigest);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(f.released()).toBe(1);
  await expect(store.withWriter(async () => true)).resolves.toBe(true);
  expect(fs.existsSync(path.join(store.dir, 'source-claims.sqlite'))).toBe(false);
});

it('closes and releases the writer if the trusted plan observer refuses', async () => {
  const f = fixture();
  const store = new ImportedHistoryStore(f.opts.input.stateDir);
  f.opts.input.includeFirstClaimPlan = true;
  f.opts.observeFirstClaimPlan = () => { throw new Error('synthetic policy refusal'); };
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-preview-claim-observation');
  expect(f.released()).toBe(1);
  await expect(store.withWriter(async () => true)).resolves.toBe(true);
  expect(fs.existsSync(path.join(store.dir, 'source-claims.sqlite'))).toBe(false);
});

it('refuses an asynchronous claim observer and owns its rejection through child close', async () => {
  const f = fixture();
  new ImportedHistoryStore(f.opts.input.stateDir);
  f.opts.input.includeFirstClaimPlan = true;
  const asyncObserver = async () => { throw new Error('synthetic asynchronous refusal'); };
  f.opts.observeFirstClaimPlan = asyncObserver as unknown as LocalHistoryPreparedReadJobOptions['observeFirstClaimPlan'];
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-preview-claim-observation');
  expect(f.released()).toBe(1);
});


it('delivers a committed synthetic claim to the fixed worker only inside a disposable home', async () => {
  const f = fixture();
  const base = path.join(fs.realpathSync(os.homedir()), '.instar', 'test-deploys');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const home = path.join(base, 'local-history-reserve-pilot-' + crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(home, { mode: 0o700 }); dirs.push(home);
  const stateDir = path.join(home, '.instar');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  expect(() => assertLocalHistoryDisposablePilotState(f.opts.input.stateDir)).toThrow('disposable-pilot-state');
  const link = path.join(base, 'local-history-reserve-pilot-' + crypto.randomBytes(16).toString('hex'));
  fs.symlinkSync(home, link); dirs.push(link);
  expect(() => assertLocalHistoryDisposablePilotState(path.join(link, '.instar'))).toThrow('disposable-pilot-state');
  expect(() => assertLocalHistoryDisposablePilotArtifact(f.opts.input.ownerUserId, f.opts.input.descriptors[0]))
    .toThrow('disposable-pilot-artifact');
  const bytes = Buffer.from(JSON.stringify(parseLocalSessionLines('codex', [...LOCAL_HISTORY_DISPOSABLE_PILOT_LINES])));
  const descriptor = { ...f.opts.input.descriptors[0], bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const store = new ImportedHistoryStore(stateDir);
  const ledger = new LocalHistoryDiskLedger(stateDir);
  const lease = acquireLocalHistoryStoreTemporaryAdmission(stateDir)!;
  const db = new Database(privateImportDatabasePath(path.join(stateDir, 'local-history-upload'), 'jobs.sqlite'));
  db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE upload_operations(id TEXT PRIMARY KEY, tag TEXT NOT NULL, phase TEXT NOT NULL, deadline INTEGER NOT NULL, fingerprint TEXT); CREATE TABLE upload_previews(id TEXT PRIMARY KEY, allocation TEXT, sha256 TEXT)');
  initializeLocalHistoryStoreTemporaryRuns(db);
  initializeLocalHistoryFirstPermits(db);
  const operationId = '1'.repeat(32), deadline = Date.now() + 60_000, generation = lease.custody.generation;
  const fingerprint = '2'.repeat(64), previewAllocation = '3'.repeat(32), previewSha256 = '4'.repeat(64);
  db.prepare('INSERT INTO upload_operations VALUES(?,?,?,?,?)').run(operationId, 'r-' + generation + '-' + operationId, 'prepared', deadline, fingerprint);
  db.prepare('INSERT INTO upload_previews VALUES(?,?,?)').run(operationId, previewAllocation, previewSha256);
  const run = registerLocalHistoryStoreTemporaryRun(db, lease, { operationId });
  const pin = ledger.pinCopyVolume([store.dir]);
  const plannedBytes = 1024 * 1024;
  const reservation = ledger.createCopyRunReservation(lease, operationId, pin, plannedBytes, plannedBytes);
  const claimFile = path.join(store.dir, 'source-claims.sqlite');
  const contender = new Database(path.join(store.dir, 'write-lock.sqlite'), { timeout: 0 });
  let childPid: number | undefined, committed = false, released = false;
  try {
    const result = await runLocalHistoryPreparedReadJob({
      ...f.opts,
      input: { ...f.opts.input, stateDir, descriptors: [descriptor], includeFirstClaimPlan: true },
      async *chunks() { yield bytes; },
      authorized: () => !committed,
      async acquireChild() {
        return { custody: lease.custody,
          async registerChild(child) { childPid = child.pid; return run.registerChild(child); },
          release() {
            expect(childPid).toBeDefined();
            expect(() => process.kill(childPid!, 0)).toThrow();
            run.cleanupAfterChild();
            reservation.releaseAfterSettlement();
            released = true;
          } };
      },
      pilotCommit(plan, destinations, pilotRun) {
        expect(fs.existsSync(claimFile)).toBe(false);
        expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
        reservation.assertCovers(plannedBytes);
        const permit = {
          operationId, previewId: '5'.repeat(32), applyRequestId: '6'.repeat(32), intentFingerprint: '7'.repeat(64),
          generation, runId: pilotRun.runId, reservationId: reservation.allocationId, previewAllocation, previewSha256,
          uploadFingerprint: fingerprint, deadline, permitId: '8'.repeat(32), fileIndex: 0, mutationKind: 'claim' as const,
          destinationBinding: destinations[0].destinationFingerprint!, planDigest: plan.planDigest, plannedBytes,
        };
        expect(db.transaction(() => recordLocalHistoryFirstPermit(db, permit)).immediate()).toBe('recorded');
        committed = true;
        return permit;
      },
    });
    expect(result.preview.firstClaimPlan?.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(committed && released).toBe(true);
    expect(fs.statSync(claimFile).size).toBeGreaterThan(0);
  } finally {
    contender.close(); pin.close(); db.close(); ledger.close(); lease.release();
  }
});
