/** Real provider-entry admission with mutable identity, visibility and mute state. */
import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MobilePushPending, TYPED_PUSH_PENDING_FILE } from '../../src/core/MobilePushPending.js';
import { DeviceRegistry } from '../../src/core/MobileDeviceKeys.js';
import { MobilePushService, FOLD_MS, type ApnsAnswer, type FcmAnswer, type PushTrigger } from '../../src/core/MobilePush.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mobile-push-preferences.test.ts' }); });
const pem = (kind: 'ec' | 'rsa') => (kind === 'ec' ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const apnsKey = pem('ec'); const rsaKey = pem('rsa');
const trigger = (id: string, extra: Partial<PushTrigger> = {}): PushTrigger => ({ kind: 'reply', conversationKey: '22222222-2222-4222-8222-222222222222', messageId: id, sourceMachine: 'm', dedupeKey: id, ...extra });
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
function fixture(provider: 'apns' | 'fcm', callbacks = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-preferences-')); dirs.push(dir);
  const state = { reader: 'alice', muted: false, t: 1_000_000, visible: true, receivesNotices: true };
  const registry = new DeviceRegistry(dir, () => state.t);
  const pending = registry.createPending({ deviceName: 'Phone', label: null, publicKey: crypto.randomBytes(65).toString('base64url'), host: 'h' });
  if (!pending.ok) throw new Error('fixture'); const id = pending.device.id; registry.applyConfirm(id, { ok: true });
  registry.setPush(id, { token: provider === 'apns' ? 'a'.repeat(64) : 'fcmTok_' + 'x'.repeat(160), provider, ...(provider === 'apns' ? { environment: 'sandbox' as const } : {}), notifyTokenHash: 'b'.repeat(64), revision: 1 });
  const sent: any[] = []; let oauthCalls = 0;
  const hooks: { admission?: () => Promise<void>; answer?: () => ApnsAnswer & Partial<FcmAnswer>; oauth?: () => Promise<void>; phoneStillCounts?: () => boolean } = {};
  const createService = () => new MobilePushService({ stateDir: dir, registry, agentId: 'echo', agentName: 'Echo', machineId: 'm', enabled: () => true,
    ...(callbacks ? { notificationReader: () => state.reader, canonicalReplyRef: (key: string) => `app:${key}`, mutedFor: () => state.muted } : {}),
    mayNotify: (_id, _key, messageId) => state.visible && messageId !== 'private', receivesNotices: () => state.receivesNotices, mayNotifyDocument: () => true, mayDecideDocument: () => true,
    phoneStillCounts: () => hooks.phoneStillCounts ? hooks.phoneStillCounts() : true,
    now: () => state.t, credentials: () => ({ keyPem: apnsKey, keyId: 'K', teamId: 'T' }),
    fcmKey: () => ({ project_id: 'instar-c1a64', client_email: 'push@instar-c1a64.iam.gserviceaccount.com', private_key: rsaKey }),
    fcmOAuth: async () => { oauthCalls++; await hooks.oauth?.(); return { status: 200, accessToken: `token${oauthCalls}` }; },
    transport: async (_env, _token, _headers, body) => { sent.push(JSON.parse(body)); await hooks.admission?.(); return hooks.answer?.() ?? { status: 200 }; },
    fcmTransport: async (_project, _token, body) => { sent.push(JSON.parse(body)); await hooks.admission?.(); return { tokenFieldViolation: false, ...(hooks.answer?.() ?? { status: 200 }) }; },
  });
  const service = createService();
  const payload = (n: number) => provider === 'apns' ? sent[n].instar : JSON.parse(sent[n].message.data.instar);
  return { service, state, sent, hooks, payload, dir, registry, restart: createService };
}

for (const provider of ['apns', 'fcm'] as const) describe(`${provider} preference admission`, () => {
  it('holds without identity or preference callbacks, and hides global legacy state from team readers', async () => {
    const f = fixture(provider, false); await f.service.receive(trigger('unknown-reader'), false);
    expect(f.sent).toHaveLength(0); expect(f.service.supportsTypedPreferences).toBe(false);
    expect(f.service.preferenceDeliveryStatus('owner')).toEqual({ legacySummaryState: 'pending' });
    expect(f.service.preferenceDeliveryStatus('person:other')).toEqual({ legacySummaryState: 'unknown' });
  });
  it('delivers an authorized team document despite generic notices being disabled and preserves exact decision links', async () => {
    const f = fixture(provider); f.state.receivesNotices = false;
    await f.service.receive(trigger('comment', { kind: 'document', itemId: 'doc', commentKey: 'team:c1', conversationKey: undefined, messageId: undefined }), false);
    expect(f.payload(0)).toMatchObject({ kind: 'document', itemId: 'doc', commentKey: 'team:c1' });
    for (const decide of ['approve', 'decline'] as const) {
      f.state.t += FOLD_MS;
      await f.service.receive(trigger(decide, { kind: 'document', itemId: 'doc', decide, conversationKey: undefined, messageId: undefined }), false);
      expect(f.payload(f.sent.length - 1)).toMatchObject({ kind: 'document', itemId: 'doc', decide });
    }
  });
  it('holds reply and urgent notice evidence across a standing-check exception and restart, then sends when proof recovers', async () => {
    const f = fixture(provider); f.hooks.phoneStillCounts = () => { throw new Error('standing temporarily unreadable'); };
    await f.service.receive(trigger('standing-reply'), false);
    await f.service.receive(trigger('standing-notice', { kind: 'item', itemId: 'ATT-standing', priority: 'URGENT', conversationKey: undefined, messageId: undefined }), false);
    expect(f.sent).toHaveLength(0);
    expect((f.service.status().devices as any[])[0]).toMatchObject({ pending: 2, admission: { lastReason: 'device-standing-unavailable', lastEvidence: { active: true, standingKnown: false, disposition: 'hold' } } });
    const restarted = f.restart(); await restarted.tick(); expect(f.sent).toHaveLength(0); expect((restarted.status().devices as any[])[0].pending).toBe(2);
    f.hooks.phoneStillCounts = () => undefined as unknown as boolean; await restarted.tick(); expect(f.sent).toHaveLength(0);
    f.hooks.phoneStillCounts = () => true; await restarted.tick(); expect(f.sent).toHaveLength(1); expect(f.payload(0)).toMatchObject({ kind: 'aggregate', count: 2 });
    f.hooks.phoneStillCounts = () => false;
    await restarted.receive(trigger('affirmatively-gone'), false); expect((restarted.status().devices as any[])[0]).toMatchObject({ pending: 0, admission: { lastReason: 'device-unavailable', lastEvidence: { active: false, standingKnown: true, disposition: 'discard' } } });
  });
  it('records a bounded permission-distinct notice identity without its reader/device queue key', async () => {
    const f = fixture(provider);
    await f.service.receive(trigger('identity', { kind: 'document', itemId: 'doc', commentKey: 'comment:one', decide: 'decline', conversationKey: undefined, messageId: undefined }), false);
    const evidence = (f.service.status().devices as any[])[0].admission.lastEvidence;
    expect(evidence.canonicalIdentity).toBe(JSON.stringify(['document', 'doc', 'comment:one', 'decline', null, 'm']));
    expect(evidence.canonicalIdentity.length).toBeLessThanOrEqual(512); expect(evidence.canonicalIdentity).not.toContain(f.registry.list()[0]!.id);
    await f.service.receive(trigger('too-long-identity', { kind: 'item', itemId: 'x'.repeat(600), conversationKey: undefined, messageId: undefined }), false);
    expect((f.service.status().devices as any[])[0].admission.lastEvidence.canonicalIdentity).toBeNull();
  });
  it('does not relabel a queued Alice reply when the phone becomes Bob’s, even though both are authorized', async () => {
    const f = fixture(provider); await f.service.receive(trigger('first'), false); await f.service.receive(trigger('held'), false);
    f.state.reader = 'bob'; f.state.t += FOLD_MS; await f.service.tick(); expect(f.sent).toHaveLength(1);
    expect((f.service.status().devices as any[])[0].admission.lastEvidence).toMatchObject({
      intendedReader: 'alice', currentReader: 'bob', canonicalIdentity: 'app:22222222-2222-4222-8222-222222222222',
      messageId: 'held', kind: 'reply', preferencesAvailable: true, muted: false, witnessVerdict: 'readable', rule: 'reader-changed', disposition: 'hold',
    });
    f.state.reader = 'alice'; await f.service.tick(); expect(f.sent).toHaveLength(2); expect(f.payload(1).messageId).toBe('held');
  });
  it('keeps the latest private witness held without retaining urgency from the older public reply', async () => {
    const f = fixture(provider); await f.service.receive(trigger('first'), false);
    await f.service.receive(trigger('public', { priority: 'URGENT' }), false); await f.service.receive(trigger('private'), false);
    f.state.t += FOLD_MS; await f.service.tick(); expect(f.sent).toHaveLength(1);
    await f.service.receive(trigger('notice', { kind: 'item', itemId: 'ATT-1', conversationKey: undefined, messageId: undefined }), false);
    expect(f.sent).toHaveLength(2); expect(f.payload(1).kind).toBe('item'); expect(f.payload(1).count).toBe(1);
    expect((f.service.status().devices as any[])[0].pending).toBe(1);
  });
  it('does not let a private urgent reply carry an ordinary notice past the hourly budget', async () => {
    const f = fixture(provider);
    const cached = (f.service as unknown as { state: { devices: Record<string, unknown> } }).state;
    const id = f.registry.list()[0]!.id;
    cached.devices[id] = { sendLog: Array.from({ length: 40 }, () => f.state.t - 3 * 60_000), urgentLog: [], lastSendAt: f.state.t - 3 * 60_000, pending: null, dueAt: null, backoffUntil: null, lastSend: null };
    await f.service.receive(trigger('private', { priority: 'URGENT' }), false);
    await f.service.receive(trigger('ordinary', { kind: 'item', itemId: 'ATT-normal', conversationKey: undefined, messageId: undefined }), false);
    expect(f.sent).toHaveLength(0); expect((f.service.status().devices as any[])[0].sent24h).toBe(40);
    f.state.t += 60 * 60_000; await f.service.tick();
    expect(f.sent).toHaveLength(1); expect(f.payload(0)).toMatchObject({ kind: 'item', itemId: 'ATT-normal', count: 1 });
    expect((cached.devices[id] as { urgentLog: number[] }).urgentLog).toEqual([]);
  });
  it('persists all muted contribution discards in one sidecar acknowledgement', async () => {
    const f = fixture(provider); await f.service.receive(trigger('first'), false);
    await f.service.receive(trigger('one'), false);
    await f.service.receive(trigger('two', { conversationKey: '33333333-3333-4333-8333-333333333333' }), false);
    const pending = (f.service as unknown as { pending: MobilePushPending }).pending;
    const original = pending.acknowledge.bind(pending); const sizes: number[] = [];
    pending.acknowledge = items => { sizes.push(items.length); original(items); };
    f.state.muted = true; f.state.t += FOLD_MS; await f.service.tick();
    expect(sizes).toEqual([2]); expect(f.sent).toHaveLength(1); expect(pending.forDevice(f.registry.list()[0]!.id)).toEqual([]);
  });
  it('acknowledges only the version sent while a newer reply arrives during the transport await', async () => {
    const f = fixture(provider); const hold = gate(); f.hooks.admission = () => hold.promise;
    const first = f.service.receive(trigger('first'), false);
    for (let i = 0; i < 30 && f.sent.length === 0; i++) await new Promise(r => setTimeout(r, 1));
    expect(f.sent).toHaveLength(1); await f.service.receive(trigger('newer'), false); f.hooks.admission = undefined; hold.release(); await first;
    f.state.t += FOLD_MS; await f.service.tick(); expect(f.sent).toHaveLength(2); expect(f.payload(1).messageId).toBe('newer');
  });
});

describe('credential retry admission', () => {
  it('retains both recipients when main-state receipt persistence fails after the atomic sidecar batch', async () => {
    const f = fixture('apns');
    const second = f.registry.createPending({ deviceName: 'Second phone', label: null, publicKey: crypto.randomBytes(65).toString('base64url'), host: 'h' });
    if (!second.ok) throw new Error('fixture'); f.registry.applyConfirm(second.device.id, { ok: true });
    f.registry.setPush(second.device.id, { token: 'c'.repeat(64), environment: 'sandbox', notifyTokenHash: 'd'.repeat(64), revision: 1 });
    (f.service as unknown as { save: () => void }).save = () => { throw new Error('main receipt write failed'); };
    await expect(f.service.receive(trigger('crash-before-main-receipt'), false)).rejects.toThrow('main receipt write failed');
    expect(f.sent).toHaveLength(0);
    const main = JSON.parse(fs.readFileSync(path.join(f.dir, 'state', 'mobile-push-state.json'), 'utf8'));
    expect(main.dedupe['crash-before-main-receipt']).toBeUndefined();
    const durable = new MobilePushPending(path.join(f.dir, 'state', TYPED_PUSH_PENDING_FILE));
    expect(durable.deviceIds()).toHaveLength(2); expect(durable.status().pending).toBe(2);
    expect(durable.enqueueBatch([], trigger('crash-before-main-receipt'), f.state.t)).toBe('deduped');
  });
  it('rebuilds an APNs JWT retry after a queued reply is muted; an eligible urgent notice remains', async () => {
    const f = fixture('apns'); await f.service.receive(trigger('initial'), false);
    await f.service.receive(trigger('reply'), false);
    await f.service.receive(trigger('notice', { kind: 'item', itemId: 'ATT-1', priority: 'URGENT', conversationKey: undefined, messageId: undefined }), false);
    let attempt = 0;
    f.hooks.answer = () => { if (attempt++ === 0) { f.state.muted = true; return { status: 403, reason: 'ExpiredProviderToken' }; } return { status: 200 }; };
    f.state.t += FOLD_MS; await f.service.tick();
    expect(f.sent).toHaveLength(3); expect(f.payload(1)).toMatchObject({ kind: 'aggregate', count: 2 }); expect(f.payload(2)).toMatchObject({ kind: 'item', itemId: 'ATT-1' });
  });
  it('checks reassignment after OAuth and sends no first request or budget charge', async () => {
    const f = fixture('fcm'); const hold = gate(); f.hooks.oauth = () => hold.promise;
    const work = f.service.receive(trigger('alice'), false); f.state.reader = 'bob'; hold.release(); await work;
    expect(f.sent).toHaveLength(0); expect((f.service.status().devices as any[])[0].sent24h).toBe(0);
  });
  it('rebuilds the FCM retry after its fresh OAuth wait, removing a muted reply from mixed pending notices', async () => {
    const f = fixture('fcm'); await f.service.receive(trigger('initial'), false);
    await f.service.receive(trigger('reply'), false); await f.service.receive(trigger('notice', { kind: 'item', itemId: 'ATT-2', priority: 'URGENT', conversationKey: undefined, messageId: undefined }), false);
    let attempt = 0; f.hooks.answer = () => attempt++ === 0 ? { status: 401 } : { status: 200 };
    f.hooks.oauth = async () => { f.state.muted = true; };
    f.state.t += FOLD_MS; await f.service.tick();
    expect(f.sent).toHaveLength(3); expect(f.payload(1)).toMatchObject({ kind: 'aggregate', count: 2 }); expect(f.payload(2)).toMatchObject({ kind: 'item', itemId: 'ATT-2' });
  });
});
