/** Mobile push (docs/specs/mobile-push.md): schedule, payload, APNs answers, registration. */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry } from '../../src/core/MobileDeviceKeys.js';
import { MobilePushService, buildPayload, signApnsJwt, type ApnsAnswer, type ApnsTransport } from '../../src/core/MobilePush.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-push.test.ts' }); });
const TOKEN = 'a'.repeat(64);
const HASH = 'b'.repeat(64);
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

function setup(opts: { answers?: ApnsAnswer[]; enabled?: { on: boolean }; cred?: { teamId: string } | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpush-'));
  dirs.push(dir);
  const clock = { t: Date.parse('2026-11-01T10:00:00Z') };
  const reg = new DeviceRegistry(dir, () => clock.t);
  const created = reg.createPending({ deviceName: 'iPhone', label: null, publicKey: crypto.randomBytes(65).toString('base64url'), host: 'h' });
  if (!created.ok) throw new Error('setup');
  reg.applyConfirm(created.device.id, { ok: true });
  reg.setPush(created.device.id, { token: TOKEN, environment: 'sandbox', notifyTokenHash: HASH, revision: 1 });
  const sent: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const answers = opts.answers ?? [];
  const transport: ApnsTransport = async (_env, _tok, headers, body) => { sent.push({ headers, body: JSON.parse(body) }); return answers.shift() ?? { status: 200 }; };
  const enabled = opts.enabled ?? { on: true };
  const cred = opts.cred === undefined ? { teamId: 'AG9AE2H87X' } : opts.cred;
  const mk = () => new MobilePushService({
    stateDir: dir, registry: reg, agentId: 'echo', agentName: 'Echo', machineId: 'm1',
    enabled: () => enabled.on, credentials: () => (cred ? { keyPem: KEY, keyId: 'KEY1', teamId: cred.teamId } : null),
    transport, now: () => clock.t,
  });
  return { dir, clock, reg, id: created.device.id, sent, mk, svc: mk(), enabled, cred };
}
const trig = (n: number, extra: Record<string, unknown> = {}) => ({ kind: 'item' as const, itemId: `ATT-${n}`, dedupeKey: `k${n}`, sourceMachine: 'm1', ...extra });

describe('MobilePushService', () => {
  it('payload carries no item text; aggregate has no itemId', () => {
    const one = buildPayload('Echo', 'echo', 'd1', { kind: 'item', itemId: 'ATT-1', machine: 'm1', count: 1 }) as any;
    expect(one.aps.alert).toEqual({ title: 'Echo', body: 'Something needs you' });
    expect(one.aps['mutable-content']).toBe(1);
    expect(one.instar).toMatchObject({ kind: 'item', itemId: 'ATT-1', machine: 'm1', agentId: 'echo', deviceId: 'd1' });
    const agg = buildPayload('Echo', 'echo', 'd1', { kind: 'aggregate', itemId: 'ATT-1', count: 2 }) as any;
    expect(agg.instar.itemId).toBeUndefined();
    expect(agg.aps.alert.body).toBe('2 more things need you');
  });

  it('a pairing notice says what is waiting and tells the app to open the approval; no device name ever', () => {
    // Operator 2026-11-09: "the description detail and the notifications is terrible".
    const b = buildPayload('Echo', 'echo', 'd1', { kind: 'notice', subject: 'browser-approval', count: 1 }) as any;
    expect(b.aps.alert).toEqual({ title: 'Echo', body: 'A new browser wants to use your conversations. Tap to approve with Face ID.' });
    expect(b.instar).toMatchObject({ kind: 'notice', subject: 'browser-approval' });
    const p = buildPayload('Echo', 'echo', 'd1', { kind: 'notice', subject: 'phone-approval', count: 1 }) as any;
    expect(p.aps.alert.body).toBe('A new phone wants to pair. Tap to approve with Face ID.');
    const plain = buildPayload('Echo', 'echo', 'd1', { kind: 'notice', count: 1 }) as any;
    expect(plain.aps.alert.body).toBe('Something needs you');
    expect(plain.instar.subject).toBeUndefined();
    const bogus = buildPayload('Echo', 'echo', 'd1', { kind: 'notice', subject: 'x' as never, count: 1 }) as any;
    expect(bogus.aps.alert.body).toBe('Something needs you');
  });

  it('JWT is ES256 with kid and iss, and verifies', () => {
    const jwt = signApnsJwt({ keyPem: KEY, keyId: 'KEY1', teamId: 'TEAM' }, 1000);
    const [h, c, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY1' });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({ iss: 'TEAM', iat: 1000 });
    expect(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: crypto.createPublicKey(KEY), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true);
  });

  it('fold timeline: 10:00:00, 10:00:30, 10:01:10 → one now, one aggregate of 2 at 10:02:00', async () => {
    const c = setup();
    await c.svc.receive(trig(1), false);
    c.clock.t += 30_000; await c.svc.receive(trig(2), false);
    c.clock.t += 40_000; await c.svc.receive(trig(3), false);
    expect(c.sent).toHaveLength(1);
    c.clock.t += 49_000; await c.svc.tick();
    expect(c.sent).toHaveLength(1);
    c.clock.t += 1_000; await c.svc.tick();
    expect(c.sent).toHaveLength(2);
    expect((c.sent[1]!.body as any).instar).toMatchObject({ kind: 'aggregate', count: 2 });
  });

  it('duplicate dedupeKey within 10 minutes notifies once', async () => {
    const c = setup();
    await c.svc.receive(trig(1), false);
    expect(await c.svc.receive({ ...trig(9), dedupeKey: 'k1' }, true)).toBe('deduped');
    c.clock.t += 5 * 60_000; await c.svc.tick();
    expect(c.sent).toHaveLength(1);
  });

  it('after 40 sends in 24 h the device is throttled to hourly; URGENT goes at the 2-minute mark', async () => {
    const c = setup();
    for (let i = 0; i < 40; i++) { await c.svc.receive(trig(i), false); c.clock.t += 3 * 60_000; }
    expect(c.sent).toHaveLength(40);
    await c.svc.receive(trig(100), false); // throttled: waits for the hour
    c.clock.t += 5 * 60_000; await c.svc.tick();
    expect(c.sent).toHaveLength(40);
    await c.svc.receive(trig(101, { priority: 'URGENT' }), false); // lowers due time to the fold
    await c.svc.tick();
    expect(c.sent).toHaveLength(41);
    expect((c.sent[40]!.body as any).instar).toMatchObject({ kind: 'aggregate', count: 2 });
    expect((c.svc.status() as any).devices[0]).toMatchObject({ throttled: true });
  });

  it('restart keeps the window, counts and pending fold', async () => {
    const c = setup();
    await c.svc.receive(trig(1), false);
    c.clock.t += 10_000; await c.svc.receive(trig(2), false);
    const after = c.mk();
    c.clock.t += 60_000; await after.tick();
    expect(c.sent).toHaveLength(1);
    c.clock.t += 60_000; await after.tick();
    expect(c.sent).toHaveLength(2);
    expect((after.status() as any).devices[0].sent24h).toBe(2);
  });

  it('410 clears the token; an old-version answer does not clear a newer token', async () => {
    const c = setup({ answers: [{ status: 410, reason: 'Unregistered' }] });
    await c.svc.receive(trig(1), false);
    expect(c.reg.get(c.id)!.pushToken).toBeUndefined();
    const d = setup();
    const v = d.reg.get(d.id)!.pushVersion!;
    d.reg.setPush(d.id, { token: 'c'.repeat(64), environment: 'sandbox', notifyTokenHash: HASH, revision: 2 });
    expect(d.reg.clearPushIfVersion(d.id, v)).toBe(false);
    expect(d.reg.get(d.id)!.pushToken).toBe('c'.repeat(64));
  });

  it('DeviceTokenNotForTopic and BadDeviceToken clear the token', async () => {
    for (const reason of ['DeviceTokenNotForTopic', 'BadDeviceToken']) {
      const c = setup({ answers: [{ status: 400, reason }] });
      await c.svc.receive(trig(1), false);
      expect(c.reg.get(c.id)!.pushToken).toBeUndefined();
    }
  });

  it('expired provider token: one fresh JWT retry; refused twice pauses; a team id change clears the pause', async () => {
    const c = setup({ answers: [{ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 }] });
    await c.svc.receive(trig(1), false);
    expect(c.sent).toHaveLength(2);
    expect((c.svc.status() as any).pausedReason).toBeNull();
    const d = setup({ answers: [{ status: 403, reason: 'InvalidProviderToken' }, { status: 403, reason: 'InvalidProviderToken' }] });
    await d.svc.receive(trig(1), false);
    expect((d.svc.status() as any).pausedReason).toBe('InvalidProviderToken');
    d.cred!.teamId = 'NEWTEAM';
    d.clock.t += 31 * 60_000; await d.svc.tick();
    expect((d.svc.status() as any).pausedReason).toBeNull();
  });

  it('429 sets a backoff that holds URGENT too and survives a restart', async () => {
    const c = setup({ answers: [{ status: 429 }] });
    await c.svc.receive(trig(1), false);
    c.clock.t += 3 * 60_000;
    const after = c.mk();
    await after.receive(trig(2, { priority: 'URGENT' }), false);
    await after.tick();
    expect(c.sent).toHaveLength(1);
    c.clock.t += 8 * 60_000; await after.tick();
    expect(c.sent).toHaveLength(2);
  });

  it('a fold that fires after revoke or gate-off sends nothing', async () => {
    const c = setup();
    await c.svc.receive(trig(1), false);
    c.clock.t += 10_000; await c.svc.receive(trig(2), false);
    c.reg.revoke(c.id);
    c.clock.t += 3 * 60_000; await c.svc.tick();
    expect(c.sent).toHaveLength(1);
    const d = setup();
    await d.svc.receive(trig(1), false);
    d.clock.t += 10_000; await d.svc.receive(trig(2), false);
    d.enabled.on = false;
    d.clock.t += 3 * 60_000; await d.svc.tick();
    expect(d.sent).toHaveLength(1);
  });

  it('no key: nothing is sent and the status says keyConfigured false', async () => {
    const c = setup({ cred: null });
    await c.svc.receive(trig(1), false);
    expect(c.sent).toHaveLength(0);
    expect((c.svc.status() as any).keyConfigured).toBe(false);
  });

  it('an unreadable state file sends nothing', async () => {
    const c = setup();
    fs.mkdirSync(path.join(c.dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(c.dir, 'state', 'mobile-push-state.json'), '{not json');
    const svc = c.mk();
    await svc.receive(trig(1), false);
    expect(c.sent).toHaveLength(0);
  });
});

describe('DeviceRegistry.setPush', () => {
  it('older revision refused, same revision same body accepted, same revision other body refused; token held by one record', () => {
    const c = setup();
    expect(c.reg.setPush(c.id, { token: TOKEN, environment: 'sandbox', notifyTokenHash: HASH, revision: 1 }).ok).toBe(true);
    expect(c.reg.setPush(c.id, { token: null, revision: 1 })).toEqual({ ok: false, reason: 'revision-conflict' });
    expect(c.reg.setPush(c.id, { token: null, revision: 3 }).ok).toBe(true);
    expect(c.reg.setPush(c.id, { token: TOKEN, environment: 'sandbox', notifyTokenHash: HASH, revision: 2 })).toEqual({ ok: false, reason: 'stale-revision' });
    const other = c.reg.createPending({ deviceName: 'iPad', label: null, publicKey: crypto.randomBytes(65).toString('base64url'), host: 'h' });
    if (!other.ok) throw new Error('x');
    c.reg.applyConfirm(other.device.id, { ok: true });
    c.reg.setPush(c.id, { token: TOKEN, environment: 'sandbox', notifyTokenHash: HASH, revision: 4 });
    c.reg.setPush(other.device.id, { token: TOKEN, environment: 'sandbox', notifyTokenHash: HASH, revision: 1 });
    expect(c.reg.get(c.id)!.pushToken).toBeUndefined();
    expect(c.reg.get(other.device.id)!.pushToken).toBe(TOKEN);
  });

  it('revoke clears the push token', () => {
    const c = setup();
    c.reg.revoke(c.id);
    expect(c.reg.get(c.id)!.pushToken).toBeUndefined();
  });
});

// Push without Telegram (mobile-native-conversations §4.7): an agent reply in an app conversation.
describe('MobilePushService — app conversation replies', () => {
  const KEY_A = '2f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';

  it('reply payload names the conversation and says "New reply", never the reply text', () => {
    const p = buildPayload('Echo', 'echo', 'd1', { kind: 'reply', conversationKey: KEY_A, machine: 'm1', count: 1 }) as any;
    expect(p.aps.alert).toEqual({ title: 'Echo', body: 'New reply' });
    expect(p.instar).toEqual({ kind: 'reply', agentId: 'echo', deviceId: 'd1', count: 1, conversationKey: KEY_A });
  });

  it('people and roles: a reply push skips a phone that may not use the conversation (no buzz, no fold, no id)', async () => {
    const c = setup();
    const asked: Array<[string, string]> = [];
    const mk = (allow: boolean) => new MobilePushService({
      stateDir: c.dir, registry: c.reg, agentId: 'echo', agentName: 'Echo', machineId: 'm1',
      enabled: () => true, credentials: () => ({ keyPem: KEY, keyId: 'KEY1', teamId: 'T' }),
      transport: async (_e, _t, headers, body) => { c.sent.push({ headers, body: JSON.parse(body) }); return { status: 200 }; },
      now: () => c.clock.t, mayNotify: (d, k) => { asked.push([d, k]); return allow; },
    });
    await mk(false).receive({ kind: 'reply', conversationKey: KEY_A, messageId: 'm-x', dedupeKey: 'app-reply:m-x', sourceMachine: 'm1' }, false);
    expect(c.sent).toHaveLength(0);
    expect(asked.map((x) => x[1])).toEqual([KEY_A]);
    // An attention item is shared: the check is never asked for it.
    await mk(false).receive({ kind: 'item', itemId: 'ATT-1', dedupeKey: 'item:ATT-1', sourceMachine: 'm1' }, false);
    expect(c.sent).toHaveLength(1);
    expect(asked).toHaveLength(1);
  });

  it('team access: an attention notice skips a phone that does not receive notices, and a reply still reaches it', async () => {
    const c = setup();
    const mk = (receives: boolean) => new MobilePushService({
      stateDir: c.dir, registry: c.reg, agentId: 'echo', agentName: 'Echo', machineId: 'm1',
      enabled: () => true, credentials: () => ({ keyPem: KEY, keyId: 'KEY1', teamId: 'T' }),
      transport: async (_e, _t, headers, body) => { c.sent.push({ headers, body: JSON.parse(body) }); return { status: 200 }; },
      now: () => c.clock.t, mayNotify: () => true, receivesNotices: () => receives,
    });
    await mk(false).receive({ kind: 'item', itemId: 'ATT-9', dedupeKey: 'item:ATT-9', sourceMachine: 'm1' }, false);
    expect(c.sent).toHaveLength(0);
    await mk(false).receive({ kind: 'reply', conversationKey: KEY_A, messageId: 'm-y', dedupeKey: 'app-reply:m-y', sourceMachine: 'm1' }, false);
    expect(c.sent).toHaveLength(1);
    c.clock.t += 3_600_000;
    await mk(true).receive({ kind: 'item', itemId: 'ATT-10', dedupeKey: 'item:ATT-10', sourceMachine: 'm1' }, false);
    expect(c.sent).toHaveLength(2);
  });

  it('team access: a held aggregate is dropped for a phone whose person has gone, and sent otherwise', async () => {
    const c = setup();
    const mk = (counts: boolean) => new MobilePushService({
      stateDir: c.dir, registry: c.reg, agentId: 'echo', agentName: 'Echo', machineId: 'm1',
      enabled: () => true, credentials: () => ({ keyPem: KEY, keyId: 'KEY1', teamId: 'T' }),
      transport: async (_e, _t, headers, body) => { c.sent.push({ headers, body: JSON.parse(body) }); return { status: 200 }; },
      now: () => c.clock.t, phoneStillCounts: () => counts,
    });
    const hold = async (svc: MobilePushService, n: number) => {
      await svc.receive(trig(n), false);
      await svc.receive(trig(n + 1), false);
      c.clock.t += 3_600_000;
    };
    const gone = mk(false);
    await hold(gone, 20);
    const before = c.sent.length;
    await gone.tick();
    expect(c.sent.length).toBe(before);
    const here = mk(true);
    await hold(here, 30);
    const mid = c.sent.length;
    await here.tick();
    expect(c.sent.length).toBeGreaterThan(mid);
  });

  it('onAppReply sends one push per reply, fans out, and a repeat of the same message is deduped', async () => {
    const c = setup();
    const fanned: unknown[] = [];
    const svc = new MobilePushService({
      stateDir: c.dir, registry: c.reg, agentId: 'echo', agentName: 'Echo', machineId: 'm1',
      enabled: () => true, credentials: () => ({ keyPem: KEY, keyId: 'KEY1', teamId: 'T' }),
      transport: async (_e, _t, headers, body) => { c.sent.push({ headers, body: JSON.parse(body) }); return { status: 200 }; },
      fanOut: (t) => fanned.push(t), now: () => c.clock.t,
    });
    svc.onAppReply(KEY_A, 'msg-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(c.sent).toHaveLength(1);
    // The message id lets the phone fetch the preview from the agent (chat-media §4.11); the text never goes to Apple.
    expect((c.sent[0]!.body as any).instar).toMatchObject({ kind: 'reply', conversationKey: KEY_A, messageId: 'msg-1', machine: 'm1' });
    expect((c.sent[0]!.body as any).aps.alert.body).toBe('New reply');
    expect(fanned).toEqual([{ kind: 'reply', conversationKey: KEY_A, messageId: 'msg-1', dedupeKey: 'app-reply:msg-1', sourceMachine: 'm1' }]);
    // The same reply's trigger arriving again (a peer echo) is deduped; a new reply folds.
    expect(await svc.receive({ kind: 'reply', conversationKey: KEY_A, dedupeKey: 'app-reply:msg-1', sourceMachine: 'm2' }, true)).toBe('deduped');
    c.clock.t += 10_000;
    svc.onAppReply(KEY_A, 'msg-2');
    await new Promise((r) => setTimeout(r, 20));
    expect(c.sent).toHaveLength(1); // inside the 2-minute fold
    c.clock.t += 2 * 60_000; await svc.tick();
    expect(c.sent).toHaveLength(2);
    expect((c.sent[1]!.body as any).instar).toMatchObject({ kind: 'aggregate', count: 1 });
  });

  it('push turned off: a reply sends nothing', async () => {
    const c = setup({ enabled: { on: false } });
    c.svc.onAppReply(KEY_A, 'msg-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(c.sent).toHaveLength(0);
  });
});

describe('MobilePushService — document answers (instar-document-viewer, app contract 6)', () => {
  const DOC = '99999999-9999-4999-8999-999999999999';
  it('the payload names the document and comment with fixed words, never the title or answer', () => {
    const p = buildPayload('Echo', 'echo', 'd1', { kind: 'document', itemId: DOC, commentKey: 'mara:c1', machine: 'm1', count: 1 }) as any;
    expect(p.aps.alert.body).toBe('New answers to your comments');
    expect(p.instar).toEqual({ kind: 'document', agentId: 'echo', deviceId: 'd1', count: 1, itemId: DOC, commentKey: 'mara:c1', machine: 'm1' });
  });
  it('goes only to phones the document check allows, and to none when the check is missing', async () => {
    const c = setup();
    const mk = (may?: (d: string, doc: string, key: string) => boolean) => new MobilePushService({
      stateDir: c.dir, registry: c.reg, agentId: 'echo', agentName: 'Echo', machineId: 'm1',
      enabled: () => true, credentials: () => ({ keyPem: KEY, keyId: 'KEY1', teamId: 'T' }),
      transport: async (_e, _t, headers, body) => { c.sent.push({ headers, body: JSON.parse(body) }); return { status: 200 }; },
      now: () => c.clock.t, mayNotifyDocument: may,
    });
    await mk().receive({ kind: 'document', itemId: DOC, commentKey: 'owner:c1', dedupeKey: 'd1', sourceMachine: 'm1' }, false);
    await mk(() => false).receive({ kind: 'document', itemId: DOC, commentKey: 'owner:c1', dedupeKey: 'd2', sourceMachine: 'm1' }, false);
    expect(c.sent).toHaveLength(0);
    const asked: string[] = [];
    await mk((_d, doc, key) => { asked.push(`${doc}|${key}`); return true; }).receive({ kind: 'document', itemId: DOC, commentKey: 'owner:c1', dedupeKey: 'd3', sourceMachine: 'm1' }, false);
    expect(asked).toEqual([`${DOC}|owner:c1`]);
    expect(c.sent).toHaveLength(1);
    expect((c.sent[0].body as any).instar.commentKey).toBe('owner:c1');
  });
});
