/**
 * AppMediaStore (docs/specs/mobile-native-chat-media.md §4.2, §4.3, §4.5, §4.7, §4.8): chunks,
 * assembly off the event loop, claims and crash recovery, admission, purge, orphans, integrity.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationStore, type MediaMessageEvent } from '../../src/core/AppConversationStore.js';
import { AppMediaStore, CLAIM_RECOVERY_AGE_MS, UPLOAD_TTL_MS, type UploadRow } from '../../src/core/AppMediaStore.js';
import { assembleChunks } from '../../src/core/appMediaWorker.js';
import { attachmentIdFor, CHUNK_BYTES, type AppAttachment } from '../../src/core/appMediaTypes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-media-store.test.ts' }); });

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const png = (n = 100) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(n)]);
const KEY = '11111111-1111-4111-8111-111111111111';

function setup(opts: { max?: number; disk?: { free: number; total: number } | null; now?: { t: number } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-'));
  dirs.push(dir);
  const clock = opts.now ?? { t: Date.now() };
  const reports: string[] = [];
  const refused: string[] = [];
  const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm1', now: () => clock.t });
  const media = new AppMediaStore({
    stateDir: dir, store, now: () => clock.t, maxStoreBytes: () => opts.max ?? 1024 * 1024 * 1024,
    diskSpace: () => opts.disk ?? { free: 1e12, total: 2e12 }, reportDegradation: (_w, d) => reports.push(d), onRefused: (e) => refused.push(e),
  });
  return { dir, store, media, clock, reports, refused };
}
type Env = ReturnType<typeof setup>;

const start = (e: Env, bytes: Buffer, device = 'dev1') => e.media.startUpload({
  deviceId: device, conversationRef: `app:${KEY}`, size: bytes.length, sha256: sha(bytes), declaredKind: 'photo', declaredType: 'image/png', filename: 'a.png',
}) as UploadRow;

async function completed(e: Env, bytes: Buffer, device = 'dev1'): Promise<UploadRow> {
  const u = start(e, bytes, device);
  for (let i = 0; i * CHUNK_BYTES < bytes.length; i++) {
    const r = e.media.putChunk(e.media.getUpload(u.uploadId)!, i, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
    expect('ok' in r).toBe(true);
  }
  await e.media.finalizeUpload(u.uploadId);
  return e.media.getUpload(u.uploadId)!;
}

function attachment(messageId: string, bytes: Buffer, index = 0): AppAttachment {
  return { attachmentId: attachmentIdFor(messageId, index), index, sha256: sha(bytes), size: bytes.length, declaredKind: 'photo', kind: 'photo', mediaType: 'image/png', declaredType: 'image/png', filename: 'a.png' };
}
function mediaEvent(e: Env, messageId: string, bytes: Buffer, key = KEY): MediaMessageEvent {
  const ev: MediaMessageEvent = { eventId: `ev-${messageId}`, kind: 'media-message', conversationKey: key, messageId, role: 'operator', text: '', at: new Date(e.clock.t).toISOString(), machineId: 'm1', attachments: [attachment(messageId, bytes)] };
  e.store.append(ev);
  return ev;
}
async function storeBlob(e: Env, bytes: Buffer, messageId: string, key = KEY): Promise<UploadRow> {
  const u = await completed(e, bytes);
  expect(e.media.claimUploads([u.uploadId], messageId)).toBe(true);
  await e.media.publishClaimed([u.uploadId]);
  mediaEvent(e, messageId, bytes, key);
  e.media.markSent([u.uploadId], messageId);
  return u;
}

describe('chunks', () => {
  it('records repeats, refuses conflicts, wrong lengths and out-of-range indexes', () => {
    const e = setup();
    const bytes = png(CHUNK_BYTES + 10);
    const u = start(e, bytes);
    const first = bytes.subarray(0, CHUNK_BYTES);
    expect(e.media.putChunk(u, 0, first)).toMatchObject({ ok: true, lastChunk: false });
    expect(e.media.putChunk(u, 0, first)).toMatchObject({ ok: true });
    expect(e.media.putChunk(u, 0, Buffer.alloc(CHUNK_BYTES))).toMatchObject({ status: 409, error: 'chunk-conflict' });
    expect(e.media.putChunk(u, 1, Buffer.alloc(3))).toMatchObject({ status: 400, error: 'chunk-wrong-length' });
    expect(e.media.putChunk(u, 2, Buffer.alloc(3))).toMatchObject({ status: 400, error: 'chunk-out-of-range' });
    expect(e.media.receivedChunks(u.uploadId)).toEqual([0]);
  });

  it('assembles, sniffs from the bytes and removes the chunks', async () => {
    const e = setup();
    const u = await completed(e, png(CHUNK_BYTES + 10));
    expect(u).toMatchObject({ state: 'complete', mediaType: 'image/png' });
    const names = fs.readdirSync(path.join(e.media.root, 'uploads', u.uploadId));
    expect(names).toEqual(['assembled']);
    expect(fs.statSync(path.join(e.media.root, 'uploads', u.uploadId, 'assembled')).mode & 0o777).toBe(0o400);
  });

  it('a whole-file hash mismatch discards the upload and releases its reservation', async () => {
    const e = setup();
    const bytes = png();
    const u = e.media.startUpload({ deviceId: 'd', conversationRef: `app:${KEY}`, size: bytes.length, sha256: 'b'.repeat(64), declaredKind: 'photo', declaredType: 'image/png', filename: 'a.png' }) as UploadRow;
    e.media.putChunk(u, 0, bytes);
    await e.media.finalizeUpload(u.uploadId);
    expect(e.media.wasHashMismatch(u.uploadId)).toBe(true);
    expect(e.media.getUpload(u.uploadId)).toMatchObject({ state: 'expired', reserved: 0 });
    expect(fs.existsSync(path.join(e.media.root, 'uploads', u.uploadId))).toBe(false);
  });

  it('assembly runs off the event loop: a timer keeps firing during it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mworker-'));
    dirs.push(dir);
    const paths: string[] = [];
    for (let i = 0; i < 24; i++) { const p = path.join(dir, String(i)); fs.writeFileSync(p, crypto.randomBytes(1024 * 1024)); paths.push(p); }
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    await assembleChunks(paths, path.join(dir, 'out'));
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('upload limits', () => {
  it('refuses a file over 50 MiB and a fifth upload still receiving chunks; finished uploads do not count as open', async () => {
    const e = setup();
    expect(e.media.startUpload({ deviceId: 'd', conversationRef: 'x', size: 50 * 1024 * 1024 + 1, sha256: 'a'.repeat(64), declaredKind: 'file', declaredType: 't', filename: 'f' })).toMatchObject({ status: 413 });
    for (let i = 0; i < 4; i++) start(e, png());
    expect(e.media.startUpload({ deviceId: 'dev1', conversationRef: 'x', size: 10, sha256: 'a'.repeat(64), declaredKind: 'file', declaredType: 't', filename: 'f' })).toMatchObject({ status: 429, error: 'too-many-uploads' });
    const e2 = setup();
    for (let i = 0; i < 6; i++) expect((await completed(e2, png())).state).toBe('complete');
  });

  it('expiry at 24 hours releases the reservation; an expired upload answers 410', async () => {
    const e = setup();
    const u = start(e, png());
    expect(e.media.reservedBytes()).toBeGreaterThan(0);
    e.clock.t += UPLOAD_TTL_MS + 1;
    expect(e.media.expireUploads()).toBe(1);
    expect(e.media.reservedBytes()).toBe(0);
    expect(e.media.putChunk(e.media.getUpload(u.uploadId)!, 0, Buffer.alloc(1))).toMatchObject({ status: 410 });
  });
});

describe('claims', () => {
  it('two sends naming one upload: exactly one claims it', async () => {
    const e = setup();
    const u = await completed(e, png());
    expect(e.media.claimUploads([u.uploadId], 'm-a')).toBe(true);
    expect(e.media.claimUploads([u.uploadId], 'm-b')).toBe(false);
  });

  it('a claim of several fails as a whole', async () => {
    const e = setup();
    const a = await completed(e, png());
    const b = await completed(e, png());
    expect(e.media.claimUploads([a.uploadId], 'm-a')).toBe(true);
    expect(e.media.claimUploads([b.uploadId, a.uploadId], 'm-b')).toBe(false);
    expect(e.media.getUpload(b.uploadId)!.state).toBe('complete');
  });

  it('a running claim is never undone, however old', async () => {
    const e = setup();
    const u = await completed(e, png());
    e.media.claimUploads([u.uploadId], 'm-a');
    e.clock.t += CLAIM_RECOVERY_AGE_MS + 1;
    e.media.recoverClaims(() => false);
    expect(e.media.getUpload(u.uploadId)!.state).toBe('claimed');
  });

  it('crash before the rename: after a restart the upload is complete again', async () => {
    const e = setup();
    const u = await completed(e, png());
    e.media.claimUploads([u.uploadId], 'm-a');
    const restarted = new AppMediaStore({ stateDir: e.dir, store: e.store, now: () => e.clock.t, maxStoreBytes: () => 1e12 });
    e.clock.t += CLAIM_RECOVERY_AGE_MS + 1;
    restarted.recoverClaims(() => false);
    expect(restarted.getUpload(u.uploadId)!.state).toBe('complete');
  });

  it('crash after the rename: the upload is complete, pointing at the blob, and can be sent', async () => {
    const e = setup();
    const bytes = png();
    const u = await completed(e, bytes);
    e.media.claimUploads([u.uploadId], 'm-a');
    await e.media.publishClaimed([u.uploadId]);
    const restarted = new AppMediaStore({ stateDir: e.dir, store: e.store, now: () => e.clock.t, maxStoreBytes: () => 1e12 });
    e.clock.t += CLAIM_RECOVERY_AGE_MS + 1;
    restarted.recoverClaims(() => false);
    expect(restarted.getUpload(u.uploadId)).toMatchObject({ state: 'complete', blobReady: 1 });
    expect(restarted.claimUploads([u.uploadId], 'm-b')).toBe(true);
    await restarted.publishClaimed([u.uploadId]);
    expect(restarted.locateBlob(sha(bytes))).not.toBeNull();
  });

  it('a claim whose event is stored becomes sent', async () => {
    const e = setup();
    const bytes = png();
    const u = await completed(e, bytes);
    e.media.claimUploads([u.uploadId], 'm-a');
    await e.media.publishClaimed([u.uploadId]);
    mediaEvent(e, 'm-a', bytes);
    const restarted = new AppMediaStore({ stateDir: e.dir, store: e.store, now: () => e.clock.t, maxStoreBytes: () => 1e12 });
    e.clock.t += CLAIM_RECOVERY_AGE_MS + 1;
    restarted.recoverClaims((id) => e.store.hasMessage(id));
    expect(restarted.getUpload(u.uploadId)!.state).toBe('sent');
  });

  it('assembly crash: recovery runs it again, and a damaged assembled file is rebuilt from chunks', async () => {
    const e = setup();
    const bytes = png();
    const u = start(e, bytes);
    e.media.putChunk(u, 0, bytes);
    fs.writeFileSync(path.join(e.media.root, 'uploads', u.uploadId, 'assembled'), 'partial');
    await e.media.recoverUploads();
    expect(e.media.getUpload(u.uploadId)).toMatchObject({ state: 'complete', mediaType: 'image/png' });
  });

  it('a lost chunk file drops its row so the app resends it', async () => {
    const e = setup();
    const bytes = png(CHUNK_BYTES + 5);
    const u = start(e, bytes);
    e.media.putChunk(u, 0, bytes.subarray(0, CHUNK_BYTES));
    SafeFsExecutor.safeRmSync(path.join(e.media.root, 'uploads', u.uploadId, '0'), { operation: 'tests/unit/app-media-store.test.ts' });
    fs.writeFileSync(path.join(e.media.root, 'uploads', u.uploadId, '5'), 'stray');
    await e.media.recoverUploads();
    expect(e.media.receivedChunks(u.uploadId)).toEqual([]);
    expect(fs.readdirSync(path.join(e.media.root, 'uploads', u.uploadId))).toEqual([]);
  });

  it('a blob is written once and a second copy is discarded', async () => {
    const e = setup();
    const bytes = png();
    await storeBlob(e, bytes, 'm-a');
    const u2 = await completed(e, bytes);
    e.media.claimUploads([u2.uploadId], 'm-b');
    await e.media.publishClaimed([u2.uploadId]);
    expect(fs.existsSync(path.join(e.media.root, 'uploads', u2.uploadId, 'assembled'))).toBe(false);
    expect(fs.readFileSync(e.media.locateBlob(sha(bytes))!).equals(bytes)).toBe(true);
    expect(fs.statSync(e.media.locateBlob(sha(bytes))!).mode & 0o777).toBe(0o400);
  });
});

describe('admission', () => {
  it('usage comes from replicated events, so another machine\'s admission counts once it lands', () => {
    const e = setup({ max: 1000 });
    const bytes = png(800);
    expect('uploadId' in e.media.startUpload({ deviceId: 'd', conversationRef: 'x', size: 900, sha256: 'c'.repeat(64), declaredKind: 'file', declaredType: 't', filename: 'f' })).toBe(true);
    e.store.ingestReplicated({ eventId: 'r1', kind: 'media-message', conversationKey: KEY, messageId: 'remote', role: 'operator', text: '', at: new Date(e.clock.t).toISOString(), machineId: 'm2', attachments: [attachment('remote', bytes)] });
    expect(e.store.mediaLiveBytes()).toBe(bytes.length);
    expect(e.media.startUpload({ deviceId: 'd2', conversationRef: 'x', size: 10, sha256: 'd'.repeat(64), declaredKind: 'file', declaredType: 't', filename: 'f' })).toMatchObject({ status: 507, error: 'media-store-full' });
    expect(e.refused).toEqual(['media-store-full']);
  });

  it('a hash already live reserves nothing', async () => {
    const e = setup();
    const bytes = png();
    await storeBlob(e, bytes, 'm-a');
    expect(start(e, bytes).reserved).toBe(0);
  });

  it('a concurrent second start of the same new file reserves once', () => {
    const e = setup();
    const bytes = png();
    expect(start(e, bytes).reserved).toBe(bytes.length);
    expect(start(e, bytes, 'dev2').reserved).toBe(0);
  });

  it('refuses every admission below the disk floor', () => {
    const e = setup({ disk: { free: 1024, total: 2e12 } });
    expect(e.media.startUpload({ deviceId: 'd', conversationRef: 'x', size: 10, sha256: 'd'.repeat(64), declaredKind: 'file', declaredType: 't', filename: 'f' })).toMatchObject({ status: 507, error: 'media-disk-floor' });
    expect(e.media.reserveReplyBytes('r', 10)).toMatchObject({ status: 507, error: 'media-disk-floor' });
  });

  it('the floor is the larger of 5% and 2 GiB', () => {
    expect(setup({ disk: { free: 1.9e9, total: 3e9 } }).media.belowDiskFloor()).toBe(true);
    expect(setup({ disk: { free: 4e10, total: 1e12 } }).media.belowDiskFloor()).toBe(true);
    expect(setup({ disk: { free: 6e10, total: 1e12 } }).media.belowDiskFloor()).toBe(false);
  });

  it('a deleted conversation\'s files do not count, and its blobs move aside untouched', async () => {
    const e = setup();
    const bytes = png();
    await storeBlob(e, bytes, 'm-a');
    expect(e.store.mediaLiveBytes()).toBe(bytes.length);
    e.store.append({ eventId: 't', kind: 'tombstone', conversationKey: KEY, at: new Date(e.clock.t).toISOString(), machineId: 'm1' });
    expect(e.store.mediaLiveBytes()).toBe(0);
    e.media.applyReferences();
    expect(e.media.locateBlob(sha(bytes))).toContain(`${path.sep}deleted${path.sep}`);
    expect(e.media.health().deletedBytes).toBe(bytes.length);
  });

  it('a blob shared with a live conversation stays live', async () => {
    const e = setup();
    const bytes = png();
    await storeBlob(e, bytes, 'm-a');
    mediaEvent(e, 'm-b', bytes, '22222222-2222-4222-8222-222222222222');
    e.store.append({ eventId: 't', kind: 'tombstone', conversationKey: KEY, at: new Date(e.clock.t).toISOString(), machineId: 'm1' });
    e.media.applyReferences();
    expect(e.store.mediaLiveBytes()).toBe(bytes.length);
    expect(e.media.locateBlob(sha(bytes))).toContain(`${path.sep}blobs${path.sep}`);
  });
});

describe('purge', () => {
  const purge = (e: Env, ids: string[], id = 'p1') => e.store.append({ eventId: id, kind: 'purge', conversationKey: KEY, attachmentIds: ids, at: new Date(e.clock.t).toISOString(), machineId: 'm1' });

  it('removes only blobs nothing else references, and their session copies', async () => {
    const e = setup();
    const a = png();
    const b = png();
    await storeBlob(e, a, 'm-a');
    await storeBlob(e, b, 'm-b');
    const copy = await e.media.sessionCopy('m-a', attachment('m-a', a));
    purge(e, [attachmentIdFor('m-a', 0)]);
    e.media.applyReferences();
    expect(e.media.locateBlob(sha(a))).toBeNull();
    expect(fs.existsSync(copy!)).toBe(false);
    expect(e.media.locateBlob(sha(b))).not.toBeNull();
    expect(e.media.byteFact(sha(a), attachmentIdFor('m-a', 0))).toEqual({ bytes: 'removed' });
  });

  it('a hash referenced elsewhere keeps its blob', async () => {
    const e = setup();
    const a = png();
    await storeBlob(e, a, 'm-a');
    mediaEvent(e, 'm-b', a);
    purge(e, [attachmentIdFor('m-a', 0)]);
    e.media.applyReferences();
    expect(e.media.locateBlob(sha(a))).not.toBeNull();
  });

  it('a purge that lands before its media message still takes effect', async () => {
    const e = setup();
    const a = png();
    purge(e, [attachmentIdFor('m-a', 0)]);
    mediaEvent(e, 'm-a', a);
    expect(e.store.mediaRef(attachmentIdFor('m-a', 0))).toMatchObject({ purged: true });
    expect(e.store.mediaLiveBytes()).toBe(0);
    expect(e.store.mediaReferencedHashes()).toEqual([]);
  });

  it('a purge before the tombstone still counts right', async () => {
    const e = setup();
    const a = png();
    await storeBlob(e, a, 'm-a');
    purge(e, [attachmentIdFor('m-a', 0)]);
    e.store.append({ eventId: 't', kind: 'tombstone', conversationKey: KEY, at: new Date(e.clock.t).toISOString(), machineId: 'm1' });
    e.media.applyReferences();
    expect(e.media.locateBlob(sha(a))).toBeNull();
    expect(e.store.mediaLiveBytes()).toBe(0);
  });

  it('survives an index rebuild', async () => {
    const e = setup();
    const a = png();
    const b = png();
    await storeBlob(e, a, 'm-a');
    await storeBlob(e, b, 'm-b');
    purge(e, [attachmentIdFor('m-a', 0)]);
    e.store.rebuildIndex();
    expect(e.store.mediaLiveBytes()).toBe(b.length);
  });
});

describe('sweep', () => {
  it('an orphan goes after 7 days, never while an upload names it', async () => {
    const e = setup();
    const a = png();
    const u = await completed(e, a);
    e.media.claimUploads([u.uploadId], 'm-a');
    await e.media.publishClaimed([u.uploadId]); // a blob with no event: an interrupted send
    await e.media.sweep(() => false);
    expect(e.media.locateBlob(sha(a))).not.toBeNull();
    e.media.releaseClaim([u.uploadId], 'm-a');
    await e.media.sweep(() => false);
    expect(e.media.health().orphanBlobs).toBe(0); // named by a complete upload
    e.clock.t += UPLOAD_TTL_MS + 1;
    await e.media.sweep(() => false); // the upload expired; now the blob is an orphan
    expect(e.media.health().orphanBlobs).toBe(1);
    e.clock.t += 6 * 24 * 60 * 60_000;
    await e.media.sweep(() => false);
    expect(e.media.locateBlob(sha(a))).not.toBeNull();
    e.clock.t += 24 * 60 * 60_000 + 1;
    await e.media.sweep(() => false);
    expect(e.media.locateBlob(sha(a))).toBeNull();
  });

  it('a blob whose bytes changed is quarantined, reported and reads mismatch', async () => {
    const e = setup();
    const a = png();
    await storeBlob(e, a, 'm-a');
    const p = e.media.locateBlob(sha(a))!;
    fs.chmodSync(p, 0o600);
    fs.writeFileSync(p, 'tampered bytes');
    await e.media.sweep(() => true);
    expect(e.media.locateBlob(sha(a))).toBeNull();
    expect(e.media.isQuarantined(sha(a))).toBe(true);
    expect(e.media.byteFact(sha(a), attachmentIdFor('m-a', 0)).bytes).toBe('mismatch');
    expect(e.reports.some((r) => r.includes('quarantined'))).toBe(true);
  });

  it('counts a referenced hash that is not here, and reads null before the first sweep', async () => {
    const e = setup();
    expect(e.media.health()).toMatchObject({ missingBlobs: null, orphanBlobs: null, singleCopyBlobs: null });
    mediaEvent(e, 'm-a', png());
    await e.media.sweep(() => true);
    expect(e.media.health()).toMatchObject({ missingBlobs: 1, orphanBlobs: 0 });
    expect(e.media.byteFact('f'.repeat(64), 'x').bytes).toBe('not-here');
  });
});

describe('session copies', () => {
  it('are a separate inode, mode 0400, with a server-chosen name', async () => {
    const e = setup();
    const a = png();
    await storeBlob(e, a, 'm-a');
    const copy = (await e.media.sessionCopy('m-a', { ...attachment('m-a', a), filename: '../../evil name.exe' }))!;
    expect(path.dirname(copy)).toBe(path.join(e.media.root, 'session-files', 'm-a'));
    expect(path.basename(copy)).toBe('0-evil_name.png');
    expect(fs.statSync(copy).ino).not.toBe(fs.statSync(e.media.locateBlob(sha(a))!).ino);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o400);
    expect(fs.readFileSync(copy).equals(a)).toBe(true);
  });
});

describe('capacity notices (the service latch)', () => {
  it('raises one notice per episode however many sweeps run, and re-arms only after it clears', async () => {
    const { AppConversationService } = await import('../../src/core/AppConversationService.js');
    const { ConversationRegistry } = await import('../../src/core/ConversationRegistry.js');
    const { MobileChatRequestStore } = await import('../../src/core/MobileChatRequests.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnotice-'));
    dirs.push(dir);
    let max = 10;
    const raised: string[] = [];
    const cleared: string[] = [];
    const svc = new AppConversationService({
      stateDir: dir, machineId: () => 'm1', registry: new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true }),
      requests: new MobileChatRequestStore(dir), holdsLease: () => true, ownerName: () => 'Justin', dispatch: () => null,
      mediaMaxStoreBytes: () => max, raiseAttention: (i) => raised.push(i.conditionKey), clearAttention: (k) => cleared.push(k),
    });
    const start = () => svc.media.startUpload({ deviceId: 'd', conversationRef: `app:${KEY}`, size: 100, sha256: crypto.randomBytes(32).toString('hex'), declaredKind: 'file', declaredType: 't', filename: 'f' });
    // Fill the store past 90% of the cap, then get refused.
    max = 1000;
    expect('uploadId' in start()).toBe(true);
    max = 100;
    expect(start()).toMatchObject({ error: 'media-store-full' });
    for (let i = 0; i < 5; i++) await svc.sweepMedia();
    expect(raised).toEqual(['app-media:store-full']);
    max = 1e9;
    await svc.sweepMedia();
    expect(cleared).toEqual(['app-media:store-full']);
    max = 100;
    expect(start()).toMatchObject({ error: 'media-store-full' });
    await svc.sweepMedia();
    expect(raised).toEqual(['app-media:store-full', 'app-media:store-full']);
    svc.stop();
  });
});
