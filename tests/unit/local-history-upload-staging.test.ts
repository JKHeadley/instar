import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { performance as monotonicClock } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { LocalHistoryUploadStaging, type LocalHistoryStagingIssuer } from '../../dist/import/LocalHistoryUploadStaging.js';
import { LOCAL_HISTORY_DISPOSABLE_PILOT_LINES } from '../../dist/import/LocalHistoryDisposablePilot.js';
import { LocalHistoryDiskLedger } from '../../dist/import/LocalHistoryDiskLedger.js';
import { LOCAL_HISTORY_PLAINTEXT_BYTES } from '../../src/import/LocalHistoryChannel.js';
import { SafeFsExecutor } from '../../dist/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../dist/monitoring/DegradationReporter.js';
import { ImportedHistoryStore } from '../../dist/import/ImportedHistoryStore.js';
import { initializeLocalHistoryFirstPermits, recordLocalHistoryFirstPermit } from '../../dist/import/LocalHistoryFirstPermit.js';
import { registerLocalHistoryStoreTemporaryRun } from '../../dist/import/LocalHistoryStoreTemporaryRun.js';

const roots: string[] = [], stages: LocalHistoryUploadStaging[] = [];
const parents: ChildProcess[] = [], sockets: string[] = [];
const device = { deviceId: 'synthetic-device', deviceKeyHash: 'synthetic-device-key' };
const issuer: LocalHistoryStagingIssuer = { agentId: 'synthetic-agent', machineId: 'synthetic-machine', bootId: 'synthetic-boot',
  origin: 'https://synthetic.example', signingKeyHash: 'a'.repeat(64) };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) await release(socket).catch(() => {});
  for (const parent of parents.splice(0)) if (parent.exitCode === null && parent.signalCode === null) {
    const exit = once(parent, 'exit'); parent.send('stop');
    const timer = setTimeout(() => parent.kill('SIGKILL'), 2000); await exit; clearTimeout(timer);
  }
  for (const stage of stages.splice(0)) await stage.stop();
  DegradationReporter.resetForTesting();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'synthetic staging fixture cleanup' });
});
function release(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath), timer = setTimeout(() => socket.destroy(new Error('synthetic holder timeout')), 2000);
    socket.on('connect', () => socket.write('release'));
    socket.on('data', () => {});
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', hadError => { clearTimeout(timer); if (!hadError) resolve(); });
  });
}
function setup(options: { ttl?: number; stateDir?: string; boot?: string; clock?: () => number } = {}) {
  const stateDir = options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'local-upload-staging-'));
  if (!options.stateDir) roots.push(stateDir);
  let currentOwner: string | null = 'synthetic-owner', key = device.deviceKeyHash;
  let currentIssuer = { ...issuer, bootId: options.boot ?? issuer.bootId };
  let extra = 128 * 1024 ** 2;
  const disk = () => {
    const root = path.join(stateDir, 'local-history-upload', 'blocks');
    const physical = fs.existsSync(root) ? fs.readdirSync(root).reduce((sum, name) => sum + fs.statSync(path.join(root, name)).size, 0) : 0;
    return { total: 100 * 1024 ** 3, free: 5 * 1024 ** 3 + extra - physical };
  };
  const stage = new LocalHistoryUploadStaging({ stateDir, disk, now: options.clock, uploadTtlMs: options.ttl,
    issuer: () => currentIssuer,
    principal: request => currentOwner !== null && request.deviceId === device.deviceId && request.deviceKeyHash === key
      ? { ...request, ownerUserId: currentOwner } : null,
  });
  stages.push(stage);
  const manifest = (contents: Buffer[], challenge = stage.challenge(device).challenge, requestId = crypto.randomBytes(16).toString('hex')) => ({
    bootId: currentIssuer.bootId, selectionChallenge: challenge, selectionRequestId: requestId, targetMachineId: issuer.machineId,
    purpose: 'upload-selected-local-conversations', project: '/synthetic/project',
    files: contents.map((bytes, index) => ({ fileId: 'file-' + index, source: index % 2 ? 'claude-code' : 'codex', displayName: 'renamed-' + index + '.jsonl',
      expectedSessionId: 'synthetic-session-' + index, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })),
  });
  return { stage, stateDir, disk, manifest, owner: (value: string | null) => { currentOwner = value; }, key: (value: string) => { key = value; },
    issuer: (value: Partial<LocalHistoryStagingIssuer>) => { currentIssuer = { ...currentIssuer, ...value }; }, pressure: (value: number) => { extra = value; } };
}
async function until(work: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!work()) { if (Date.now() >= deadline) throw new Error('synthetic lifecycle timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function upload(stage: LocalHistoryUploadStaging, operation: string, file: string, bytes: Buffer) {
  for (let offset = 0, index = 0; offset < bytes.length; offset += LOCAL_HISTORY_PLAINTEXT_BYTES, index++) {
    stage.write(device, operation, file, index, bytes.subarray(offset, offset + LOCAL_HISTORY_PLAINTEXT_BYTES));
  }
}
it('allocates canonical operation identity at grant time and verifies exact raw bytes asynchronously', async () => {
  const f = setup(), bytes = Buffer.from('synthetic selected bytes'), manifest = f.manifest([bytes]);
  const granted = f.stage.admit(device, manifest);
  expect(granted.operationId).toBe(granted.uploadId);
  expect(granted.phase).toBe('uploading');
  expect(granted.files).toEqual([{ fileId: 'file-0', plaintextOffset: 0, nextExpectedChunk: 0 }]);
  upload(f.stage, granted.operationId, 'file-0', bytes);
  const completed = f.stage.complete(device, granted.operationId);
  expect(completed.phase).toBe('verifying');
  expect(f.stage.complete(device, granted.operationId).operationId).toBe(granted.operationId);
  await until(() => f.stage.status(device, granted.operationId).phase === 'verified');
  expect(f.stage.status(device, granted.operationId).files[0].plaintextOffset).toBe(bytes.length);
});
it('prepares both source kinds through real children and retires raw files without copying history', async () => {
  const f = setup();
  const codex = Buffer.from([
    { type: 'session_meta', payload: { id: 'synthetic-session-0', cwd: '/synthetic/project', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic codex text' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const claude = Buffer.from(JSON.stringify({ type: 'user', sessionId: 'synthetic-session-1', cwd: '/synthetic/project', uuid: 'synthetic-message',
    message: { role: 'user', content: 'synthetic claude text' } }));
  const grant = f.stage.admit(device, f.manifest([codex, claude]));
  upload(f.stage, grant.operationId, 'file-0', codex); upload(f.stage, grant.operationId, 'file-1', claude);
  f.stage.complete(device, grant.operationId);
  await until(() => f.stage.status(device, grant.operationId).phase === 'verified');
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try {
    const record = db.prepare('SELECT plan FROM upload_operations WHERE id = ?').get(grant.operationId) as {plan: string};
    const plan = JSON.parse(ledger.read(record.plan, 0, 1024 * 1024).toString());
    expect(f.stage.prepare(device, grant.operationId).phase).toBe('preparing');
    expect(f.stage.prepare(device, grant.operationId).operationId).toBe(grant.operationId);
    await until(() => {
      const phase = f.stage.status(device, grant.operationId).phase;
      expect(phase).not.toBe('interrupted'); return phase === 'prepared';
    });
    const status = f.stage.status(device, grant.operationId);
    expect(status.preparation?.map(file => file.representation)).toEqual(['canonical', 'claude-records']);
    expect(status.files.map(file => file.plaintextOffset)).toEqual([codex.length, claude.length]);
    expect(JSON.stringify(status)).not.toContain('allocation');
    for (const file of plan.files) expect(ledger.inspect(file.allocation).state).toBe('disposed');
    const prepared = db.prepare('SELECT allocation FROM upload_preparations WHERE id = ?').get(grant.operationId) as {allocation: string};
    const artifacts = JSON.parse(ledger.read(prepared.allocation, 0, 1024 * 1024).toString());
    for (const [index, file] of artifacts.files.entries()) {
      const bytes = ledger.read(file.allocation, 0, file.bytes);
      try {
        expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
        expect(JSON.parse(bytes.toString()).conversation.messages[0].text).toBe(index === 0 ? 'synthetic codex text' : 'synthetic claude text');
      } finally { bytes.fill(0); }
    }
    expect(fs.existsSync(path.join(f.stateDir, 'imported-history'))).toBe(false);
    const { preview, rssProtection } = await f.stage.readPreparedPreview(device, grant.operationId);
    expect(['sampled', 'unavailable']).toContain(rssProtection);
    expect(preview.files.map(file => file.source)).toEqual(['codex', 'claude-code']);
    expect(preview.messages).toBe(2); expect(preview.newMessages).toBe(2);
    expect(JSON.stringify(preview)).not.toContain('synthetic codex text');
    expect(JSON.stringify(preview)).not.toContain('synthetic claude text');
    expect(f.stage.status(device, grant.operationId).expiresAt).toBe(status.expiresAt);
    expect(db.prepare('SELECT count(*) AS n FROM upload_previews').get()).toEqual({ n: 0 });
    const reader = vi.spyOn(f.stage, 'readPreparedPreview');
    const pendingCandidate = f.stage.publishPreparedPreview(device, grant.operationId);
    const [first, concurrent] = await Promise.allSettled([
      pendingCandidate,
      f.stage.publishPreparedPreview(device, grant.operationId),
    ]);
    expect(concurrent).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('busy') }) });
    if (first.status === 'rejected') throw first.reason;
    const candidate = first.value;
    expect(candidate.preview).toEqual(preview);
    expect(candidate.readerRssProtection).toBe((await reader.mock.results[0].value).rssProtection);
    expect(candidate.projects).toEqual(preview.files.map(file => expect.objectContaining({
      source: file.source, projectPath: file.projectPath, files: 1, messages: 1, newMessages: 1, existingMessages: 0,
    })));
    expect(JSON.stringify(candidate.projects)).not.toContain('fileId');
    expect(candidate.expiresAt).toBe(status.expiresAt);
    expect(candidate.confirmation.action).toBe('copy-selected-history');
    const sealed = db.prepare('SELECT allocation,sha256 FROM upload_previews WHERE id = ?').get(grant.operationId) as {allocation: string; sha256: string};
    expect(ledger.inspect(sealed.allocation).state).toBe('sealed');
    const stored = ledger.read(sealed.allocation, 0, ledger.inspect(sealed.allocation).written);
    expect(crypto.createHash('sha256').update(stored).digest('hex')).toBe(sealed.sha256);
    expect(JSON.parse(stored.toString()).receipt).toEqual(candidate);
    const material = f.stage.readOwnerConsentPreview(device, grant.operationId);
    expect(material).toEqual({
      operationId: grant.operationId, previewId: candidate.previewId, previewDigest: sealed.sha256,
      ownerUserId: 'synthetic-owner', expiresAt: candidate.expiresAt,
      destination: { machineId: issuer.machineId, machineKeyHash: issuer.signingKeyHash, agentId: issuer.agentId,
        ownerUserId: 'synthetic-owner', bootId: issuer.bootId, origin: issuer.origin },
      artifacts: artifacts.files.map((file, index) => ({
        fileId: file.fileId, kind: preview.files[index].source, artifactDigest: file.sha256,
      })),
    });
    expect(Object.isFrozen(material.artifacts) && Object.isFrozen(material.destination)).toBe(true);
    expect(JSON.stringify(material)).not.toContain(candidate.confirmation.challenge);
    expect(() => f.stage.readOwnerConsentPreview({ ...device, deviceKeyHash: 'f'.repeat(64) }, grant.operationId)).toThrow('upload-unavailable');
    const previewFd = fs.openSync(path.join(f.stateDir, 'local-history-upload', 'blocks', sealed.allocation), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.writeSync(previewFd, Buffer.from([stored[0] ^ 1]), 0, 1, 0)).toBe(1);
      expect(() => f.stage.readOwnerConsentPreview(device, grant.operationId)).toThrow('upload-unavailable');
    } finally {
      fs.writeSync(previewFd, stored.subarray(0, 1), 0, 1, 0);
      fs.closeSync(previewFd);
    }
    expect(JSON.stringify(f.stage.status(device, grant.operationId))).not.toContain(candidate.confirmation.challenge);
    expect(await f.stage.publishPreparedPreview(device, grant.operationId)).toEqual(candidate);
    expect(db.prepare('SELECT count(*) AS n FROM upload_previews').get()).toEqual({ n: 1 });
    const intent = { previewId: candidate.previewId, machineId: candidate.machineId, bootId: issuer.bootId,
      confirmationChallenge: candidate.confirmation.challenge, applyRequestId: 'a'.repeat(32) };
    // Replay describes the original observation. Rereading the same prepared
    // selection detects same-length corruption in the last normalized file.
    const lastArtifact = artifacts.files.at(-1);
    const artifactPath = path.join(f.stateDir, 'local-history-upload', 'blocks', lastArtifact.allocation);
    const artifactFd = fs.openSync(artifactPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    const firstByte = Buffer.alloc(1);
    try {
      expect(fs.readSync(artifactFd, firstByte, 0, 1, 0)).toBe(1);
      const identity = fs.fstatSync(artifactFd);
      expect(fs.writeSync(artifactFd, Buffer.from([firstByte[0] ^ 1]), 0, 1, 0)).toBe(1);
      expect(fs.fstatSync(artifactFd)).toMatchObject({ ino: identity.ino, size: identity.size });
      expect(await f.stage.publishPreparedPreview(device, grant.operationId)).toEqual(candidate);
      await expect(f.stage.preflightCopyIntent(device, grant.operationId, intent)).rejects.toThrow('upload-unavailable');
    } finally {
      fs.writeSync(artifactFd, firstByte, 0, 1, 0);
      fs.closeSync(artifactFd);
    }
    const inspected = f.stage.inspectCopyIntent(device, grant.operationId, intent);
    expect(inspected.requestId).toBe(intent.applyRequestId);
    const checked = f.stage.preflightCopyIntent(device, grant.operationId, intent);
    intent.applyRequestId = 'c'.repeat(32);
    try {
      expect(await checked).toEqual(inspected);
    } finally { intent.applyRequestId = inspected.requestId; }
    expect(f.stage.inspectCopyIntent(device, grant.operationId, intent)).toEqual(inspected);
    expect(f.stage.inspectCopyIntent(device, grant.operationId, { ...intent, applyRequestId: 'b'.repeat(32) }).fingerprint)
      .not.toBe(inspected.fingerprint);
    for (const change of [{ bootId: 'other-boot' }, { machineId: 'wrong-target' },
      { previewId: 'b'.repeat(32) }, { confirmationChallenge: Buffer.alloc(32).toString('base64') }]) {
      expect(() => f.stage.inspectCopyIntent(device, grant.operationId, { ...intent, ...change })).toThrow();
    }
    f.owner('other-owner');
    await expect(f.stage.publishPreparedPreview(device, grant.operationId)).rejects.toThrow();
    expect(() => f.stage.inspectCopyIntent(device, grant.operationId, intent)).toThrow();
    f.owner('synthetic-owner');
    db.prepare('UPDATE upload_previews SET sha256 = ? WHERE id = ?').run('0'.repeat(64), grant.operationId);
    await expect(f.stage.publishPreparedPreview(device, grant.operationId)).rejects.toThrow('upload-unavailable');
    expect(() => f.stage.inspectCopyIntent(device, grant.operationId, intent)).toThrow('upload-unavailable');
    expect(fs.existsSync(path.join(f.stateDir, 'imported-history'))).toBe(false);
    expect(f.stage.complete(device, grant.operationId).phase).toBe('prepared');
  } finally { db.close(); ledger.close(); }
});
it('keeps explicit preview retryable while the actual destination writer is locked', async () => {
  const f = setup();
  const store = new ImportedHistoryStore(f.stateDir);
  fs.mkdirSync(path.join(store.dir, '.local-history-temporary'), { mode: 0o700 });
  const bytes = Buffer.from([
    { type: 'session_meta', payload: { id: 'synthetic-session-0', cwd: '/synthetic/project', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic content' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const grant = f.stage.admit(device, f.manifest([bytes]));
  upload(f.stage, grant.operationId, 'file-0', bytes);
  f.stage.complete(device, grant.operationId);
  await until(() => f.stage.status(device, grant.operationId).phase === 'verified');
  f.stage.prepare(device, grant.operationId);
  await until(() => f.stage.status(device, grant.operationId).phase === 'prepared');
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try {
    const plan = db.prepare('SELECT allocation FROM upload_preparations WHERE id = ?').get(grant.operationId) as { allocation: string };
    const { files } = JSON.parse(ledger.read(plan.allocation, 0, 1024 * 1024).toString()) as { files: Array<{ allocation: string }> };
    const reads = vi.spyOn(LocalHistoryDiskLedger.prototype, 'read');
    await store.withWriter(async () => {
      await expect(f.stage.publishPreparedPreview(device, grant.operationId)).rejects.toThrow('upload-busy');
      expect(reads.mock.calls.some(([id]) => id === files[0].allocation)).toBe(false);
      expect(db.prepare('SELECT count(*) AS n FROM upload_previews').get()).toEqual({ n: 0 });
    });
    const retry = await f.stage.publishPreparedPreview(device, grant.operationId);
    expect(retry.expiresAt).toBe(grant.expiresAt);
    expect(retry.preview.newMessages).toBe(1);
    const intent = { previewId: retry.previewId, machineId: retry.machineId, bootId: issuer.bootId,
      confirmationChallenge: retry.confirmation.challenge, applyRequestId: 'b'.repeat(32) };
    const blockBytes = fs.statfsSync(f.stateDir).bsize;
    const policy = { blockBytes, perWriteMetadataBytes: blockBytes, maxReservationBytes: 1024 * 1024, maxAttachments: 0 };
    const budget = { bootstrapBytes: blockBytes, ceiling: policy.maxReservationBytes, firstClaimPolicy: policy };
    const prepareAnother = async () => {
      const selected = f.stage.admit(device, f.manifest([bytes]));
      upload(f.stage, selected.operationId, 'file-0', bytes);
      f.stage.complete(device, selected.operationId);
      await until(() => f.stage.status(device, selected.operationId).phase === 'verified');
      f.stage.prepare(device, selected.operationId);
      await until(() => f.stage.status(device, selected.operationId).phase === 'prepared');
      const preview = await f.stage.publishPreparedPreview(device, selected.operationId);
      return { operationId: selected.operationId, intent: { ...intent, previewId: preview.previewId,
        confirmationChallenge: preview.confirmation.challenge } };
    };
    const expected = f.stage.inspectCopyIntent(device, grant.operationId, intent);
    const estimate = await f.stage.estimateFirstCopyClaim(device, grant.operationId, intent, policy);
    expect(estimate).toMatchObject({ ...expected, fileId: 'file-0' });
    expect(estimate.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(estimate.contentBytes).toBeGreaterThan(0);
    expect(estimate.estimatedPhysicalBytes).toBeGreaterThan(estimate.contentBytes);
    expect(estimate.estimatedPhysicalBytes % policy.blockBytes).toBe(0);
    const contender = new Database(path.join(store.dir, 'write-lock.sqlite'), { timeout: 0 });
    try {
      const observe = vi.fn((claim: { planDigest: string }, reserve: { allocationId: string; runId: string; reservedBytes: number }) => {
        expect(claim.planDigest).toBe(estimate.planDigest);
        const runs = db.prepare('SELECT runId, childPid, state FROM local_history_store_temporary_runs').all();
        expect(runs).toEqual([{ runId: reserve.runId, childPid: expect.any(Number), state: 'active' }]);
        expect(reserve.reservedBytes).toBe(budget.bootstrapBytes + estimate.estimatedPhysicalBytes);
        expect(ledger.inspect(reserve.allocationId)).toMatchObject({ state: 'active', planned: reserve.reservedBytes, written: 0 });
        expect((runs[0] as { childPid: number }).childPid).not.toBe(process.pid);
        expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow(/locked/);

        // Rehearse the first-permit transaction under actual writer custody.
        // The discard-only child cannot consume a permit, so roll back this
        // transaction before the observation returns.
        db.pragma('synchronous = FULL');
        initializeLocalHistoryFirstPermits(db);
        const operation = db.prepare('SELECT tag, fingerprint, deadline FROM upload_operations WHERE id = ?')
          .get(grant.operationId) as { tag: string; fingerprint: string; deadline: number };
        const index = db.prepare('SELECT allocation, sha256 FROM upload_previews WHERE id = ?')
          .get(grant.operationId) as { allocation: string; sha256: string };
        const destination = retry.preview.files[0].destinationFingerprint;
        if (!destination) throw new Error('fixture destination missing');
        const slot = {
          operationId: grant.operationId, previewId: retry.previewId, applyRequestId: expected.requestId,
          intentFingerprint: expected.fingerprint, generation: operation.tag.split('-')[1], runId: reserve.runId,
          reservationId: reserve.allocationId, previewAllocation: index.allocation, previewSha256: index.sha256,
          uploadFingerprint: operation.fingerprint, deadline: operation.deadline, permitId: '5'.repeat(32),
          fileIndex: 0, destinationBinding: destination, mutationKind: 'claim' as const,
          planDigest: claim.planDigest, plannedBytes: reserve.reservedBytes,
        };
        const rollback = new Error('fixture rolls back the unsent permit');
        const phase = db.prepare('SELECT phase FROM upload_operations WHERE id = ?');
        const permits = db.prepare('SELECT * FROM local_history_first_permits WHERE operationId = ?');
        expect(() => db.transaction(() => {
          expect(phase.get(grant.operationId)).toEqual({ phase: 'prepared' });
          expect(() => recordLocalHistoryFirstPermit(db, { ...slot, previewSha256: '0'.repeat(64) }))
            .toThrow('local-history-first-permit-conflict');
          expect(phase.get(grant.operationId)).toEqual({ phase: 'prepared' });
          expect(permits.get(grant.operationId)).toBeUndefined();
          expect(recordLocalHistoryFirstPermit(db, slot)).toBe('recorded');
          expect(phase.get(grant.operationId)).toEqual({ phase: 'applying' });
          expect(permits.get(grant.operationId)).toEqual(slot);
          throw rollback;
        }).immediate()).toThrow(rollback);
        expect(phase.get(grant.operationId)).toEqual({ phase: 'prepared' });
        expect(permits.get(grant.operationId)).toBeUndefined();
        return undefined;
      });
      await f.stage.observeFirstCopyClaim(device, grant.operationId, intent, budget, observe);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(db.prepare('SELECT state FROM local_history_store_temporary_runs').all()).toEqual([{ state: 'disposed' }]);
      contender.exec('BEGIN IMMEDIATE');
      contender.exec('ROLLBACK');
    } finally { contender.close(); }
    const registrationFailure = await prepareAnother();
    db.exec(`CREATE TRIGGER fixture_refuse_writer_binding BEFORE UPDATE OF state ON local_history_store_temporary_runs
      WHEN NEW.state = 'active' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END;`);
    const refusedObserver = vi.fn(() => undefined);
    await expect(f.stage.observeFirstCopyClaim(device, registrationFailure.operationId, registrationFailure.intent, budget, refusedObserver))
      .rejects.toThrow('upload-unavailable');
    expect(refusedObserver).not.toHaveBeenCalled();
    expect(db.prepare('SELECT state FROM local_history_store_temporary_runs').all()).toEqual([
      { state: 'disposed' }, { state: 'disposed' },
    ]);
    expect((await f.stage.readPreparedPreview(device, grant.operationId)).preview.newMessages).toBe(1);
    db.exec('DROP TRIGGER fixture_refuse_writer_binding');
    expect(fs.existsSync(path.join(store.dir, 'source-claims.sqlite'))).toBe(false);
    await expect(f.stage.estimateFirstCopyClaim(device, grant.operationId, intent, { ...policy, maxReservationBytes: 1 }))
      .rejects.toThrow('upload-capacity');
    const stale = await prepareAnother();
    const pressure = await prepareAnother();
    const pressureObserver = vi.fn(() => undefined);
    const beforePressure = ledger.inventory();
    f.pressure(64 * 1024);
    await expect(f.stage.observeFirstCopyClaim(device, pressure.operationId, pressure.intent, budget, pressureObserver))
      .rejects.toThrow('upload-unavailable');
    expect(pressureObserver).not.toHaveBeenCalled();
    expect(ledger.inventory()).toEqual(beforePressure);
    const priorCharge = beforePressure.filter(row => row.state !== 'disposed').reduce((sum, row) => sum + row.planned, 0);
    f.pressure(64 * 1024 + priorCharge + budget.bootstrapBytes);
    await expect(f.stage.observeFirstCopyClaim(device, pressure.operationId, pressure.intent, budget, pressureObserver))
      .rejects.toThrow('upload-unavailable');
    expect(pressureObserver).not.toHaveBeenCalled();
    expect(db.prepare('SELECT state FROM local_history_store_temporary_runs WHERE operationId = ?').all(pressure.operationId))
      .toEqual([{ state: 'disposed' }]);
    expect(ledger.inventory().filter(row => row.state !== 'disposed'))
      .toEqual(beforePressure.filter(row => row.state !== 'disposed'));
    f.pressure(128 * 1024 ** 2);
    await store.withWriter(async () => {
      store.assertOrClaimLocalSource({ ownerUserId: 'synthetic-owner', source: 'codex',
        originalId: 'synthetic-session-0', projectPath: '/synthetic/project', representation: 'canonical', parserContractVersion: 1 });
    });
    await expect(f.stage.preflightCopyIntent(device, grant.operationId, intent)).rejects.toThrow('upload-conflict');
    await expect(f.stage.estimateFirstCopyClaim(device, grant.operationId, intent, policy)).rejects.toThrow('upload-conflict');
    const staleObserver = vi.fn(() => undefined);
    await expect(f.stage.observeFirstCopyClaim(device, stale.operationId, stale.intent, budget, staleObserver))
      .rejects.toThrow('upload-unavailable');
    expect(staleObserver).not.toHaveBeenCalled();
    expect(await f.stage.publishPreparedPreview(device, grant.operationId)).toEqual(retry);
    expect(f.stage.status(device, grant.operationId).phase).toBe('prepared');
  } finally {
    vi.restoreAllMocks();
    db.close();
    ledger.close();
  }
});

it.each(['cancel', 'revoke', 'expire'] as const)('keeps preview unpublished after %s during an actual worker read', async action => {
  let now = Date.now();
  const f = setup({ clock: () => now });
  const bytes = Buffer.from([
    { type: 'session_meta', payload: { id: 'synthetic-session-0', cwd: '/synthetic/project', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic content' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const grant = f.stage.admit(device, f.manifest([bytes]));
  upload(f.stage, grant.operationId, 'file-0', bytes);
  f.stage.complete(device, grant.operationId);
  await until(() => f.stage.status(device, grant.operationId).phase === 'verified');
  f.stage.prepare(device, grant.operationId);
  await until(() => f.stage.status(device, grant.operationId).phase === 'prepared');
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try {
    const plan = db.prepare('SELECT allocation FROM upload_preparations WHERE id = ?').get(grant.operationId) as { allocation: string };
    const { files } = JSON.parse(ledger.read(plan.allocation, 0, 1024 * 1024).toString()) as { files: Array<{ allocation: string }> };
    const artifact = files[0].allocation;
    let pid = 0, acted = false, observedLive = false, observedSealed = false;
    const register = f.stage['registerChild'].bind(f.stage);
    vi.spyOn(f.stage as unknown as { registerChild(pid: number): Promise<void> }, 'registerChild')
      .mockImplementation(async childPid => { await register(childPid); pid = childPid; });
    const read = LocalHistoryDiskLedger.prototype.read;
    vi.spyOn(LocalHistoryDiskLedger.prototype, 'read').mockImplementation(function (this: LocalHistoryDiskLedger, id, offset, count) {
      const result = read.call(this, id, offset, count);
      if (id !== artifact || acted) return result;
      acted = true;
      observedLive = process.kill(pid, 0);
      if (action === 'cancel') f.stage.cancel(device, grant.operationId);
      else if (action === 'revoke') f.owner(null);
      else now = grant.expiresAt;
      observedSealed = ledger.inspect(artifact).state === 'sealed';
      return result;
    });
    await expect(f.stage.publishPreparedPreview(device, grant.operationId)).rejects.toThrow('upload-unavailable');
    expect({ acted, observedLive, observedSealed }).toEqual({ acted: true, observedLive: true, observedSealed: true });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM upload_previews').get()).toEqual({ n: 0 });
    expect(fs.existsSync(path.join(f.stateDir, 'imported-history'))).toBe(false);
  } finally {
    vi.restoreAllMocks();
    db.close();
    ledger.close();
  }
});

it.each(['cancel', 'revoke'] as const)('keeps parser-owned files charged until actual child exit after %s during streaming', async action => {
  const f = setup(), bytes = Buffer.from([
    { type: 'session_meta', payload: { id: 'synthetic-session-0', cwd: '/synthetic/project', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A'.repeat(2 * 1024 * 1024) }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const grant = f.stage.admit(device, f.manifest([bytes])); upload(f.stage, grant.operationId, 'file-0', bytes);
  f.stage.complete(device, grant.operationId); await until(() => f.stage.status(device, grant.operationId).phase === 'verified');
  let pid = 0, acted = false;
  const register = f.stage['registerChild'].bind(f.stage);
  const registration = vi.spyOn(f.stage as unknown as { registerChild(pid: number): Promise<void> }, 'registerChild').mockImplementation(async value => { await register(value); pid = value; });
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  const { tag } = db.prepare('SELECT tag FROM upload_operations WHERE id = ?').get(grant.operationId) as {tag: string};
  const readSync = fs.readSync;
  const reads = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    const count = readSync(fd, buffer, offset, length, position);
    if (!acted && pid > 0 && length === 1024 * 1024) {
      acted = true;
      setImmediate(() => {
        expect(() => process.kill(pid, 0)).not.toThrow();
        if (action === 'cancel') f.stage.cancel(device, grant.operationId); else f.owner(null);
        expect(ledger.list(tag).some(row => row.state === 'sealed' && row.written === bytes.length)).toBe(true);
      });
    }
    return count;
  }) as typeof fs.readSync);
  try {
    f.stage.prepare(device, grant.operationId);
    await until(() => acted && ledger.list(tag).every(row => row.state === 'disposed'));
    expect(() => process.kill(pid, 0)).toThrow();
    f.owner('synthetic-owner');
    expect(f.stage.status(device, grant.operationId).phase).toBe(action === 'cancel' ? 'cancelled' : 'interrupted');
    expect(fs.existsSync(path.join(f.stateDir, 'imported-history'))).toBe(false);
  } finally { reads.mockRestore(); registration.mockRestore(); db.close(); ledger.close(); }
});
it('rejects source-mode conflicts from the actual store without changing its durable claim', async () => {
  const f = setup(), store = new ImportedHistoryStore(f.stateDir);
  await store.withWriter(async () => { store.assertOrClaimLocalSource({ ownerUserId: 'synthetic-owner', source: 'codex', originalId: 'synthetic-session-0',
    projectPath: '/synthetic/project', representation: 'event-fallback', parserContractVersion: 1 }); });
  const bytes = Buffer.from([
    { type: 'session_meta', payload: { id: 'synthetic-session-0', cwd: '/synthetic/project', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic canonical message' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const grant = f.stage.admit(device, f.manifest([bytes])); upload(f.stage, grant.operationId, 'file-0', bytes);
  f.stage.complete(device, grant.operationId); await until(() => f.stage.status(device, grant.operationId).phase === 'verified');
  f.stage.prepare(device, grant.operationId); await until(() => f.stage.status(device, grant.operationId).phase === 'interrupted');
  expect(f.stage.status(device, grant.operationId).preparation).toBeUndefined();
  expect(store.readLocalSourceClaim({ ownerUserId: 'synthetic-owner', source: 'codex', originalId: 'synthetic-session-0' })?.representation).toBe('event-fallback');
  expect(fs.readdirSync(path.join(f.stateDir, 'imported-history', 'conversations'))).toEqual([]);
});
it('refuses normalized output growth before its first write under newly exhausted disk capacity', async () => {
  const f = setup(), bytes = Buffer.from([
    { type: 'session_meta', payload: { id: 'synthetic-session-0', cwd: '/synthetic/project', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic content' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const grant = f.stage.admit(device, f.manifest([bytes])); upload(f.stage, grant.operationId, 'file-0', bytes);
  f.stage.complete(device, grant.operationId); await until(() => f.stage.status(device, grant.operationId).phase === 'verified');
  const actualGrow = LocalHistoryDiskLedger.prototype.grow; let attemptedOutput = false;
  const growth = vi.spyOn(LocalHistoryDiskLedger.prototype, 'grow').mockImplementation(function (this: LocalHistoryDiskLedger, id: string, amount: number) {
    if (amount > 0) { attemptedOutput = true; f.pressure(0); }
    return actualGrow.call(this, id, amount);
  });
  const writes = vi.spyOn(LocalHistoryDiskLedger.prototype, 'write');
  try {
    f.stage.prepare(device, grant.operationId);
    await until(() => f.stage.status(device, grant.operationId).phase === 'interrupted');
    expect(attemptedOutput).toBe(true); expect(writes).not.toHaveBeenCalled();
    expect(f.stage.status(device, grant.operationId).preparation).toBeUndefined();
    expect(fs.existsSync(path.join(f.stateDir, 'imported-history'))).toBe(false);
  } finally { growth.mockRestore(); writes.mockRestore(); }
});
it('offers no prepared result when retiring raw bytes fails after normalization', async () => {
  const f = setup(), bytes = Buffer.from([
    { type: 'session_meta', payload: { id: 'synthetic-session-0', cwd: '/synthetic/project', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic content' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const grant = f.stage.admit(device, f.manifest([bytes])); upload(f.stage, grant.operationId, 'file-0', bytes);
  f.stage.complete(device, grant.operationId); await until(() => f.stage.status(device, grant.operationId).phase === 'verified');
  const unlink = vi.spyOn(SafeFsExecutor, 'safeUnlinkSync').mockImplementation(() => { throw new Error('synthetic raw retirement refusal'); });
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try {
    f.stage.prepare(device, grant.operationId);
    await until(() => f.stage.status(device, grant.operationId).phase === 'interrupted');
    expect(f.stage.status(device, grant.operationId).preparation).toBeUndefined();
    expect(ledger.inventory().some(row => row.state === 'cleanup-pending' && row.written > 0)).toBe(true);
  } finally { unlink.mockRestore(); ledger.close(); }
});
it('recovers the same live request after a lost grant reply without consuming another challenge', () => {
  const f = setup(), bytes = Buffer.from('synthetic'), manifest = f.manifest([bytes]);
  const first = f.stage.admit(device, manifest), fresh = f.stage.challenge(device).challenge;
  expect(f.stage.admit(device, { ...manifest, selectionChallenge: fresh }).operationId).toBe(first.operationId);
  expect(() => f.stage.admit(device, { ...manifest, project: '/changed' })).toThrow('upload-conflict');
  expect(() => f.stage.admit(device, { ...manifest, selectionRequestId: 'different-request' })).toThrow('upload-expired');
  expect(f.stage.admit(device, { ...manifest, selectionChallenge: fresh, selectionRequestId: 'fresh-request' }).phase).toBe('uploading');
});
it('leaves challenge unconsumed when disk admission fails before granting', () => {
  const f = setup(), manifest = f.manifest([Buffer.from('synthetic')]);
  f.pressure(0);
  expect(() => f.stage.admit(device, manifest)).toThrow('upload-capacity');
  f.pressure(128 * 1024 ** 2);
  expect(f.stage.admit(device, manifest).phase).toBe('uploading');
});
it('uses the exact challenge time boundary and refuses old boot manifests', () => {
  let now = 1_000_000;
  const f = setup({ clock: () => now }), challenge = f.stage.challenge(device), manifest = f.manifest([Buffer.from('synthetic')], challenge.challenge);
  now = challenge.expiresAt;
  expect(() => f.stage.admit(device, manifest)).toThrow('upload-expired');
  const next = f.manifest([Buffer.from('synthetic')]);
  expect(() => f.stage.admit(device, { ...next, bootId: 'old-boot' })).toThrow('upload-invalid');
});
it('expires a selection challenge against monotonic time while the wall clock is frozen', () => {
  let ticks = 1000;
  const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => ticks);
  try {
    const f = setup({ clock: () => 1_000_000 }), manifest = f.manifest([Buffer.from('synthetic')]);
    ticks += 60_000;
    expect(() => f.stage.admit(device, manifest)).toThrow('upload-expired');
    expect(f.stage.admit(device, f.manifest([Buffer.from('fresh')])).phase).toBe('uploading');
  } finally { monotonic.mockRestore(); }
});
it('acknowledges an exact duplicate chunk without appending and invalidates a conflicting retry', () => {
  const f = setup(), bytes = Buffer.from('synthetic'), grant = f.stage.admit(device, f.manifest([bytes]));
  const first = f.stage.write(device, grant.operationId, 'file-0', 0, bytes);
  expect(f.stage.write(device, grant.operationId, 'file-0', 0, bytes)).toEqual(first);
  expect(() => f.stage.write(device, grant.operationId, 'file-0', 0, Buffer.from('different'))).toThrow('upload-conflict');
  expect(f.stage.status(device, grant.operationId).phase).toBe('conflicted');
});
it('refuses out-of-order chunks before writing and retains the terminal request barrier', () => {
  const f = setup(), bytes = Buffer.alloc(LOCAL_HISTORY_PLAINTEXT_BYTES + 1, 65), manifest = f.manifest([bytes]);
  const grant = f.stage.admit(device, manifest);
  expect(() => f.stage.write(device, grant.operationId, 'file-0', 1, Buffer.from('A'))).toThrow('upload-conflict');
  expect(f.stage.status(device, grant.operationId).phase).toBe('conflicted');
  expect(() => f.stage.admit(device, manifest)).toThrow('upload-conflict');
});
it('keeps writer-busy complete retryable and reuses one verification after a lost acknowledgement', async () => {
  const f = setup(), bytes = Buffer.alloc(2 * LOCAL_HISTORY_PLAINTEXT_BYTES + 1, 65);
  const first = f.stage.admit(device, f.manifest([bytes])); upload(f.stage, first.operationId, 'file-0', bytes);
  const second = f.stage.admit(device, f.manifest([Buffer.from('other')])); upload(f.stage, second.operationId, 'file-0', Buffer.from('other'));
  f.stage.complete(device, first.operationId);
  expect(() => f.stage.complete(device, second.operationId)).toThrow('upload-busy');
  expect(f.stage.status(device, second.operationId).phase).toBe('uploading');
  await until(() => f.stage.status(device, first.operationId).phase === 'verified');
  expect(f.stage.complete(device, first.operationId).phase).toBe('verified');
  f.stage.complete(device, second.operationId);
  await until(() => f.stage.status(device, second.operationId).phase === 'verified');
});
it('refuses another current profile and key without revealing operation existence', () => {
  const f = setup(), grant = f.stage.admit(device, f.manifest([Buffer.from('synthetic')]));
  f.owner('other-owner');
  expect(() => f.stage.status(device, grant.operationId)).toThrow('upload-not-found');
  expect(() => f.stage.status(device, '0'.repeat(32))).toThrow('upload-not-found');
  f.owner('synthetic-owner'); f.key('rotated-key');
  expect(() => f.stage.status(device, grant.operationId)).toThrow('upload-unavailable');
  expect(() => f.stage.status({ ...device, deviceKeyHash: 'rotated-key' }, grant.operationId)).toThrow('upload-not-found');
});
it.each(['bootId', 'machineId', 'origin', 'signingKeyHash'] as const)('refuses a changed issuing %s before byte persistence', field => {
  const f = setup(), bytes = Buffer.from('synthetic'), grant = f.stage.admit(device, f.manifest([bytes]));
  f.issuer({ [field]: field === 'origin' ? 'https://other.example' : field === 'signingKeyHash' ? 'b'.repeat(64) : 'changed' });
  expect(() => f.stage.write(device, grant.operationId, 'file-0', 0, bytes)).toThrow('upload-unavailable');
  f.issuer(issuer);
  expect(f.stage.status(device, grant.operationId).files[0].plaintextOffset).toBe(0);
});
it('invalidates authority before failed disposal and preserves charged cleanup residue', () => {
  const f = setup(), bytes = Buffer.from('synthetic'), grant = f.stage.admit(device, f.manifest([bytes])); upload(f.stage, grant.operationId, 'file-0', bytes);
  const unlink = vi.spyOn(SafeFsExecutor, 'safeUnlinkSync').mockImplementation(() => { throw new Error('synthetic refusal'); });
  expect(f.stage.cancel(device, grant.operationId).phase).toBe('cancelled');
  expect(() => f.stage.write(device, grant.operationId, 'file-0', 0, bytes)).toThrow('upload-conflict');
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try { expect(ledger.inventory().some(row => row.state === 'cleanup-pending' && row.planned > 0)).toBe(true); }
  finally { ledger.close(); unlink.mockRestore(); }
});
it('rejects damaged manifest metadata before any upload or status disclosure', () => {
  const f = setup(), grant = f.stage.admit(device, f.manifest([Buffer.from('synthetic')]));
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  const row = db.prepare('SELECT plan FROM upload_operations WHERE id = ?').get(grant.operationId) as {plan: string}; db.close();
  const file = path.join(f.stateDir, 'local-history-upload', 'blocks', row.plan);
  const bytes = fs.readFileSync(file); bytes[10] ^= 1; fs.writeFileSync(file, bytes);
  expect(() => f.stage.status(device, grant.operationId)).toThrow('upload-unavailable');
});
it('keeps multiple supported files beyond fifty megabytes as one selection', () => {
  const f = setup(), declared = Buffer.alloc(21 * 1024 ** 2);
  const grant = f.stage.admit(device, f.manifest([declared, declared, declared]));
  expect(grant.files).toHaveLength(3);
});
it('keeps a registered namespace charged across staging restart until verified old-run cleanup', async () => {
  const f = setup();
  const selected = f.stage.admit(device, f.manifest([Buffer.from('synthetic selected bytes')]));
  const unrelated = f.stage.admit(device, f.manifest([Buffer.from('unrelated synthetic upload')]));
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try {
    const lookup = db.prepare('SELECT tag FROM upload_operations WHERE id = ?');
    const { tag } = lookup.get(selected.operationId) as { tag: string };
    const unrelatedTag = (lookup.get(unrelated.operationId) as { tag: string }).tag;
    // The registry needs a prepared operation. No child is started in this
    // fixture, so its real exclusive next generation can settle the namespace.
    db.prepare("UPDATE upload_operations SET phase = 'prepared' WHERE id = ?").run(selected.operationId);
    const run = registerLocalHistoryStoreTemporaryRun(db, f.stage['custody'], selected);
    const namespace = path.join(f.stateDir, 'imported-history', '.local-history-temporary', run.runId);
    const reservation = ledger.create(tag, 123);
    await f.stage.stop();
    expect(ledger.inspect(reservation)).toMatchObject({ planned: 123, state: 'active' });
    expect(ledger.list(unrelatedTag).every(row => row.state === 'disposed')).toBe(true);
    const resumed = setup({ stateDir: f.stateDir, boot: 'synthetic-next-boot' });
    expect(ledger.inspect(reservation)).toMatchObject({ planned: 0, state: 'disposed' });
    expect(fs.existsSync(namespace)).toBe(false);

    const charge = ledger.create(tag, 123);
    fs.mkdirSync(namespace, { mode: 0o700 });
    expect(resumed.stage['disposeTag'](tag)).toBe(false);
    expect(ledger.inspect(charge).planned).toBe(123);
    SafeFsExecutor.safeRmdirSync(namespace, { operation: 'test recreated empty namespace' });
    expect(resumed.stage['disposeTag'](tag)).toBe(true);
    expect(ledger.inspect(charge)).toMatchObject({ planned: 0, state: 'disposed' });
  } finally { db.close(); ledger.close(); }
});

it('retains a prior tag when one of its registered namespaces cannot settle', async () => {
  const f = setup();
  const selected = f.stage.admit(device, f.manifest([Buffer.from('synthetic selected bytes')]));
  const other = f.stage.admit(device, f.manifest([Buffer.from('separately settled synthetic upload')]));
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try {
    const { tag } = db.prepare('SELECT tag FROM upload_operations WHERE id = ?').get(selected.operationId) as { tag: string };
    db.prepare("UPDATE upload_operations SET phase = 'prepared' WHERE id = ?").run(selected.operationId);
    db.prepare("UPDATE upload_operations SET phase = 'prepared' WHERE id = ?").run(other.operationId);
    const otherRun = registerLocalHistoryStoreTemporaryRun(db, f.stage['custody'], other);
    const otherTag = (db.prepare('SELECT tag FROM upload_operations WHERE id = ?').get(other.operationId) as { tag: string }).tag;
    const otherReservation = ledger.create(otherTag, 456);
    const cleanRun = registerLocalHistoryStoreTemporaryRun(db, f.stage['custody'], selected);
    const pendingRun = registerLocalHistoryStoreTemporaryRun(db, f.stage['custody'], selected);
    const namespace = (id: string) => path.join(f.stateDir, 'imported-history', '.local-history-temporary', id);
    fs.mkdirSync(path.join(namespace(pendingRun.runId), 'unknown-directory'), { mode: 0o700 });
    const reservation = ledger.create(tag, 123);
    await f.stage.stop();
    setup({ stateDir: f.stateDir, boot: 'synthetic-next-boot' });
    expect(fs.existsSync(namespace(cleanRun.runId))).toBe(false);
    expect(fs.existsSync(path.join(namespace(pendingRun.runId), 'unknown-directory'))).toBe(true);
    expect(ledger.inspect(reservation)).toMatchObject({ planned: 123, state: 'active' });
    expect(fs.existsSync(namespace(otherRun.runId))).toBe(false);
    expect(ledger.inspect(otherReservation)).toMatchObject({ planned: 0, state: 'disposed' });
  } finally { db.close(); ledger.close(); }
});

it('refuses old-tag recovery when the temporary registry lacks its primary key', async () => {
  const f = setup();
  const tag = 'r-' + f.stage['custody'].custody.generation + '-' + 'c'.repeat(32);
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try {
    const allocation = ledger.create(tag, 123);
    await f.stage.stop();
    const table = 'local_history_store_temporary_runs';
    const { sql } = db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(table) as { sql: string };
    {
      const malformed = sql.replace('runId TEXT PRIMARY KEY NOT NULL', 'runId TEXT NOT NULL');
      expect(malformed).not.toBe(sql);
      db.exec(`ALTER TABLE ${table} RENAME TO retained_registry_fixture`);
      db.exec(malformed);
    }
    expect(() => setup({ stateDir: f.stateDir, boot: 'synthetic-next-boot' })).toThrow('upload-unavailable');
    expect(ledger.inspect(allocation)).toMatchObject({ planned: 123, state: 'active' });
  } finally { db.close(); ledger.close(); }
});

it.each(['cancel', 'shutdown', 'registration-failure', 'missing-store', 'pin-change', 'policy-mismatch', 'receipt-mismatch'] as const)('holds registered copy custody through close after %s', async action => {
  const f = setup();
  const bytes = Buffer.from([
    { type: 'session_meta', payload: { id: 'synthetic-session-0', cwd: '/synthetic/project', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic content' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const selected = f.stage.admit(device, f.manifest([bytes]));
  upload(f.stage, selected.operationId, 'file-0', bytes);
  f.stage.complete(device, selected.operationId);
  await until(() => f.stage.status(device, selected.operationId).phase === 'verified');
  f.stage.prepare(device, selected.operationId);
  await until(() => f.stage.status(device, selected.operationId).phase === 'prepared');
  if (action !== 'missing-store') {
    const store = new ImportedHistoryStore(f.stateDir);
    fs.mkdirSync(path.join(store.dir, '.local-history-temporary'), { mode: 0o700 });
  }
  const receipt = await f.stage.publishPreparedPreview(device, selected.operationId);
  const intent = { previewId: receipt.previewId, machineId: receipt.machineId, bootId: issuer.bootId,
    confirmationChallenge: receipt.confirmation.challenge, applyRequestId: '1'.repeat(32) };
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    await once(child.stdout!, 'data');
    const { tag } = db.prepare('SELECT tag FROM upload_operations WHERE id = ?').get(selected.operationId) as { tag: string };
    const originalKill = child.kill.bind(child);
    let errorInjected = false;
    const signals = vi.spyOn(child, 'kill');
    if (action === 'registration-failure') {
      signals.mockImplementation(signal => {
        if (signal === 'SIGTERM' && !errorInjected) {
          errorInjected = true;
          child.emit('error', new Error('synthetic synchronous signal error'));
        }
        return originalKill(signal);
      });
      db.exec(`CREATE TRIGGER fixture_refuse_binding BEFORE UPDATE OF state ON local_history_store_temporary_runs
        WHEN NEW.state = 'active' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END;`);
    }
    const before = ledger.list(tag);
    const originalEstimate = f.stage.estimateFirstCopyClaim.bind(f.stage);
    const estimate = vi.spyOn(f.stage, 'estimateFirstCopyClaim');
    if (action === 'receipt-mismatch') estimate.mockImplementation(async (...args) => ({
      ...await originalEstimate(...args), previewDigest: 'f'.repeat(64),
    }));
    const blockBytes = fs.statfsSync(f.stateDir).bsize;
    let settled = false;
    const work = Promise.allSettled([f.stage.holdPreparedCopyChild(device, selected.operationId, intent, child, {
      bootstrapBytes: 513, ceiling: 1024 * 1024,
      firstClaimPolicy: { blockBytes: action === 'policy-mismatch' ? blockBytes * 2 : blockBytes,
        perWriteMetadataBytes: blockBytes, maxReservationBytes: 1024 * 1024, maxAttachments: 0 },
    })]).then(results => { settled = true; return results; });
    if (action === 'missing-store' || action === 'policy-mismatch' || action === 'receipt-mismatch') {
      await until(() => settled);
      const [result] = await work;
      expect(result.status).toBe('rejected');
      expect(ledger.list(tag)).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS n FROM local_history_store_temporary_runs').get()).toEqual({ n: 0 });
      if (action === 'missing-store') expect(fs.existsSync(path.join(f.stateDir, 'imported-history'))).toBe(false);
      return;
    }
    const state = db.prepare('SELECT state FROM local_history_store_temporary_runs');
    await until(() => (state.get() as { state: string } | undefined)?.state === (action === 'registration-failure' ? 'registered' : 'active'));
    await expect(f.stage.readPreparedPreview(device, selected.operationId)).rejects.toThrow('upload-busy');
    if (action === 'cancel') f.stage.cancel(device, selected.operationId);
    const stopping = action === 'shutdown' ? f.stage.stop() : undefined;
    expect(f.stage['disposeTag'](tag)).toBe(false);
    expect(ledger.list(tag).some(row => row.state === 'sealed')).toBe(true);
    const checked = await estimate.mock.results[0].value;
    const planned = 513 + checked.estimatedPhysicalBytes;
    const reservation = ledger.list(tag).find(row => row.planned === planned && row.written === 0)!;
    expect(reservation.state).toBe('active');
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    if (action === 'pin-change') {
      const store = path.join(f.stateDir, 'imported-history');
      fs.renameSync(path.join(store, 'attachments'), path.join(store, 'replaced-attachments'));
      fs.mkdirSync(path.join(store, 'attachments'), { mode: 0o700 });
    }
    if (action !== 'registration-failure') child.kill('SIGKILL');
    await closed;
    if (action === 'registration-failure') {
      expect(child.signalCode).toBe('SIGKILL');
      expect(errorInjected).toBe(true);
      expect(signals.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    }
    const [result] = await work;
    await stopping;
    expect(result.status).toBe(['registration-failure', 'pin-change'].includes(action) ? 'rejected' : 'fulfilled');
    expect(state.get()).toEqual({ state: 'disposed' });
    expect(ledger.inspect(reservation.id)).toMatchObject(action === 'pin-change'
      ? { planned, state: 'active' } : { planned: 0, state: 'disposed' });
    if (action === 'pin-change') expect(f.stage['disposeTag'](tag)).toBe(false);
    expect(ledger.list(tag).every(row => row.state === 'disposed')).toBe(action === 'cancel' || action === 'shutdown');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    db.close(); ledger.close();
  }
});

it('quarantines a committed first permit across repeated restarts without releasing its reservation', async () => {
  const f = setup();
  const bytes = Buffer.from([
    { type: 'session_meta', payload: { id: 'synthetic-session-0', cwd: '/synthetic/project', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic content' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const selected = f.stage.admit(device, f.manifest([bytes]));
  upload(f.stage, selected.operationId, 'file-0', bytes);
  f.stage.complete(device, selected.operationId);
  await until(() => f.stage.status(device, selected.operationId).phase === 'verified');
  f.stage.prepare(device, selected.operationId);
  await until(() => f.stage.status(device, selected.operationId).phase === 'prepared');
  const receipt = await f.stage.publishPreparedPreview(device, selected.operationId);
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  db.pragma('synchronous = FULL');
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const childClosed = once(child, 'close');
  try {
    const run = registerLocalHistoryStoreTemporaryRun(db, f.stage['custody'], selected);
    await once(child, 'spawn');
    const token = await run.registerChild(child);
    const { tag, fingerprint } = db.prepare('SELECT tag, fingerprint FROM upload_operations WHERE id = ?').get(selected.operationId) as { tag: string; fingerprint: string };
    const index = db.prepare('SELECT allocation, sha256 FROM upload_previews WHERE id = ?').get(selected.operationId) as { allocation: string; sha256: string };
    const reservationId = ledger.create(tag, 123);
    const unrelatedTag = 'r-' + token.generation + '-' + '0'.repeat(32);
    const unrelated = ledger.create(unrelatedTag, 456);
    const intent = f.stage.inspectCopyIntent(device, selected.operationId, {
      previewId: receipt.previewId, machineId: receipt.machineId, bootId: issuer.bootId,
      confirmationChallenge: receipt.confirmation.challenge, applyRequestId: '1'.repeat(32),
    });
    initializeLocalHistoryFirstPermits(db);
    db.transaction(() => {
      expect(recordLocalHistoryFirstPermit(db, {
        operationId: selected.operationId, previewId: receipt.previewId, applyRequestId: intent.requestId,
        intentFingerprint: intent.fingerprint, generation: token.generation, runId: run.runId, reservationId,
        previewAllocation: index.allocation, previewSha256: index.sha256, uploadFingerprint: fingerprint,
        deadline: receipt.expiresAt, permitId: '2'.repeat(32), fileIndex: 0,
        destinationBinding: '3'.repeat(64), mutationKind: 'claim', planDigest: '4'.repeat(64), plannedBytes: 123,
      })).toBe('recorded');
    }).immediate();
    // No IPC permit is sent. Disk state cannot distinguish this from a
    // delivered permit whose acknowledgement was lost.
    child.kill();
    await childClosed;
    await f.stage.stop();
    const firstRestart = setup({ stateDir: f.stateDir, boot: 'synthetic-next-boot' });
    expect(firstRestart.stage.status(device, selected.operationId)).toMatchObject({ phase: 'interrupted', files: [] });
    expect(ledger.inspect(unrelated)).toMatchObject({ planned: 0, state: 'disposed' });
    expect(ledger.inspect(reservationId)).toMatchObject({ planned: 123, state: 'active' });
    expect(fs.existsSync(path.join(f.stateDir, 'imported-history', '.local-history-temporary', run.runId))).toBe(false);
    await firstRestart.stage.stop();

    const next = setup({ stateDir: f.stateDir, boot: 'synthetic-third-boot' });
    expect(next.stage.cancel(device, selected.operationId).phase).toBe('interrupted');
    expect(next.stage['disposeTag'](tag)).toBe(false);
    expect(ledger.inspect(reservationId)).toMatchObject({ planned: 123, state: 'active' });
    expect(db.prepare('SELECT permitId FROM local_history_first_permits').all()).toEqual([{ permitId: '2'.repeat(32) }]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childClosed;
    db.close();
    ledger.close();
  }
});

it('refuses startup disposal when an applying operation has no durable permit slot', async () => {
  const f = setup();
  const selected = f.stage.admit(device, f.manifest([Buffer.from('synthetic selected bytes')]));
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try {
    db.prepare("UPDATE upload_operations SET phase = 'applying' WHERE id = ?").run(selected.operationId);
    const { tag } = db.prepare('SELECT tag FROM upload_operations WHERE id = ?').get(selected.operationId) as { tag: string };
    const reservation = ledger.create(tag, 123);
    await f.stage.stop();
    expect(() => setup({ stateDir: f.stateDir, boot: 'synthetic-next-boot' })).toThrow('upload-unavailable');
    expect(ledger.inspect(reservation)).toMatchObject({ planned: 123, state: 'active' });
  } finally { db.close(); ledger.close(); }
});

it('keeps an overlapping server out and recovers old status without renewing upload authority', async () => {
  const f = setup(), manifest = f.manifest([Buffer.from('synthetic')]), grant = f.stage.admit(device, manifest);
  expect(() => setup({ stateDir: f.stateDir, boot: 'new-boot' })).toThrow('upload-busy');
  await f.stage.stop();
  const next = setup({ stateDir: f.stateDir, boot: 'new-boot' });
  expect(next.stage.status(device, grant.operationId).phase).toBe('interrupted');
  expect(() => next.stage.admit(device, manifest)).toThrow('upload-invalid');
});
it('cleans up expired uploads without another request', async () => {
  const f = setup({ ttl: 500 }), grant = f.stage.admit(device, f.manifest([Buffer.from('synthetic')]));
  await new Promise(resolve => setTimeout(resolve, 650));
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  try { expect((db.prepare('SELECT phase FROM upload_operations WHERE id = ?').get(grant.operationId) as {phase: string}).phase).toBe('expired'); }
  finally { db.close(); }
  expect(f.stage.status(device, grant.operationId).phase).toBe('expired');
});
it('does not disclose a damaged foreign row before checking its owner binding', () => {
  const f = setup(), grant = f.stage.admit(device, f.manifest([Buffer.from('synthetic')]));
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  db.prepare('UPDATE upload_operations SET fingerprint = ? WHERE id = ?').run('damaged', grant.operationId); db.close();
  f.owner('different-owner');
  expect(() => f.stage.status(device, grant.operationId)).toThrow('upload-not-found');
  expect(() => f.stage.status(device, '0'.repeat(32))).toThrow('upload-not-found');
});
it('rolls back all known-tag allocations when a later file reservation refuses', () => {
  const f = setup(), bytes = Buffer.alloc(80, 65), manifest = f.manifest([bytes, bytes]);
  f.pressure(3 * 64 * 1024 + 100);
  expect(() => f.stage.admit(device, manifest)).toThrow('upload-capacity');
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try { expect(ledger.inventory().filter(row => row.state === 'active')).toHaveLength(1); }
  finally { ledger.close(); }
  f.pressure(128 * 1024 ** 2);
  expect(f.stage.admit(device, manifest).phase).toBe('uploading');
});
it('finds an interrupted creation by tag even when its allocation id was never returned', () => {
  const f = setup(), manifest = f.manifest([Buffer.from('synthetic')]);
  const original = fs.openSync; let failed = false;
  const open = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: number, mode: number) => {
    if (!failed && typeof file === 'string' && path.dirname(file).endsWith('/blocks')) { failed = true; throw new Error('synthetic ENOSPC'); }
    return original(file, flags, mode);
  }) as typeof fs.openSync);
  expect(() => f.stage.admit(device, manifest)).toThrow('upload-unavailable');
  open.mockRestore();
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try { expect(ledger.inventory().filter(row => row.state !== 'disposed')).toHaveLength(1); }
  finally { ledger.close(); }
  expect(f.stage.admit(device, manifest).phase).toBe('uploading');
});
it('leaves incomplete completion retryable and rejects an incorrect declared digest', async () => {
  const f = setup(), bytes = Buffer.from('synthetic'), manifest = f.manifest([bytes]);
  manifest.files[0].sha256 = '0'.repeat(64);
  const grant = f.stage.admit(device, manifest);
  expect(() => f.stage.complete(device, grant.operationId)).toThrow('upload-invalid');
  expect(f.stage.status(device, grant.operationId).phase).toBe('uploading');
  upload(f.stage, grant.operationId, 'file-0', bytes);
  f.stage.complete(device, grant.operationId);
  await until(() => f.stage.status(device, grant.operationId).phase === 'conflicted');
});
it('hashes every byte even when the kernel returns positive short reads', async () => {
  const f = setup(), bytes = Buffer.alloc(1024 * 1024 + 13, 65), manifest = f.manifest([bytes]);
  // This digest describes exactly what the old one-read-per-offset bug sampled,
  // not the complete declared file. It must never become a verified upload.
  manifest.files[0].sha256 = crypto.createHash('sha256').update(Buffer.concat([bytes.subarray(0, 65536), bytes.subarray(1024 * 1024)])).digest('hex');
  const grant = f.stage.admit(device, manifest); upload(f.stage, grant.operationId, 'file-0', bytes);
  const original = fs.readSync;
  const read = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    original(fd, buffer, offset, Math.min(length, 65536), position)) as typeof fs.readSync);
  try {
    f.stage.complete(device, grant.operationId);
    await until(() => f.stage.status(device, grant.operationId).phase === 'conflicted');
  } finally { read.mockRestore(); }
});
it.each(['cancel', 'revoke'] as const)('stops verification between chunks after %s before publishing verified status', async action => {
  const f = setup(), bytes = Buffer.alloc(2 * 1024 * 1024, 65), grant = f.stage.admit(device, f.manifest([bytes]));
  upload(f.stage, grant.operationId, 'file-0', bytes);
  const original = fs.readSync; let rawReads = 0;
  const read = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    const count = original(fd, buffer, offset, length, position);
    if (length >= 128 * 1024 && ++rawReads === 1) setImmediate(() => {
      if (action === 'cancel') f.stage.cancel(device, grant.operationId);
      else f.owner(null);
    });
    return count;
  }) as typeof fs.readSync);
  try {
    f.stage.complete(device, grant.operationId);
    const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
    try {
      await until(() => (db.prepare('SELECT phase FROM upload_operations WHERE id = ?').get(grant.operationId) as {phase: string}).phase === (action === 'cancel' ? 'cancelled' : 'interrupted'));
    } finally { db.close(); }
    expect(rawReads).toBe(1);
  } finally { read.mockRestore(); }
});
it('finishes a valid incomplete upload after a retry supplies the remaining bytes', async () => {
  const f = setup(), bytes = Buffer.from('synthetic'), grant = f.stage.admit(device, f.manifest([bytes]));
  expect(() => f.stage.complete(device, grant.operationId)).toThrow('upload-invalid');
  expect(f.stage.status(device, grant.operationId).phase).toBe('uploading');
  upload(f.stage, grant.operationId, 'file-0', bytes); f.stage.complete(device, grant.operationId);
  await until(() => f.stage.status(device, grant.operationId).phase === 'verified');
});
it('does not extend absolute expiry when the injected wall clock stops advancing', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let ticks = 0;
  const monotonic = vi.spyOn(monotonicClock, 'now').mockImplementation(() => ticks);
  const f = setup({ ttl: 100, clock: () => 1_000_000 }), grant = f.stage.admit(device, f.manifest([Buffer.from('synthetic')]));
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  try {
    ticks = 100; await vi.advanceTimersByTimeAsync(100);
    expect((db.prepare('SELECT phase FROM upload_operations WHERE id = ?').get(grant.operationId) as {phase: string}).phase).toBe('expired');
  } finally { await f.stage.stop(); db.close(); monotonic.mockRestore(); vi.useRealTimers(); }
});
it('retains failed-admission residue and retries the known tag without an operation row', async () => {
  const f = setup(), bytes = Buffer.alloc(80, 65), manifest = f.manifest([bytes, bytes]);
  f.pressure(3 * 64 * 1024 + 100);
  const unlink = vi.spyOn(SafeFsExecutor, 'safeUnlinkSync').mockImplementation(() => { throw new Error('synthetic refusal'); });
  expect(() => f.stage.admit(device, manifest)).toThrow('upload-capacity');
  unlink.mockRestore();
  const ledger = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk });
  try {
    expect(ledger.inventory().some(row => row.state === 'cleanup-pending')).toBe(true);
    await until(() => ledger.inventory().filter(row => row.state !== 'disposed').length === 1);
  } finally { ledger.close(); }
});
it('keeps timer inventory failures finite and releases custody after a failed cleanup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let ticks = 0;
  const monotonic = vi.spyOn(monotonicClock, 'now').mockImplementation(() => ticks);
  const f = setup({ ttl: 100, clock: () => 1_000_000 }), grant = f.stage.admit(device, f.manifest([Buffer.from('synthetic')]));
  const list = vi.spyOn(LocalHistoryDiskLedger.prototype, 'list').mockImplementation(() => { throw new Error('synthetic busy inventory'); });
  const db = new Database(path.join(f.stateDir, 'local-history-upload', 'jobs.sqlite'));
  try {
    ticks = 100; await vi.advanceTimersByTimeAsync(100);
    expect((db.prepare('SELECT phase FROM upload_operations WHERE id = ?').get(grant.operationId) as {phase: string}).phase).toBe('expired');
    const first = f.stage.stop(), second = f.stage.stop(); expect(first).toBe(second); await first;
  } finally { list.mockRestore(); await f.stage.stop(); db.close(); monotonic.mockRestore(); vi.useRealTimers(); }
  const next = setup({ stateDir: f.stateDir, boot: 'after-failed-cleanup' });
  expect(next.stage.status(device, grant.operationId).phase).toBe('expired');
});
it('does not reclaim a dead parent upload until its actual surviving child custody exits', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-upload-orphan-')); roots.push(stateDir);
  const control = fs.mkdtempSync('/tmp/ilh-'); roots.push(control);
  const socketPath = path.join(control, 'h.sock'); sockets.push(socketPath);
  const parent = fork(fileURLToPath(new URL('../fixtures/local-history/staging-parent.mjs', import.meta.url)), [stateDir, socketPath], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  parents.push(parent);
  const [ready] = await Promise.race([once(parent, 'message'), once(parent, 'exit').then(() => { throw new Error('synthetic parent exited early'); })]);
  expect(ready.ready).toBe(true);
  const blocks = path.join(stateDir, 'local-history-upload', 'blocks');
  const before = fs.readdirSync(blocks).sort(); expect(before.length).toBeGreaterThan(1);
  const exit = once(parent, 'exit'); parent.kill('SIGKILL'); await exit;
  expect(() => setup({ stateDir, boot: 'after-crash' })).toThrow('upload-busy');
  expect(fs.readdirSync(blocks).sort()).toEqual(before);
  await release(socketPath);
  let recovered: ReturnType<typeof setup> | undefined;
  await until(() => {
    try { recovered = setup({ stateDir, boot: 'after-crash' }); return true; }
    catch (error) { if ((error as Error).message === 'local-history-upload-busy') return false; throw error; }
  });
  expect(recovered!.stage.status(device, ready.operationId).phase).toBe('interrupted');
  expect(fs.readdirSync(blocks)).toHaveLength(1); // only the new metadata work reserve
});


it('commits and delivers only the synthetic first claim through real staging', async () => {
  const base = path.join(fs.realpathSync(os.homedir()), '.instar', 'test-deploys');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const home = path.join(base, 'local-history-reserve-pilot-' + crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(home, { mode: 0o700 }); roots.push(home);
  const stateDir = path.join(home, '.instar');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const f = setup({ stateDir });
  const bytes = Buffer.from(LOCAL_HISTORY_DISPOSABLE_PILOT_LINES.join('\n'));
  const store = new ImportedHistoryStore(stateDir);
  fs.mkdirSync(path.join(store.dir, '.local-history-temporary'), { mode: 0o700 });
  const manifest = f.manifest([bytes]);
  manifest.files[0].expectedSessionId = 'synthetic-session';
  const selected = f.stage.admit(device, manifest);
  upload(f.stage, selected.operationId, 'file-0', bytes);
  f.stage.complete(device, selected.operationId);
  await until(() => f.stage.status(device, selected.operationId).phase === 'verified');
  f.stage.prepare(device, selected.operationId);
  await until(() => f.stage.status(device, selected.operationId).phase === 'prepared');
  const receipt = await f.stage.publishPreparedPreview(device, selected.operationId);
  const intent = { previewId: receipt.previewId, machineId: receipt.machineId, bootId: issuer.bootId,
    confirmationChallenge: receipt.confirmation.challenge, applyRequestId: '1'.repeat(32) };
  const blockBytes = fs.statfsSync(stateDir).bsize;
  const budget = { bootstrapBytes: 64 * 1024 ** 2, ceiling: 256 * 1024 ** 2,
    firstClaimPolicy: { blockBytes, perWriteMetadataBytes: 1024 ** 2, maxReservationBytes: 256 * 1024 ** 2, maxAttachments: 32 } };
  const db = new Database(path.join(stateDir, 'local-history-upload', 'jobs.sqlite'));
  const ledger = new LocalHistoryDiskLedger(stateDir, { disk: f.disk });
  try {
    await expect(f.stage.applyDisposableFirstClaim(device, selected.operationId, intent, budget)).resolves.toEqual({ claimWritten: true });
    expect(f.stage.status(device, selected.operationId).phase).toBe('interrupted');
    const slot = db.prepare('SELECT * FROM local_history_first_permits WHERE operationId = ?').get(selected.operationId) as
      { reservationId: string; runId: string; plannedBytes: number; mutationKind: string };
    expect(slot.mutationKind).toBe('claim');
    expect(ledger.inspect(slot.reservationId)).toMatchObject({ state: 'active', written: 0, planned: slot.plannedBytes });
    expect(db.prepare('SELECT state FROM local_history_store_temporary_runs WHERE runId = ?').get(slot.runId)).toEqual({ state: 'disposed' });
    expect(db.prepare('SELECT acknowledgementDigest FROM local_history_first_permit_progress WHERE operationId = ?').get(selected.operationId))
      .toEqual({ acknowledgementDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(fs.statSync(path.join(store.dir, 'source-claims.sqlite')).size).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(store.dir, 'conversations'))).toEqual([]);
    await expect(f.stage.applyDisposableFirstClaim(device, selected.operationId, intent, budget)).rejects.toThrow('upload-conflict');
    await f.stage.stop();
    const reopened = setup({ stateDir, boot: 'synthetic-pilot-next-boot' });
    expect(reopened.stage.status(device, selected.operationId).phase).toBe('interrupted');
    expect(ledger.inspect(slot.reservationId)).toMatchObject({ state: 'active', written: 0, planned: slot.plannedBytes });
  } finally { db.close(); ledger.close(); }
});
