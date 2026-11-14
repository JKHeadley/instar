/**
 * native-conversation-base §3c items 4 to 7: a Telegram file resolved on the machine that serves the
 * session, the durable `pending_media_events` waiter, idempotent conversion, the reconciliation sweep
 * (start-up and periodic), the 300 s uncertain line, and the "now available" retry for a topic with
 * no running session. Real AppConversationService, real SQLite, real blob store.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileChatRequestStore } from '../../src/core/MobileChatRequests.js';
import { platformMediaMessageId, type AppEvent } from '../../src/core/AppConversationStore.js';
import { attachmentIdFor } from '../../src/core/appMediaTypes.js';
import { recordPlatformMedia } from '../../src/core/appPlatformMedia.js';
import { composeInboundPayload, parseQueuedMediaCell, STORED_ELSEWHERE_LINE, toWireMedia, type InboundMediaLocal } from '../../src/core/inboundMedia.js';
import { MEDIA_EVENT_TELL_AFTER_MS, PlatformMediaForSession, READY_RETRY_SETTLE_MS } from '../../src/core/platformMediaForSession.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const services: AppConversationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/platform-media-for-session.test.ts' });
});

const TOPIC = 4242;
const TKEY = `telegram:${TOPIC}`;
const jpeg = (n = 400) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function svcAt(dir: string): AppConversationService {
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry: new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true }),
    requests: new MobileChatRequestStore(dir), holdsLease: () => true, ownerName: () => 'Justin', dispatch: () => null,
    mediaDiskSpace: () => ({ free: 1e12, total: 2e12 }),
  });
  services.push(svc);
  return svc;
}

function rig(opts: { sessionLive?: () => boolean; mediaOn?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmfs-'));
  dirs.push(dir);
  const state = { svc: svcAt(dir), now: 1_000_000 };
  const injected: Array<{ topicId: number; line: string }> = [];
  const make = () => new PlatformMediaForSession({
    service: () => (opts.mediaOn === false ? null : state.svc),
    downloadDirs: () => [path.join(dir, 'telegram-images'), path.join(dir, 'telegram-documents')],
    injectToTopic: (topicId, line) => { if (opts.sessionLive && !opts.sessionLive()) return false; injected.push({ topicId, line }); return true; },
    now: () => state.now,
  });
  const download = (name: string, bytes: Buffer) => {
    const p = path.join(dir, 'telegram-images', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
    return p;
  };
  /** The poller's capture: blob published, then the platform-media event. */
  const capture = async (pmid: string, bytes: Buffer) => {
    const src = download(`src-${pmid}.jpg`, bytes);
    const r = await recordPlatformMedia(state.svc, { conversationKey: TKEY, platformMessageId: pmid, filePath: src, declaredKind: 'photo', filename: 'IMG.jpg', declaredType: 'image/jpeg', at: new Date().toISOString() });
    expect(r.recorded).toBe(true);
  };
  /** A replicated event whose blob is NOT on this machine (it arrives later). */
  const eventOnly = (pmid: string, bytes: Buffer): AppEvent => {
    const messageId = platformMediaMessageId(TKEY, pmid);
    const ev = {
      eventId: messageId, kind: 'platform-media', conversationKey: TKEY, messageId, platformMessageId: pmid,
      attachments: [{ attachmentId: attachmentIdFor(messageId, 0), index: 0, sha256: sha(bytes), size: bytes.length, declaredKind: 'photo', kind: 'photo', mediaType: 'image/jpeg', declaredType: 'image/jpeg', filename: 'IMG.jpg' }],
      at: new Date().toISOString(), machineId: 'm2',
    } as AppEvent;
    state.svc.store.append(ev);
    return ev;
  };
  /** The blob lands (as the replicator would publish it), then the store's landing hook. */
  const blobLands = async (bytes: Buffer) => {
    const tmp = path.join(dir, `land-${crypto.randomUUID()}`);
    fs.writeFileSync(tmp, bytes);
    state.svc.media.publishSnapshot(tmp, sha(bytes));
    await state.svc.resolvePending(sha(bytes));
  };
  const waiters = () => state.svc.media.indexDb.prepare('SELECT * FROM pending_media_events').all() as Array<{ eventId: string; toldAt: number | null; convertedAt: number | null }>;
  const media = (pmid: string, extra: Partial<InboundMediaLocal> = {}): InboundMediaLocal[] => [{ kind: 'photo', platformMessageId: pmid, filename: 'IMG.jpg', capture: 'pending', ...extra }];
  return { dir, state, injected, make, download, capture, eventOnly, blobLands, waiters, media };
}

const pathOf = (line: string) => /^\[image:([^\]]+)\]/.exec(line)?.[1] ?? null;
const flush = () => new Promise((r) => setImmediate(r));
/** Waits (bounded) for the listener's async conversion and copy to finish. */
async function until(cond: () => boolean, ms = 3000): Promise<void> { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); }

describe('resolving a file on the serving machine', () => {
  it('event and blob here: a private session copy that exists', async () => {
    const r = rig();
    const pm = r.make();
    const bytes = jpeg();
    await r.capture('10', bytes);
    const text = await pm.buildInboundSessionText({ conversationKey: TKEY, text: composeInboundPayload('look', r.media('10')), media: r.media('10') });
    const [line, rest] = text.split('\n');
    const p = pathOf(line!)!;
    expect(fs.readFileSync(p).equals(bytes)).toBe(true);
    expect(rest).toBe('look');
    expect(r.waiters()).toEqual([]);
  });

  it('event here, blob late: "still copying", then one "now available" when it lands', async () => {
    const r = rig();
    const pm = r.make();
    const bytes = jpeg();
    r.eventOnly('11', bytes);
    const text = await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('11') });
    expect(text).toBe('[file still copying: IMG.jpg]');
    await r.blobLands(bytes);
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0]!.line).toMatch(/^\[file now available: .+\]$/);
    expect(fs.existsSync(/\[file now available: ([^\]]+)\]/.exec(r.injected[0]!.line)![1]!)).toBe(true);
  });

  it('event after the message: a durable waiter, converted by the append listener', async () => {
    const r = rig();
    const pm = r.make();
    const bytes = jpeg();
    const text = await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('12') });
    expect(text).toBe('[file still copying: IMG.jpg]');
    expect(r.waiters()).toHaveLength(1);
    await r.capture('12', bytes); // blob first, then event: the listener converts and, the blob being here, delivers at once
    await until(() => r.injected.length > 0);
    expect(r.injected.map((i) => i.line.startsWith('[file now available:'))).toEqual([true]);
    expect(r.waiters()[0]!.convertedAt).not.toBeNull();
  });

  it('blob already here when the event lands: "now available" at once (resolvePending never fires)', async () => {
    const r = rig();
    const pm = r.make();
    const bytes = jpeg();
    await r.capture('13', bytes); // the same bytes were sent before, under another message
    r.injected.length = 0;
    await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('14') });
    expect(r.waiters()).toHaveLength(1);
    r.eventOnly('14', bytes);
    await until(() => r.injected.length > 0);
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0]!.line).toMatch(/^\[file now available: /);
  });

  it('the event lands between the first look and the waiter insert: the second look finds it', async () => {
    const r = rig();
    const pm = r.make();
    const bytes = jpeg();
    await r.capture('15', bytes);
    const store = r.state.svc.store;
    const real = store.getPlatformMedia.bind(store);
    let calls = 0;
    store.getPlatformMedia = ((k: string, id: string) => (++calls === 1 ? null : real(k, id))) as typeof store.getPlatformMedia;
    const text = await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('15') });
    store.getPlatformMedia = real;
    expect(pathOf(text)).not.toBeNull();
    expect(r.waiters()[0]!.convertedAt).not.toBeNull();
    await pm.sweep();
    expect(r.injected).toEqual([]); // converted by the resolver itself: no second line from the sweep
  });

  it('a restart between the event commit and the conversion is healed by the start-up sweep', async () => {
    const r = rig();
    const before = r.make();
    const bytes = jpeg();
    await before.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('16') });
    // Restart: a fresh service on the same disk; the event commits before any listener is attached.
    r.state.svc.stop();
    r.state.svc = svcAt(r.dir);
    const src = r.download('src-16.jpg', bytes);
    await recordPlatformMedia(r.state.svc, { conversationKey: TKEY, platformMessageId: '16', filePath: src, declaredKind: 'photo', filename: 'IMG.jpg', declaredType: 'image/jpeg', at: new Date().toISOString() });
    const after = r.make();
    await after.sweep();
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0]!.line).toMatch(/^\[file now available: /);
  });

  it('converting twice (listener and sweep together) writes one row and one line', async () => {
    const r = rig();
    const pm = r.make();
    const bytes = jpeg();
    await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('17') });
    // Commit the event without the listener seeing it first: write through a second service.
    const other = svcAt(r.dir);
    const src = r.download('src-17.jpg', bytes);
    await recordPlatformMedia(other, { conversationKey: TKEY, platformMessageId: '17', filePath: src, declaredKind: 'photo', filename: 'IMG.jpg', declaredType: 'image/jpeg', at: new Date().toISOString() });
    // The first service's store has not read it yet in-process; both conversions race on the shared db.
    r.state.svc = other;
    const eventId = platformMediaMessageId(TKEY, '17');
    const [a, b] = await Promise.all([pm.convertPendingMediaEvent(eventId), pm.convertPendingMediaEvent(eventId), pm.sweep()]);
    expect([a, b].filter(Boolean).length).toBeLessThanOrEqual(1);
    await flush();
    expect(r.injected).toHaveLength(1);
    const rows = other.media.indexDb.prepare('SELECT COUNT(*) AS n FROM pending_deliveries WHERE conversationKey = ?').get(TKEY) as { n: number };
    expect(rows.n).toBe(0);
  });

  it('no event at 300 s: the uncertain line once, the row stays, and an event at minute 7 still says "now available"', async () => {
    const r = rig();
    const pm = r.make();
    const bytes = jpeg();
    await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('18') });
    r.state.now += MEDIA_EVENT_TELL_AFTER_MS - 1;
    await pm.sweep();
    expect(r.injected).toEqual([]);
    r.state.now += 2;
    await pm.sweep();
    await pm.sweep();
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0]!.line).toContain('has not arrived on this machine yet');
    expect(r.injected[0]!.line).toContain('GET /conversation-media/path?conversationKey=telegram:4242&platformMessageId=18');
    expect(r.injected[0]!.line).not.toMatch(/fail/i);
    expect(r.waiters()).toHaveLength(1);
    r.state.now += 120_000;
    await r.capture('18', bytes);
    await until(() => r.injected.length > 1);
    expect(r.injected.map((i) => i.line.slice(0, 20))).toEqual([r.injected[0]!.line.slice(0, 20), '[file now available:']);
  });

  it('a file landing with no session running waits; the "now available" line arrives once when a session runs', async () => {
    let live = false;
    const r = rig({ sessionLive: () => live });
    const pm = r.make();
    const bytes = jpeg();
    r.eventOnly('19', bytes);
    await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('19') });
    await r.blobLands(bytes);
    await pm.sweep();
    expect(r.injected).toEqual([]);
    live = true;
    await pm.sweep();
    expect(r.injected).toEqual([]); // a ready row is retried only once it has settled (never racing a voice wait)
    r.state.now += READY_RETRY_SETTLE_MS;
    await Promise.all([pm.sweep(), pm.sweep()]);
    await pm.sweep();
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0]!.line).toMatch(/^\[file now available: /);
  });
});

describe('native media off, capture off, and older senders', () => {
  it('capture off: this machine\'s own download, else the stored-elsewhere line', async () => {
    const r = rig();
    const pm = r.make();
    const own = r.download('own.jpg', jpeg());
    expect(await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('20', { capture: 'off', localPath: own }) })).toBe(`[image:${fs.realpathSync(own)}]`);
    expect(await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('21', { capture: 'off' }) })).toBe(STORED_ELSEWHERE_LINE);
    expect(r.waiters()).toEqual([]);
  });

  it('native media off here: never a path outside the download directories', async () => {
    const r = rig({ mediaOn: false });
    const pm = r.make();
    const out = await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('22', { localPath: '/etc/hosts' }) });
    expect(out).toBe(STORED_ELSEWHERE_LINE);
  });

  it('typed tags, a tag in a caption, an older poller\'s tag and a tag beside media: [] never yield a path', async () => {
    const r = rig({ mediaOn: false });
    const pm = r.make();
    for (const typed of ['[document:/etc/passwd]', '[video:/etc/passwd]', '[voice:/etc/passwd]', 'see [image:/etc/hostname] here']) {
      const out = await pm.buildInboundSessionText({ conversationKey: TKEY, text: typed, media: [] });
      expect(out).not.toMatch(/\[(image|document|video|voice):/);
      expect(out).toContain('[typed ');
    }
    const old = await pm.buildInboundSessionText({ conversationKey: TKEY, text: '[image:/etc/hostname] caption', media: null, platformMessageId: '23' });
    expect(old).not.toContain('/etc/hostname');
    expect(old).toBe(`${STORED_ELSEWHERE_LINE}\ncaption`);
  });

  it('an older poller with media on here: resolved by its own message id, path discarded', async () => {
    const r = rig();
    const pm = r.make();
    const bytes = jpeg();
    await r.capture('24', bytes);
    const out = await pm.buildInboundSessionText({ conversationKey: TKEY, text: '[image:/somewhere/else/photo.jpg] hi', media: undefined, platformMessageId: '24' });
    const p = pathOf(out.split('\n')[0]!)!;
    expect(p).not.toContain('/somewhere/else');
    expect(fs.readFileSync(p).equals(bytes)).toBe(true);
    expect(out.split('\n')[1]).toBe('hi');
  });

  it('a queue row from before the column drains with its sentence (an older receiver\'s view is truthful)', async () => {
    const r = rig({ mediaOn: false });
    const pm = r.make();
    const payload = composeInboundPayload('cap', r.media('25'));
    // A row read back with no media column: the sentence is still there and names the attachment.
    const out = await pm.buildInboundSessionText({ conversationKey: TKEY, text: payload, media: null, platformMessageId: '25' });
    expect(out).toContain('attachment `25`');
    expect(out).toContain('cap');
  });

  it('counts each outcome for the maturation read', async () => {
    const r = rig();
    const pm = r.make();
    await r.capture('26', jpeg());
    await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('26') });
    await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: r.media('27') });
    const st = pm.stats();
    expect(st.counts.copied).toBe(1);
    expect(st.counts.copying).toBe(1);
    expect(st.waiting).toBe(1);
  });

  it('a message held in this machine\'s own queue keeps its download: the drain still gives a readable file (media off)', async () => {
    const r = rig({ mediaOn: false });
    const pm = r.make();
    const own = r.download('photo-1-60.jpg', jpeg());
    const local = r.media('60', { capture: 'off', localPath: own });
    // What the queue stores and reads back on THIS machine (the cell keeps the local path)...
    const cell = parseQueuedMediaCell(JSON.parse(JSON.stringify(local)));
    expect(await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: cell })).toBe(`[image:${fs.realpathSync(own)}]`);
    // ...while what goes to another machine never carries it.
    expect(JSON.stringify(toWireMedia(local))).not.toContain(own);
    // A cell naming a path outside the download directories gives no path.
    const bad = parseQueuedMediaCell([{ kind: 'photo', platformMessageId: '61', filename: 'x', capture: 'off', localPath: '/etc/hosts' }]);
    expect(await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: bad })).toBe(STORED_ELSEWHERE_LINE);
  });

  it('an app file whose message has not replicated yet waits (never "unavailable"); its 300 s line names the attachment-id route', async () => {
    const r = rig();
    const pm = r.make();
    const attachmentId = 'c'.repeat(64);
    const text = await pm.buildInboundSessionText({ conversationKey: TKEY, text: '', media: [{ kind: 'photo', attachmentId, filename: 'beach.jpg' }] });
    expect(text).toBe('[file still copying: beach.jpg]');
    expect(r.waiters()[0]!.eventId).toBe(`att:${attachmentId}`);
    r.state.now += MEDIA_EVENT_TELL_AFTER_MS;
    await pm.sweep();
    expect(r.injected[0]!.line).toContain(`attachmentId=${attachmentId}`);
  });
});
