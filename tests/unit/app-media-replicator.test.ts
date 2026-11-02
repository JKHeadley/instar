/**
 * AppMediaReplicator (docs/specs/mobile-native-chat-media.md §4.12): the `app-media-pull` serve
 * side, verified pulls with their brakes (backoff, give-up, peer breaker), the load and disk
 * pauses, inventories and the single-copy count with its alarm ladder.
 *
 * Two machines in one process: B's transport calls A's `serve` directly (the mesh envelope is
 * covered by the integration test).
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationStore, type MediaMessageEvent } from '../../src/core/AppConversationStore.js';
import { AppMediaStore, type UploadRow } from '../../src/core/AppMediaStore.js';
import {
  AppMediaReplicator, APP_MEDIA_SLICE_BYTES, BACKOFF_MAX_MS, BACKOFF_MIN_MS, GIVE_UP_MS, LOAD_PAUSE_MAX_MS, PEER_OPEN_MS, SINGLE_COPY_GRACE_MS,
  SLICES_PER_TICK, UNMEASURABLE_ALARM_MS, type AppMediaPullCommand, type AppMediaTransport, type MeshSendResult,
} from '../../src/core/AppMediaReplicator.js';
import { attachmentIdFor, CHUNK_BYTES, type AppAttachment } from '../../src/core/appMediaTypes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { checkCommandRBAC } from '../../src/core/MeshRpc.js';
import { availableLine, captionSnippet } from '../../src/core/AppConversationService.js';

const dirs: string[] = [];
const reps: AppMediaReplicator[] = [];
afterEach(() => {
  for (const r of reps.splice(0)) r.stop();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-media-replicator.test.ts' });
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const png = (n = 100) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(n)]);
const KEY = '22222222-2222-4222-8222-222222222222';

function machine(id: string, clock: { t: number }, disk: { free: number; total: number } = { free: 1e12, total: 2e12 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mrep-${id}-`));
  dirs.push(dir);
  const store = new AppConversationStore({ stateDir: dir, machineId: () => id, now: () => clock.t });
  const diskBox = { v: disk };
  const media = new AppMediaStore({ stateDir: dir, store, now: () => clock.t, maxStoreBytes: () => 1e12, diskSpace: () => diskBox.v });
  const notices: Array<{ conditionKey: string; title: string; body: string }> = [];
  const cleared: string[] = [];
  const landed: string[] = [];
  const rep = new AppMediaReplicator({
    media, store, selfId: () => id, now: () => clock.t,
    raiseAttention: (i) => notices.push(i), clearAttention: (k) => cleared.push(k), onBlobLanded: (s) => landed.push(s),
  });
  reps.push(rep);
  return { id, dir, store, media, rep, notices, cleared, landed, diskBox };
}
type M = ReturnType<typeof machine>;

function attachment(messageId: string, bytes: Buffer, index = 0): AppAttachment {
  return { attachmentId: attachmentIdFor(messageId, index), index, sha256: sha(bytes), size: bytes.length, declaredKind: 'photo', kind: 'photo', mediaType: 'image/png', declaredType: 'image/png', filename: 'a.png' };
}
function event(messageId: string, bytes: Buffer, at: number): MediaMessageEvent {
  return { eventId: `ev-${messageId}`, kind: 'media-message', conversationKey: KEY, messageId, role: 'operator', text: 'hi', at: new Date(at).toISOString(), machineId: 'A', attachments: [attachment(messageId, bytes)] };
}

/** Upload, claim, publish and record the event on machine `m` (as the send route does). */
async function holdOn(m: M, bytes: Buffer, messageId: string, clock: { t: number }): Promise<MediaMessageEvent> {
  const u = m.media.startUpload({ deviceId: 'dev', conversationRef: `app:${KEY}`, size: bytes.length, sha256: sha(bytes), declaredKind: 'photo', declaredType: 'image/png', filename: 'a.png' }) as UploadRow;
  for (let i = 0; i * CHUNK_BYTES < bytes.length; i++) m.media.putChunk(m.media.getUpload(u.uploadId)!, i, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
  await m.media.finalizeUpload(u.uploadId);
  m.media.claimUploads([u.uploadId], messageId);
  await m.media.publishClaimed([u.uploadId]);
  const ev = event(messageId, bytes, clock.t);
  m.store.append(ev);
  m.media.markSent([u.uploadId], messageId);
  return ev;
}

function link(b: M, peers: M[], opts: { tamper?: (cmd: AppMediaPullCommand, r: unknown) => unknown; online?: () => boolean; load?: () => string; sent?: AppMediaPullCommand[] } = {}): AppMediaTransport {
  const t: AppMediaTransport = {
    peers: () => peers.map((p) => ({ machineId: p.id, online: opts.online ? opts.online() : true })),
    send: async (id, cmd): Promise<MeshSendResult> => {
      opts.sent?.push(cmd);
      const peer = peers.find((p) => p.id === id)!;
      const r = await peer.rep.serve(cmd);
      return { ok: true, status: 200, result: opts.tamper ? opts.tamper(cmd, r) : r };
    },
    loadVerdict: opts.load,
  };
  b.rep.attachTransport(t);
  return t;
}

async function tickUntil(m: M, cond: () => boolean, clock: { t: number }, max = 40): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) { await m.rep.tick(); await new Promise((r) => setTimeout(r, 25)); clock.t += 1_000; }
}

describe('serve', () => {
  it('serves slices only of blobs an unpurged local event references, and refuses bad requests', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const bytes = png(APP_MEDIA_SLICE_BYTES + 500);
    await holdOn(a, bytes, 'm1', clock);
    const h = sha(bytes);
    const first = await a.rep.serve({ type: 'app-media-pull', op: 'slice', sha256: h, offset: 0 }) as { ok: true; size: number; dataB64: string };
    expect(first.ok).toBe(true);
    expect(first.size).toBe(bytes.length);
    expect(Buffer.from(first.dataB64, 'base64').equals(bytes.subarray(0, APP_MEDIA_SLICE_BYTES))).toBe(true);
    const second = await a.rep.serve({ type: 'app-media-pull', op: 'slice', sha256: h, offset: APP_MEDIA_SLICE_BYTES }) as { dataB64: string };
    expect(Buffer.from(second.dataB64, 'base64').equals(bytes.subarray(APP_MEDIA_SLICE_BYTES))).toBe(true);
    expect(await a.rep.serve({ type: 'app-media-pull', op: 'slice', sha256: sha(png()), offset: 0 })).toEqual({ ok: false, reason: 'not-referenced' });
    expect(await a.rep.serve({ type: 'app-media-pull', op: 'slice', sha256: 'x', offset: 0 })).toEqual({ ok: false, reason: 'bad-request' });
    expect(await a.rep.serve({ type: 'app-media-pull', op: 'slice', sha256: h, offset: -1 })).toEqual({ ok: false, reason: 'bad-request' });
    expect(await a.rep.serve({ type: 'app-media-pull', op: 'slice', sha256: h, offset: bytes.length + 1 })).toEqual({ ok: false, reason: 'bad-offset' });
    expect(await a.rep.serve({ type: 'app-media-pull', op: 'bogus' } as never)).toEqual({ ok: false, reason: 'bad-op' });
  });

  it('a referenced hash this machine does not hold reads not-held; a purged one not-referenced', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const bytes = png();
    const ev = event('m1', bytes, clock.t);
    a.store.append(ev);
    expect(await a.rep.serve({ type: 'app-media-pull', op: 'slice', sha256: sha(bytes), offset: 0 })).toEqual({ ok: false, reason: 'not-held' });
    a.store.append({ eventId: 'pg1', kind: 'purge', conversationKey: KEY, attachmentIds: [ev.attachments[0].attachmentId], at: new Date(clock.t).toISOString(), machineId: 'A' });
    expect(await a.rep.serve({ type: 'app-media-pull', op: 'slice', sha256: sha(bytes), offset: 0 })).toEqual({ ok: false, reason: 'not-referenced' });
  });

  it('serves at most two slices at once', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const bytes = png(2 * APP_MEDIA_SLICE_BYTES);
    await holdOn(a, bytes, 'm1', clock);
    const ask = () => a.rep.serve({ type: 'app-media-pull', op: 'slice', sha256: sha(bytes), offset: 0 }) as Promise<{ ok: boolean; reason?: string }>;
    const all = await Promise.all([ask(), ask(), ask()]);
    expect(all.filter((r) => r.ok).length).toBe(2);
    expect(all.filter((r) => r.reason === 'busy').length).toBe(1);
  });

  it('inventory: full pages, then unchanged, then a diff after a new blob', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b1 = png();
    await holdOn(a, b1, 'm1', clock);
    const full = await a.rep.serve({ type: 'app-media-pull', op: 'inventory' }) as { version: string; hashes: string[]; next: null; full: true };
    expect(full).toMatchObject({ ok: true, full: true, hashes: [sha(b1)], next: null });
    expect(await a.rep.serve({ type: 'app-media-pull', op: 'inventory', since: full.version })).toMatchObject({ unchanged: true, version: full.version });
    const b2 = png();
    await holdOn(a, b2, 'm2', clock);
    clock.t += 10 * 60_000; // past the reuse window
    const diff = await a.rep.serve({ type: 'app-media-pull', op: 'inventory', since: full.version }) as { diff: { added: string[]; removed: string[] } };
    expect(diff.diff).toEqual({ added: [sha(b2)], removed: [] });
  });
});

describe('pull', () => {
  it('copies a multi-slice blob, verified, into the blob store, and reports it landed', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png(2 * APP_MEDIA_SLICE_BYTES + 7);
    const ev = await holdOn(a, bytes, 'm1', clock);
    b.store.ingestReplicated(ev);
    link(b, [a]);
    expect(b.media.byteFact(sha(bytes), ev.attachments[0].attachmentId).bytes).toBe('not-here');
    await tickUntil(b, () => !!b.media.locateBlob(sha(bytes)), clock);
    const held = b.media.locateBlob(sha(bytes))!;
    expect(fs.readFileSync(held).equals(bytes)).toBe(true);
    expect(fs.statSync(held).mode & 0o777).toBe(0o400);
    expect(b.landed).toEqual([sha(bytes)]);
    expect(b.media.byteFact(sha(bytes), ev.attachments[0].attachmentId).bytes).toBe('verified');
    expect(fs.readdirSync(b.media.pullsDir)).toEqual([]);
  });

  it('a file whose bytes do not match its hash is never kept, and five such copies open the peer breaker', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png(500);
    const ev = await holdOn(a, bytes, 'm1', clock);
    b.store.ingestReplicated(ev);
    // The peer flips one byte in every slice it serves.
    link(b, [a], { tamper: (_c, r) => { const x = r as { dataB64?: string }; if (!x.dataB64) return r; const buf = Buffer.from(x.dataB64, 'base64'); buf[0] ^= 1; return { ...x, dataB64: buf.toString('base64') }; } });
    for (let i = 0; i < 4; i++) { await b.rep.tick(); clock.t += BACKOFF_MAX_MS + 1; }
    expect(b.rep.breakerOpen('A')).toBe(false);
    await b.rep.tick();
    expect(b.media.locateBlob(sha(bytes))).toBeNull();
    expect(fs.readdirSync(b.media.pullsDir)).toEqual([]);
    expect(b.rep.counters.verifyFailures).toBe(5);
    expect(b.rep.breakerOpen('A')).toBe(true);
    clock.t += PEER_OPEN_MS + 1;
    expect(b.rep.breakerOpen('A')).toBe(false);
  });

  it('three breaker opens in a day keep the peer closed until the next day, with one notice', async () => {
    const clock = { t: Date.parse('2026-11-02T01:00:00Z') };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png(300);
    const ev = await holdOn(a, bytes, 'm1', clock);
    b.store.ingestReplicated(ev);
    link(b, [a], { tamper: (c, r) => (c.op === 'slice' ? { ...(r as object), offset: 99 } : r) });
    for (let open = 0; open < 3; open++) {
      for (let i = 0; i < 5; i++) { await b.rep.tick(); clock.t += BACKOFF_MAX_MS + 1; }
      clock.t += PEER_OPEN_MS + 1;
    }
    expect(b.rep.breakerOpen('A')).toBe(true);
    expect(b.notices.filter((n) => n.conditionKey === 'app-media:peer-breaker:A')).toHaveLength(1);
    clock.t = Date.parse('2026-11-03T00:30:00Z');
    expect(b.rep.breakerOpen('A')).toBe(false);
    expect(b.cleared).toContain('app-media:peer-breaker:A');
  });

  it('backs off 30 s → 1 h, gives up after 7 days with one notice, and a peer inventory naming it re-arms it', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    const ev = event('m1', bytes, clock.t);
    a.store.append(ev); // A references it but does not hold it: nobody can serve it
    b.store.ingestReplicated(ev);
    link(b, [a]);
    const row = () => b.media.indexDb.prepare('SELECT * FROM pulls WHERE sha256 = ?').get(sha(bytes)) as { attempts: number; nextAttemptAt: number; unrecoverable: number };
    await b.rep.tick();
    expect(row().nextAttemptAt - clock.t).toBe(BACKOFF_MIN_MS);
    clock.t = row().nextAttemptAt;
    await b.rep.tick();
    expect(row().nextAttemptAt - clock.t).toBe(2 * BACKOFF_MIN_MS);
    for (let i = 0; i < 12; i++) { clock.t = row().nextAttemptAt; await b.rep.tick(); }
    expect(row().nextAttemptAt - clock.t).toBe(BACKOFF_MAX_MS);
    expect(row().unrecoverable).toBe(0);
    clock.t += GIVE_UP_MS;
    await b.rep.tick();
    expect(row().unrecoverable).toBe(1);
    expect(b.rep.isUnrecoverable(sha(bytes))).toBe(true);
    expect(b.notices.filter((n) => n.conditionKey === 'app-media:unrecoverable:B')).toHaveLength(1);
    expect(b.media.health().unrecoverableBlobs).toBe(1);
    // Unrecoverable blobs are not asked for again …
    const sent: AppMediaPullCommand[] = [];
    link(b, [a], { sent });
    clock.t += BACKOFF_MAX_MS;
    await b.rep.tick();
    expect(sent.filter((c) => c.op === 'slice')).toHaveLength(0);
    // … until a peer inventory names a holder.
    const c = machine('C', clock);
    await holdOn(c, bytes, 'm1', clock);
    link(b, [a, c]);
    await b.rep.inventoryRound();
    expect(b.rep.isUnrecoverable(sha(bytes))).toBe(false);
    await tickUntil(b, () => !!b.media.locateBlob(sha(bytes)), clock);
    expect(b.media.locateBlob(sha(bytes))).not.toBeNull();
    b.rep.evaluateUnrecoverable();
    expect(b.cleared).toContain('app-media:unrecoverable:B');
  });

  it('a purged attachment is never pulled', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    const ev = await holdOn(a, bytes, 'm1', clock);
    b.store.ingestReplicated({ eventId: 'pg', kind: 'purge', conversationKey: KEY, attachmentIds: [ev.attachments[0].attachmentId], at: new Date(clock.t).toISOString(), machineId: 'A' });
    b.store.ingestReplicated(ev); // the purge arrived first (out of order)
    const sent: AppMediaPullCommand[] = [];
    link(b, [a], { sent });
    for (let i = 0; i < 3; i++) await b.rep.tick();
    expect(sent.filter((c) => c.op === 'slice')).toHaveLength(0);
    expect(b.media.locateBlob(sha(bytes))).toBeNull();
  });

  it('pauses below the disk floor', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock, { free: 1e9, total: 1e12 });
    const bytes = png();
    b.store.ingestReplicated(await holdOn(a, bytes, 'm1', clock));
    const sent: AppMediaPullCommand[] = [];
    link(b, [a], { sent });
    await b.rep.tick();
    expect(sent.filter((c) => c.op === 'slice')).toHaveLength(0);
    b.diskBox.v = { free: 1e12, total: 2e12 };
    await tickUntil(b, () => !!b.media.locateBlob(sha(bytes)), clock);
    expect(b.media.locateBlob(sha(bytes))).not.toBeNull();
  });

  it('under load: background pulls pause for at most an hour, then one slice per tick; an on-demand pull still runs', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const big = png(3 * APP_MEDIA_SLICE_BYTES);
    const urgent = png(100);
    b.store.ingestReplicated(await holdOn(a, big, 'm1', clock));
    b.store.ingestReplicated(await holdOn(a, urgent, 'm2', clock));
    const sent: AppMediaPullCommand[] = [];
    link(b, [a], { sent, load: () => 'saturated' });
    await b.rep.tick();
    expect(sent.filter((c) => c.op === 'slice')).toHaveLength(0);
    b.rep.want(sha(urgent));
    await tickUntil(b, () => !!b.media.locateBlob(sha(urgent)), clock, 5);
    expect(b.media.locateBlob(sha(urgent))).not.toBeNull();
    expect(sent.filter((c) => c.op === 'slice' && c.sha256 === sha(big))).toHaveLength(0);
    clock.t += LOAD_PAUSE_MAX_MS;
    sent.length = 0;
    await b.rep.tick();
    expect(sent.filter((c) => c.op === 'slice' && c.sha256 === sha(big))).toHaveLength(1);
  });

  it('moves at most 8 slices per tick', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const sent: AppMediaPullCommand[] = [];
    for (let i = 0; i < 12; i++) b.store.ingestReplicated(await holdOn(a, png(50), `m${i}`, clock));
    link(b, [a], { sent });
    await b.rep.tick();
    expect(sent.filter((c) => c.op === 'slice')).toHaveLength(SLICES_PER_TICK);
  });

  it('awaitBlob resolves true when the blob lands, false after its deadline with no peer', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    b.store.ingestReplicated(await holdOn(a, bytes, 'm1', clock));
    expect(await b.rep.awaitBlob(sha(bytes), 50)).toBe(false); // no transport yet
    link(b, [a]);
    expect(await b.rep.awaitBlob(sha(bytes), 10_000)).toBe(true);
  });
});

describe('copies and alarms', () => {
  it('singleCopyBlobs is null without a transport or a fresh peer inventory, and counts otherwise', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    await holdOn(a, bytes, 'm1', clock);
    expect(a.media.health().singleCopyBlobs).toBeNull();
    link(a, [b]);
    expect(a.media.health().singleCopyBlobs).toBeNull(); // no inventory from B yet
    await a.rep.inventoryRound();
    expect(a.media.health().singleCopyBlobs).toBe(1);
    clock.t += 3 * 60 * 60_000;
    expect(a.media.health().singleCopyBlobs).toBeNull(); // B's inventory is older than 2 hours
  });

  it('single copy with every peer online: nudge after an hour, notice an hour later, cleared when copied', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    const ev = await holdOn(a, bytes, 'm1', clock);
    const sent: AppMediaPullCommand[] = [];
    link(a, [b], { sent });
    await a.rep.inventoryRound();
    expect(sent.filter((c) => c.op === 'nudge')).toHaveLength(0);
    clock.t += SINGLE_COPY_GRACE_MS + 1;
    await a.rep.inventoryRound();
    const nudges = sent.filter((c) => c.op === 'nudge');
    expect(nudges).toHaveLength(1);
    expect(nudges[0].hashes).toEqual([sha(bytes)]);
    clock.t += SINGLE_COPY_GRACE_MS + 1;
    await a.rep.inventoryRound();
    expect(a.notices.filter((n) => n.conditionKey === 'app-media:single-copy:A')).toHaveLength(1);
    await a.rep.inventoryRound();
    expect(a.notices.filter((n) => n.conditionKey === 'app-media:single-copy:A')).toHaveLength(1); // latched
    // B gets the event and pulls the blob; A's count drops to 0 and the notice clears.
    b.store.ingestReplicated(ev);
    link(b, [a]);
    await tickUntil(b, () => !!b.media.locateBlob(sha(bytes)), clock);
    clock.t += 10 * 60_000;
    await a.rep.inventoryRound();
    expect(a.media.health().singleCopyBlobs).toBe(0);
    expect(a.cleared).toContain('app-media:single-copy:A');
  });

  it('a nudge queues only referenced hashes this machine lacks', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    b.store.ingestReplicated(await holdOn(a, bytes, 'm1', clock));
    expect(await b.rep.serve({ type: 'app-media-pull', op: 'nudge', hashes: [sha(bytes), sha(png())] })).toEqual({ ok: true, queued: 1 });
    expect(await b.rep.serve({ type: 'app-media-pull', op: 'nudge', hashes: ['nope'] })).toEqual({ ok: false, reason: 'bad-request' });
  });

  it('an offline peer: notice once single-copy blobs are older than a day; unmeasurable for 2 hours: notice', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    await holdOn(a, png(), 'm1', clock);
    let online = true;
    link(a, [b], { online: () => online });
    await a.rep.inventoryRound();
    online = false;
    clock.t += 60 * 60_000;
    await a.rep.inventoryRound();
    expect(a.notices).toHaveLength(0);
    clock.t += 24 * 60 * 60_000;
    await a.rep.inventoryRound(); // B's inventory is now stale: unmeasurable starts here
    clock.t += UNMEASURABLE_ALARM_MS + 1;
    await a.rep.inventoryRound();
    const n = a.notices.filter((x) => x.conditionKey === 'app-media:single-copy:A');
    expect(n).toHaveLength(1);
    expect(n[0].title).toMatch(/Cannot tell/);
  });

  it('one machine (no peers): counts every held blob and raises nothing', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    await holdOn(a, png(), 'm1', clock);
    link(a, []);
    clock.t += 5 * 60 * 60_000;
    await a.rep.inventoryRound();
    expect(a.media.health().singleCopyBlobs).toBe(1);
    expect(a.notices).toHaveLength(0);
  });
});

describe('verb, placement and line helpers', () => {
  it('app-media-pull is in the registered-peer read class', () => {
    expect(checkCommandRBAC({ type: 'app-media-pull', op: 'inventory' }, 'peer', { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null })).toEqual({ ok: true, reason: 'ok' });
  });

  it('a blob referenced only by a deleted conversation lands in deleted/ (retained, not counted)', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    const ev = await holdOn(a, bytes, 'm1', clock);
    b.store.ingestReplicated({ eventId: 'cr', kind: 'created', conversationKey: KEY, title: 'T', at: new Date(clock.t).toISOString(), machineId: 'A' });
    b.store.ingestReplicated(ev);
    b.store.ingestReplicated({ eventId: 'tb', kind: 'tombstone', conversationKey: KEY, at: new Date(clock.t).toISOString(), machineId: 'A' });
    link(b, [a]);
    await tickUntil(b, () => !!b.media.locateBlob(sha(bytes)), clock);
    expect(b.media.locateBlob(sha(bytes))).toContain(`${path.sep}deleted${path.sep}`);
  });

  it('the follow-up line quotes at most 40 caption characters, with no quote or bracket able to break it', () => {
    expect(captionSnippet('He said "go" [now]\nplease, then come back home for supper tonight')).toBe('He said go now please, then come back ho');
    expect(availableLine('/x/0-a.png', '')).toBe('[file now available: /x/0-a.png]');
    expect(availableLine('/x/0-a.png', 'hi')).toBe('[file now available: /x/0-a.png] (for the message "hi")');
  });
});

describe('review fixes', () => {
  it('a purge that lands while the last slice is in flight: the copy is discarded, never published', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png(300);
    const ev = await holdOn(a, bytes, 'm1', clock);
    b.store.ingestReplicated(ev);
    link(b, [a], {
      tamper: (c, r) => {
        if (c.op === 'slice') b.store.ingestReplicated({ eventId: 'pg-mid', kind: 'purge', conversationKey: KEY, attachmentIds: [ev.attachments[0].attachmentId], at: new Date(clock.t).toISOString(), machineId: 'A' });
        return r;
      },
    });
    const waited = b.rep.awaitBlob(sha(bytes), 5_000);
    await b.rep.tick();
    expect(await waited).toBe(false);
    expect(b.media.locateBlob(sha(bytes))).toBeNull();
    expect(fs.readdirSync(b.media.pullsDir)).toEqual([]);
    expect(b.media.indexDb.prepare('SELECT COUNT(*) AS n FROM pulls').get()).toEqual({ n: 0 });
  });

  it('publishPulled discards a file nothing unpurged references', () => {
    const clock = { t: Date.now() };
    const b = machine('B', clock);
    const bytes = png();
    const f = path.join(b.media.pullsDir, 'x.part');
    fs.writeFileSync(f, bytes);
    expect(b.media.publishPulled(f, sha(bytes))).toBe(false);
    expect(fs.existsSync(f)).toBe(false);
    expect(b.media.locateBlob(sha(bytes))).toBeNull();
  });

  it('canFetch: refuses with a plain reason when no copy can start', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    b.store.ingestReplicated(await holdOn(a, bytes, 'm1', clock));
    expect(b.rep.canFetch(sha(bytes))).toEqual({ ok: false, reason: expect.stringMatching(/not connected/) });
    let online = false;
    link(b, [a], { online: () => online });
    expect(b.rep.canFetch(sha(bytes))).toEqual({ ok: false, reason: 'A is not reachable' });
    online = true;
    expect(b.rep.canFetch(sha(bytes))).toEqual({ ok: true });
    b.diskBox.v = { free: 1e9, total: 1e12 };
    expect(b.rep.canFetch(sha(bytes))).toEqual({ ok: false, reason: expect.stringMatching(/out of disk space/) });
    expect(b.rep.whyNotHere(sha(bytes))).toMatch(/out of disk space/);
    b.diskBox.v = { free: 1e12, total: 2e12 };
    // A fresh inventory from A that lacks the file rules A out.
    const c = machine('C', clock);
    const other = png();
    b.store.ingestReplicated(await holdOn(c, other, 'm2', clock));
    link(b, [c]);
    await b.rep.inventoryRound();
    expect(b.rep.canFetch(sha(bytes))).toEqual({ ok: false, reason: 'no reachable machine of this agent holds it' });
  });

  it('whyNotHere names the load pause', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    b.store.ingestReplicated(await holdOn(a, bytes, 'm1', clock));
    link(b, [a], { load: () => 'saturated', online: () => true, tamper: (c, r) => (c.op === 'slice' ? { ok: false, reason: 'not-held' } : r) });
    await b.rep.tick();
    expect(b.rep.whyNotHere(sha(bytes))).toMatch(/paused while this machine is overloaded/);
  });

  it('repeated asks and nudges skip a file\'s backoff at most once per backoff window', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    const ev = event('m1', bytes, clock.t);
    a.store.append(ev); // A cannot serve it: every attempt fails
    b.store.ingestReplicated(ev);
    const sent: AppMediaPullCommand[] = [];
    link(b, [a], { sent });
    await b.rep.tick();
    const slices = () => sent.filter((c) => c.op === 'slice').length;
    expect(slices()).toBe(1);
    for (let i = 0; i < 10; i++) {
      b.rep.want(sha(bytes));
      await b.rep.serve({ type: 'app-media-pull', op: 'nudge', hashes: [sha(bytes)] });
      await b.rep.tick();
      await new Promise((r) => setTimeout(r, 5));
      clock.t += 2_000;
    }
    expect(slices()).toBe(2); // one hurried attempt in the window, not ten
    clock.t += BACKOFF_MAX_MS;
    b.rep.want(sha(bytes));
    await new Promise((r) => setTimeout(r, 20));
    await b.rep.tick();
    expect(slices()).toBe(3);
  });

  it('a timed-out waiter is removed', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const b = machine('B', clock);
    const bytes = png();
    const ev = event('m1', bytes, clock.t);
    a.store.append(ev);
    b.store.ingestReplicated(ev);
    link(b, [a]);
    expect(await b.rep.awaitBlob(sha(bytes), 30)).toBe(false);
    expect(b.rep.waiterCount()).toBe(0);
  });

  it('a partial copy comes from one peer; if it goes away the copy restarts from another, and only the bad peer is blamed', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const c = machine('C', clock);
    const b = machine('B', clock);
    const bytes = png(2 * APP_MEDIA_SLICE_BYTES + 10);
    const ev = await holdOn(a, bytes, 'm1', clock);
    await holdOn(c, bytes, 'm1', clock);
    b.store.ingestReplicated(ev);
    const servedBy: Array<{ peer: string; offset: number }> = [];
    let aOnline = true;
    const t: AppMediaTransport = {
      peers: () => [{ machineId: 'A', online: aOnline }, { machineId: 'C', online: true }],
      send: async (id, cmd) => {
        if (cmd.op === 'slice') servedBy.push({ peer: id, offset: cmd.offset! });
        const r = await (id === 'A' ? a : c).rep.serve(cmd) as { dataB64?: string };
        // C flips a byte in every slice it serves.
        if (id === 'C' && r.dataB64) { const buf = Buffer.from(r.dataB64, 'base64'); buf[0] ^= 1; return { ok: true, result: { ...r, dataB64: buf.toString('base64') } }; }
        return { ok: true, result: r };
      },
    };
    b.rep.attachTransport(t);
    // Move one slice (budget: break after it) by pulling with A, then take A away.
    const pull = b.rep as unknown as { pullOneSlice(s: string): Promise<string> };
    expect(await pull.pullOneSlice(sha(bytes))).toBe('moved');
    expect(servedBy).toEqual([{ peer: 'A', offset: 0 }]);
    aOnline = false;
    for (let i = 0; i < 3; i++) await pull.pullOneSlice(sha(bytes));
    // Restarted from offset 0 with C; every later slice from C.
    expect(servedBy.slice(1).map((s) => s.peer)).toEqual(['C', 'C', 'C']);
    expect(servedBy[1].offset).toBe(0);
    expect(b.media.locateBlob(sha(bytes))).toBeNull();
    const failures = (id: string) => (b.media.indexDb.prepare('SELECT failures FROM pull_peers WHERE machineId = ?').get(id) as { failures: number } | undefined)?.failures ?? 0;
    expect(failures('C')).toBe(1);
    expect(failures('A')).toBe(0);
  });

  it('a serving machine quarantines a blob whose bytes changed instead of serving it', async () => {
    const clock = { t: Date.now() };
    const a = machine('A', clock);
    const bytes = png(300);
    await holdOn(a, bytes, 'm1', clock);
    const p = a.media.locateBlob(sha(bytes))!;
    fs.chmodSync(p, 0o600);
    const damaged = Buffer.from(bytes);
    damaged[20] ^= 0xff;
    fs.writeFileSync(p, damaged);
    fs.utimesSync(p, new Date(), new Date(Date.now() + 5_000));
    expect(await a.rep.serve({ type: 'app-media-pull', op: 'slice', sha256: sha(bytes), offset: 0 })).toEqual({ ok: false, reason: 'not-held' });
    expect(a.media.locateBlob(sha(bytes))).toBeNull();
    expect(a.media.isQuarantined(sha(bytes))).toBe(true);
  });
});
