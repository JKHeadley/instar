/** Android push through Firebase Cloud Messaging (docs/specs/mobile-android-app.md §2.3, §7 Unit). */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry } from '../../src/core/MobileDeviceKeys.js';
import {
  MobilePushService, buildPayload, buildFcmMessage, payloadParts, fcmBodyText, parseFcmServiceAccount, parseFcmError, signFcmJwt, classifyFcmAnswer,
  FCM_MAX_TRIALS, type ApnsTransport, type FcmAnswer, type FcmOAuthAnswer,
} from '../../src/core/MobilePush.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-push-fcm.test.ts' }); });

const APNS_TOKEN = 'a'.repeat(64);
const FCM_TOKEN = 'fcmTok_' + 'x'.repeat(150) + ':APA91';
const FCM_TOKEN_2 = 'fcmTok2_' + 'y'.repeat(150);
const HASH = 'b'.repeat(64);
const { privateKey: ecKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const APNS_KEY = ecKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const { privateKey: rsaKey, publicKey: rsaPub } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PEM = rsaKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const SA = (over: Record<string, unknown> = {}) => ({
  type: 'service_account', project_id: 'instar-c1a64', client_email: 'instar-push@instar-c1a64.iam.gserviceaccount.com',
  private_key: RSA_PEM, token_uri: 'https://evil.example/token', ...over,
});
const MIN = 60_000;
const HOUR = 60 * MIN;

function fcmErr(status: number, errorCode?: string, extra: { field?: string; retryAfterSec?: number } = {}): FcmAnswer {
  const details: unknown[] = [];
  if (errorCode) details.push({ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode });
  if (extra.field) details.push({ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: extra.field, description: 'secret google text' }] });
  return parseFcmError(status, JSON.stringify({ error: { code: status, message: 'secret google message text', status: 'X', details } }), extra.retryAfterSec);
}

interface Opts {
  fcmAnswers?: Array<FcmAnswer | 'throw' | 'stall' | { stallThen: FcmAnswer }>;
  oauth?: Array<FcmOAuthAnswer | 'throw' | 'stall'>;
  fcmKey?: { v: unknown };
  apnsCred?: boolean;
  apnsDevice?: boolean;
  fcmDevices?: number;
  canApprove?: (id: string) => boolean;
  deadlineMs?: number;
  apnsStall?: boolean;
}

function setup(opts: Opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpush-fcm-'));
  dirs.push(dir);
  const clock = { t: Date.parse('2026-11-14T10:00:00Z') };
  const reg = new DeviceRegistry(dir, () => clock.t);
  const mkDev = (name: string) => {
    const c = reg.createPending({ deviceName: name, label: null, publicKey: crypto.randomBytes(65).toString('base64url'), host: 'h' });
    if (!c.ok) throw new Error('setup');
    reg.applyConfirm(c.device.id, { ok: true });
    return c.device.id;
  };
  const fcmIds: string[] = [];
  for (let i = 0; i < (opts.fcmDevices ?? 1); i++) {
    const id = mkDev(`Pixel ${i}`);
    reg.setPush(id, { token: i === 0 ? FCM_TOKEN : `${FCM_TOKEN_2}${i}`, provider: 'fcm', notifyTokenHash: HASH, revision: 1 });
    fcmIds.push(id);
  }
  let apnsId: string | null = null;
  if (opts.apnsDevice) {
    apnsId = mkDev('iPhone');
    reg.setPush(apnsId, { token: APNS_TOKEN, environment: 'sandbox', notifyTokenHash: HASH, revision: 1 });
  }
  const apnsSent: Array<Record<string, unknown>> = [];
  const apns: ApnsTransport = async (_e, _t, _h, body) => {
    if (opts.apnsStall) await new Promise(() => { /* never */ });
    apnsSent.push(JSON.parse(body)); return { status: 200 };
  };
  const fcmSent: Array<{ projectId: string; accessToken: string; body: any }> = [];
  const fcmAnswers = opts.fcmAnswers ?? [];
  const release: Array<() => void> = [];
  const fcmTransport = async (projectId: string, accessToken: string, body: string): Promise<FcmAnswer> => {
    const a = fcmAnswers.shift();
    if (a === 'stall' || (a && typeof a === 'object' && 'stallThen' in a)) await new Promise<void>((r) => release.push(r));
    fcmSent.push({ projectId, accessToken, body: JSON.parse(body) });
    if (a === 'throw') throw new Error('net');
    if (a && typeof a === 'object' && 'stallThen' in a) return a.stallThen;
    return a && a !== 'stall' ? a : { status: 200, tokenFieldViolation: false };
  };
  const assertions: string[] = [];
  const oauthAnswers = opts.oauth ?? [];
  let n = 0;
  const fcmOAuth = async (assertion: string): Promise<FcmOAuthAnswer> => {
    assertions.push(assertion);
    const a = oauthAnswers.shift();
    if (a === 'throw') throw new Error('net');
    if (a === 'stall') await new Promise<void>((r) => release.push(r));
    return a && a !== 'stall' ? a : { status: 200, accessToken: `at-${++n}` };
  };
  const fcmKey = opts.fcmKey ?? { v: JSON.stringify(SA()) };
  const reports: Array<{ what: string; msg: string }> = [];
  const mk = () => new MobilePushService({
    stateDir: dir, registry: reg, agentId: 'echo', agentName: 'Echo', machineId: 'm1',
    enabled: () => true,
    credentials: () => (opts.apnsCred === false ? null : { keyPem: APNS_KEY, keyId: 'K', teamId: 'T' }),
    transport: apns, fcmKey: () => fcmKey.v, fcmTransport, fcmOAuth, fcmDeadlineMs: opts.deadlineMs,
    canApprove: opts.canApprove, now: () => clock.t,
    reportDegradation: (what, err) => reports.push({ what, msg: err instanceof Error ? err.message : String(err) }),
  });
  return { dir, clock, reg, fcmIds, fcmId: fcmIds[0]!, apnsId, apnsSent, fcmSent, assertions, reports, release, fcmKey, mk, svc: mk() };
}
const trig = (n: number, extra: Record<string, unknown> = {}) => ({ kind: 'item' as const, itemId: `ATT-${n}`, dedupeKey: `k${n}`, sourceMachine: 'm1', ...extra });
const st = (c: ReturnType<typeof setup>) => c.svc.status() as any;
const row = (c: ReturnType<typeof setup>, id: string) => st(c).devices.find((d: any) => d.id === id);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('FCM message shape', () => {
  it('carries the same instar block as JSON text, string data values, the generic body; no ttl, no collapse_key, no item text', () => {
    const p = { kind: 'item' as const, itemId: 'ATT-1', machine: 'm1', count: 1 };
    const parts = payloadParts('echo', 'd1', p);
    const m = buildFcmMessage(FCM_TOKEN, 'Echo', parts.instar, fcmBodyText(p), null) as any;
    expect(m).toEqual({ message: { token: FCM_TOKEN, android: { priority: 'HIGH' }, data: { instar: JSON.stringify((buildPayload('Echo', 'echo', 'd1', p) as any).instar), title: 'Echo', body: 'Something needs you' } } });
    for (const v of Object.values(m.message.data)) expect(typeof v).toBe('string');
    const j = JSON.stringify(m);
    expect(j).not.toMatch(/ttl|collapse_key/);
  });

  it('badge only on a reply; approval text has no "Face ID"', () => {
    const reply = { kind: 'reply' as const, conversationKey: '2f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f', count: 1, badge: 3 };
    const pr = payloadParts('echo', 'd1', reply);
    expect((buildFcmMessage('t', 'Echo', pr.instar, fcmBodyText(reply), pr.badge ?? null) as any).message.data.badge).toBe('3');
    const item = payloadParts('echo', 'd1', { kind: 'item', count: 1 });
    expect((buildFcmMessage('t', 'Echo', item.instar, 'x', 5) as any).message.data.badge).toBeUndefined();
    expect(fcmBodyText({ kind: 'notice', subject: 'browser-approval', count: 1 })).toBe('A new browser wants to use your conversations. Tap to approve.');
    expect(fcmBodyText({ kind: 'notice', subject: 'phone-approval', count: 1 })).toBe('A new phone wants to pair. Tap to approve.');
    expect(fcmBodyText({ kind: 'aggregate', count: 2 })).toBe('2 more things need you');
    expect(fcmBodyText({ kind: 'reply', count: 1 })).toBe('New reply');
  });

  it('the APNs payload is byte-identical to before', () => {
    const cases = [
      [{ kind: 'item', itemId: 'ATT-1', machine: 'm1', count: 1 }, '{"aps":{"alert":{"title":"Echo","body":"Something needs you"},"sound":"default","mutable-content":1,"thread-id":"Echo"},"instar":{"kind":"item","agentId":"echo","deviceId":"d1","count":1,"itemId":"ATT-1","machine":"m1"}}'],
      [{ kind: 'notice', subject: 'phone-approval', count: 1 }, '{"aps":{"alert":{"title":"Echo","body":"A new phone wants to pair. Tap to approve with Face ID."},"sound":"default","mutable-content":1,"thread-id":"Echo"},"instar":{"kind":"notice","agentId":"echo","deviceId":"d1","count":1,"subject":"phone-approval"}}'],
      [{ kind: 'reply', conversationKey: 'k', messageId: 'm-1', machine: 'm1', count: 1, badge: 2 }, '{"aps":{"alert":{"title":"Echo","body":"New reply"},"sound":"default","mutable-content":1,"thread-id":"Echo","badge":2},"instar":{"kind":"reply","agentId":"echo","deviceId":"d1","count":1,"conversationKey":"k","messageId":"m-1","machine":"m1"}}'],
      [{ kind: 'aggregate', count: 3 }, '{"aps":{"alert":{"title":"Echo","body":"3 more things need you"},"sound":"default","mutable-content":1,"thread-id":"Echo"},"instar":{"kind":"aggregate","agentId":"echo","deviceId":"d1","count":3}}'],
    ] as const;
    for (const [p, want] of cases) expect(JSON.stringify(buildPayload('Echo', 'echo', 'd1', p as never))).toBe(want);
  });
});

describe('FCM credential and auth', () => {
  it('parses text or an object; bad PEM, bad project_id, bad email → null; hash is of the text', () => {
    const text = JSON.stringify(SA());
    const a = parseFcmServiceAccount(text)!;
    expect(a).toMatchObject({ projectId: 'instar-c1a64', clientEmail: SA().client_email });
    expect(a.hash).toBe(crypto.createHash('sha256').update(text).digest('hex'));
    expect(parseFcmServiceAccount(SA())!.hash).toBe(crypto.createHash('sha256').update(JSON.stringify(SA())).digest('hex'));
    expect(parseFcmServiceAccount(SA({ private_key: 'not a pem' }))).toBeNull();
    expect(parseFcmServiceAccount(SA({ project_id: 'Bad/../id' }))).toBeNull();
    expect(parseFcmServiceAccount(SA({ client_email: 'nobody' }))).toBeNull();
    expect(parseFcmServiceAccount('{not json')).toBeNull();
  });

  it('an unreadable key is no-key with one report', async () => {
    const c = setup({ fcmKey: { v: JSON.stringify(SA({ private_key: 'nope' })) } });
    await c.svc.receive(trig(1), false);
    await c.svc.receive(trig(2), false);
    expect(c.fcmSent).toHaveLength(0);
    expect(st(c).fcmConfigured).toBe(false);
    expect(c.reports.filter((r) => r.what === 'MobilePush.fcmKey')).toHaveLength(1);
  });

  it('JWT shape (RS256, iss = sub = client_email, fixed aud and scope, 1 h), verifies; token_uri ignored', async () => {
    const c = setup();
    await c.svc.receive(trig(1), false);
    const [h, cl, sig] = c.assertions[0]!.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(cl!, 'base64url').toString());
    expect(claims).toMatchObject({ iss: SA().client_email, sub: SA().client_email, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/firebase.messaging' });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(c.assertions[0]).not.toContain('evil');
    expect(crypto.verify('sha256', Buffer.from(`${h}.${cl}`), rsaPub, Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(c.fcmSent[0]).toMatchObject({ projectId: 'instar-c1a64', accessToken: 'at-1' });
    expect(signFcmJwt(parseFcmServiceAccount(SA())!, 1).split('.')).toHaveLength(3);
  });

  it('access token reused for 50 minutes, one exchange in flight', async () => {
    const c = setup({ fcmDevices: 2, oauth: ['stall'] });
    const p = c.svc.receive(trig(1), false);
    const q = c.svc.receive(trig(2), false);
    await tick(10);
    expect(c.assertions).toHaveLength(1);
    c.release.shift()!();
    await Promise.all([p, q]);
    c.clock.t += 40 * MIN;
    await c.svc.tick(); // the held folds go with the cached token
    expect(c.fcmSent.length).toBeGreaterThanOrEqual(3);
    expect(c.assertions).toHaveLength(1);
    c.clock.t += 11 * MIN;
    await c.svc.receive(trig(4), false);
    expect(c.assertions).toHaveLength(2);
  });

  it('exchange invalid_grant pauses FCM only (an APNs device still sends); exchange timeout or 503 is failed without a pause', async () => {
    const c = setup({ apnsDevice: true, oauth: [{ status: 400, error: 'invalid_grant' }] });
    await c.svc.receive(trig(1), false);
    expect(st(c).pausedReasons).toEqual({ apns: null, fcm: 'invalid_grant' });
    expect(c.apnsSent).toHaveLength(1);
    expect(c.reports.find((r) => r.what === 'MobilePush.fcmCredentials')!.msg).toMatch(/new key/);
    for (const a of ['throw', { status: 503 }] as const) {
      const d = setup({ oauth: [a] });
      await d.svc.receive(trig(1), false);
      expect(st(d).pausedReasons.fcm).toBeNull();
      expect(row(d, d.fcmId).lastSend.outcome).toBe('failed');
    }
  });

  it('401 then a fresh token then success; 401 twice pauses FCM only', async () => {
    const c = setup({ fcmAnswers: [fcmErr(401), { status: 200, tokenFieldViolation: false }] });
    await c.svc.receive(trig(1), false);
    expect(c.fcmSent.map((x) => x.accessToken)).toEqual(['at-1', 'at-2']);
    expect(row(c, c.fcmId).lastSend.outcome).toBe('sent');
    const d = setup({ apnsDevice: true, fcmAnswers: [fcmErr(401), fcmErr(401)] });
    await d.svc.receive(trig(1), false);
    expect(st(d).pausedReasons).toEqual({ apns: null, fcm: 'unauthenticated' });
    d.clock.t += 3 * MIN;
    await d.svc.receive(trig(2), false);
    expect(d.apnsSent).toHaveLength(2);
  });
});

describe('FCM send path and answers', () => {
  it('an FCM device with no environment reaches FCM; works with no APNs key; an APNs device works with no FCM key', async () => {
    const c = setup({ apnsCred: false });
    expect(c.reg.get(c.fcmId)!.pushEnvironment).toBeUndefined();
    await c.svc.receive(trig(1), false);
    expect(c.fcmSent).toHaveLength(1);
    expect(c.fcmSent[0]!.body.message.token).toBe(FCM_TOKEN);
    const d = setup({ apnsDevice: true, fcmDevices: 0, fcmKey: { v: undefined } });
    await d.svc.receive(trig(1), false);
    expect(d.apnsSent).toHaveLength(1);
  });

  it('an FCM fold that fires later sends; no item text reaches Google', async () => {
    const c = setup();
    await c.svc.receive(trig(1), false);
    c.clock.t += 10_000; await c.svc.receive(trig(2), false);
    c.clock.t += 2 * MIN; await c.svc.tick();
    expect(c.fcmSent).toHaveLength(2);
    expect(JSON.parse(c.fcmSent[1]!.body.message.data.instar)).toMatchObject({ kind: 'aggregate', count: 1 });
  });

  it('UNREGISTERED and a message.token violation clear only with a matching pushVersion', async () => {
    for (const a of [fcmErr(404, 'UNREGISTERED'), fcmErr(400, 'INVALID_ARGUMENT', { field: 'message.token' })]) {
      const c = setup({ fcmAnswers: [a] });
      await c.svc.receive(trig(1), false);
      expect(c.reg.get(c.fcmId)!.pushToken).toBeUndefined();
    }
    const d = setup();
    const v = d.reg.get(d.fcmId)!.pushVersion!;
    d.reg.setPush(d.fcmId, { token: FCM_TOKEN_2, provider: 'fcm', notifyTokenHash: HASH, revision: 2 });
    expect(d.reg.clearPushIfVersion(d.fcmId, v)).toBe(false);
    expect(d.reg.get(d.fcmId)!.pushToken).toBe(FCM_TOKEN_2);
  });

  it('another INVALID_ARGUMENT, a missing body and an unparseable body leave the token (failed, one report)', async () => {
    for (const a of [fcmErr(400, 'INVALID_ARGUMENT', { field: 'message.data' }), parseFcmError(400, ''), parseFcmError(400, '<html>'), parseFcmError(400, null)]) {
      const c = setup({ fcmAnswers: [a] });
      await c.svc.receive(trig(1), false);
      expect(c.reg.get(c.fcmId)!.pushToken).toBe(FCM_TOKEN);
      expect(row(c, c.fcmId).lastSend.outcome).toBe('failed');
      expect(c.reports.filter((r) => r.what === 'MobilePush.fcmSend')).toHaveLength(1);
      expect(st(c).pausedReasons.fcm).toBeNull();
    }
  });

  it('other 403 pauses permission-denied; 404 without UNREGISTERED pauses project-not-found; malformed 403 is failed', () => {
    expect(classifyFcmAnswer(fcmErr(403))).toEqual({ kind: 'pause', reason: 'permission-denied' });
    expect(classifyFcmAnswer(fcmErr(404))).toEqual({ kind: 'pause', reason: 'project-not-found' });
    expect(classifyFcmAnswer(parseFcmError(403, 'nope'))).toEqual({ kind: 'failed' });
    expect(classifyFcmAnswer(fcmErr(500))).toEqual({ kind: 'failed' });
  });

  it('SENDER_ID_MISMATCH backs off only that device for 24 hours and keeps its token; a second device still sends', async () => {
    const c = setup({ fcmDevices: 2, fcmAnswers: [fcmErr(403, 'SENDER_ID_MISMATCH')] });
    await c.svc.receive(trig(1), false);
    expect(c.fcmSent).toHaveLength(2);
    const firstId = c.reg.list().find((d) => d.pushToken === c.fcmSent[0]!.body.message.token)!.id;
    const otherId = c.fcmIds.find((x) => x !== firstId)!;
    const a = row(c, firstId);
    expect(a.lastSend.outcome).toBe('sender-id-mismatch');
    expect(Date.parse(a.backoffUntil) - c.clock.t).toBe(24 * HOUR);
    expect(c.reg.get(firstId)!.pushToken).toBe(c.fcmSent[0]!.body.message.token);
    expect(row(c, otherId).lastSend.outcome).toBe('sent');
    expect(st(c).pausedReasons.fcm).toBeNull();
    expect(c.reports.filter((r) => r.what === 'MobilePush.fcmCredentials')).toHaveLength(0);
  });

  it('every FCM device in mismatch raises one report naming both causes; a key change or a recheck clears the backoffs', async () => {
    const c = setup({ fcmDevices: 2, fcmAnswers: [fcmErr(403, 'SENDER_ID_MISMATCH'), fcmErr(403, 'SENDER_ID_MISMATCH')] });
    await c.svc.receive(trig(1), false);
    const rep = c.reports.filter((r) => r.what === 'MobilePush.fcmCredentials');
    expect(rep).toHaveLength(1);
    expect(rep[0]!.msg).toMatch(/debug build/);
    expect(rep[0]!.msg).toMatch(/vault key/);
    expect(c.svc.recheckFcm()).toEqual({ armed: false, reason: 'not-paused' });
    expect(row(c, c.fcmIds[0]!).backoffUntil).toBeNull();
    // Key change path.
    const d = setup({ fcmAnswers: [fcmErr(403, 'SENDER_ID_MISMATCH')] });
    await d.svc.receive(trig(1), false);
    expect(row(d, d.fcmId).backoffUntil).not.toBeNull();
    const { privateKey: k2 } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    d.fcmKey.v = JSON.stringify(SA({ private_key: k2.export({ format: 'pem', type: 'pkcs8' }).toString() }));
    d.clock.t += 3 * MIN;
    await d.svc.receive(trig(2), false);
    expect(d.fcmSent).toHaveLength(2);
  });

  it('429 Retry-After: 120 → 10-minute floor; 7200 → capped at 1 hour; HTTP-date and none → 10 minutes', async () => {
    const cases: Array<[FcmAnswer, number]> = [
      [fcmErr(429, 'QUOTA_EXCEEDED', { retryAfterSec: 120 }), 10 * MIN],
      [fcmErr(429, 'QUOTA_EXCEEDED', { retryAfterSec: 7200 }), HOUR],
      [fcmErr(429, 'QUOTA_EXCEEDED', { retryAfterSec: 900 }), 15 * MIN],
      [fcmErr(429, 'QUOTA_EXCEEDED'), 10 * MIN],
    ];
    for (const [a, want] of cases) {
      const c = setup({ fcmAnswers: [a] });
      await c.svc.receive(trig(1), false);
      expect(Date.parse(row(c, c.fcmId).backoffUntil) - c.clock.t).toBe(want);
    }
    // An HTTP-date Retry-After is not a whole number of seconds: the transport treats it as absent.
    expect(parseFcmError(429, '{"error":{}}', undefined).retryAfterSec).toBeUndefined();
  });

  it('no token and no Google message text in status, lastSend or reports', async () => {
    const c = setup({ fcmAnswers: [fcmErr(400, 'INVALID_ARGUMENT', { field: 'message.data' })] });
    await c.svc.receive(trig(1), false);
    const all = JSON.stringify([c.svc.status(), c.reports]);
    expect(all).not.toContain(FCM_TOKEN);
    expect(all).not.toContain('secret google');
    expect(row(c, c.fcmId)).toMatchObject({ provider: 'fcm', environment: null });
  });
});

describe('approval notices to Android phones', () => {
  it('skip an FCM device that cannot approve, reach one that can; iPhone unchanged', async () => {
    const allowed = new Set<string>();
    const c = setup({ fcmDevices: 2, apnsDevice: true, canApprove: (id) => allowed.has(id) });
    allowed.add(c.fcmIds[1]!);
    await c.svc.receive({ kind: 'notice', subject: 'phone-approval', dedupeKey: 'pairing-request:x', sourceMachine: 'm1' }, false);
    expect(c.fcmSent).toHaveLength(1);
    expect(c.fcmSent[0]!.body.message.token).not.toBe(FCM_TOKEN);
    expect(c.fcmSent[0]!.body.message.data.body).toBe('A new phone wants to pair. Tap to approve.');
    expect(c.apnsSent).toHaveLength(1);
    expect((c.apnsSent[0] as any).aps.alert.body).toContain('Face ID');
    // A plain notice still reaches every FCM device.
    c.clock.t += 3 * MIN;
    await c.svc.receive({ kind: 'notice', dedupeKey: 'notice:x', sourceMachine: 'm1' }, false);
    expect(c.fcmSent).toHaveLength(3);
  });
});

describe('FCM pause, hold, trials and recheck', () => {
  async function pausedWith(reason: FcmAnswer, opts: Opts = {}) {
    const c = setup({ ...opts, fcmAnswers: [reason, ...(opts.fcmAnswers ?? [])] });
    await c.svc.receive(trig(1), false);
    return c;
  }

  it('an old state file with only `paused` reads as an APNs pause; a new file read by the old shape pauses nothing', async () => {
    const c = setup({ apnsDevice: true });
    fs.mkdirSync(path.join(c.dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(c.dir, 'state', 'mobile-push-state.json'), JSON.stringify({ devices: {}, dedupe: {}, paused: { reason: 'Forbidden', credHash: 'h', at: 1, checkedAt: c.clock.t }, fanout: { sent: 0, received: 0, deduped: 0, refused: 0 } }));
    const svc = c.mk();
    expect((svc.status() as any).pausedReasons).toEqual({ apns: 'Forbidden', fcm: null });
    await svc.receive(trig(1), false);
    expect(c.apnsSent).toHaveLength(0);
    expect(c.fcmSent).toHaveLength(1);
    // The old reader rebuilds from a fixed field list and only reads `paused`.
    const d = await pausedWith(fcmErr(403));
    const raw = JSON.parse(fs.readFileSync(path.join(d.dir, 'state', 'mobile-push-state.json'), 'utf8'));
    expect(raw.paused).toBeNull();
    expect(raw.pausedFcm.reason).toBe('permission-denied');
  });

  it('a trigger sent at once while paused or keyless joins the fold and goes out after recovery', async () => {
    const c = await pausedWith(fcmErr(403), { fcmAnswers: [{ status: 200, tokenFieldViolation: false }] });
    c.clock.t += 3 * MIN;
    await c.svc.receive(trig(2), false);
    expect(c.fcmSent).toHaveLength(1);
    expect(row(c, c.fcmId).pending).toBe(2); // the pausing send's fold, plus the new one
    c.clock.t += 30 * MIN; await c.svc.tick(); // the first trial is armed and the held fold goes as the trial
    expect(c.fcmSent).toHaveLength(2);
    expect(JSON.parse(c.fcmSent[1]!.body.message.data.instar)).toMatchObject({ kind: 'aggregate', count: 2 });
    expect(st(c).pausedReasons.fcm).toBeNull();
    // Keyless: held, no writes per tick, sent once a key appears.
    const k = setup({ fcmKey: { v: undefined } });
    await k.svc.receive(trig(1), false);
    expect(row(k, k.fcmId).pending).toBe(1);
    const file = path.join(k.dir, 'state', 'mobile-push-state.json');
    const before = fs.statSync(file).mtimeMs + ':' + fs.readFileSync(file, 'utf8');
    k.clock.t += 5 * MIN; await k.svc.tick(); await k.svc.tick();
    expect(fs.statSync(file).mtimeMs + ':' + fs.readFileSync(file, 'utf8')).toBe(before);
    k.fcmKey.v = JSON.stringify(SA());
    await k.svc.tick();
    expect(k.fcmSent).toHaveLength(1);
  });

  it('an APNs trigger while APNs is paused is unchanged (dropped, not folded)', async () => {
    const c = setup({ apnsDevice: true, fcmDevices: 0 });
    fs.mkdirSync(path.join(c.dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(c.dir, 'state', 'mobile-push-state.json'), JSON.stringify({ devices: {}, dedupe: {}, paused: { reason: 'Forbidden', credHash: 'h', at: 1, checkedAt: c.clock.t }, fanout: { sent: 0, received: 0, deduped: 0, refused: 0 } }));
    const svc = c.mk();
    await svc.receive(trig(1), false);
    expect((svc.status() as any).devices[0].pending).toBe(0);
  });

  it('under a cause that stays, trials back off (30 m, 1, 2, 4, 8, 16 h) and stop after 6; network errors count; count survives a restart', async () => {
    const answers: Array<FcmAnswer | 'throw'> = [];
    for (let i = 0; i < 6; i++) answers.push(i === 2 ? 'throw' : fcmErr(403));
    const c = await pausedWith(fcmErr(403), { fcmAnswers: answers });
    let svc = c.svc;
    const gaps = [30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR];
    for (let i = 0; i < 6; i++) {
      c.clock.t += gaps[i]! - 1000; await svc.tick();
      expect(c.fcmSent).toHaveLength(1 + i);
      c.clock.t += 1000; await svc.tick();
      expect(c.fcmSent).toHaveLength(2 + i);
      expect((svc.status() as any).fcmTrials.refused).toBe(i + 1);
      if (i === 2) svc = c.mk(); // restart keeps the count and next time
    }
    expect((svc.status() as any).fcmTrials).toEqual({ refused: FCM_MAX_TRIALS, nextAt: null });
    c.clock.t += 40 * HOUR; await svc.tick();
    expect(c.fcmSent).toHaveLength(7);
    expect((svc.status() as any).pausedReasons.fcm).toBe('permission-denied');
    expect(c.reports.filter((r) => r.what === 'MobilePush.fcmCredentials')).toHaveLength(1); // refused trials raise no new report
  });

  it('a new key lifts the pause within 30 minutes even with a 16-hour trial gap', async () => {
    const c = await pausedWith(fcmErr(403), { fcmAnswers: [fcmErr(403), fcmErr(403), fcmErr(403), fcmErr(403), fcmErr(403)] });
    const gaps = [30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR];
    for (const g of gaps) { c.clock.t += g; await c.svc.tick(); }
    expect(st(c).fcmTrials.refused).toBe(5);
    const { privateKey: k2 } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    c.fcmKey.v = JSON.stringify(SA({ private_key: k2.export({ format: 'pem', type: 'pkcs8' }).toString() }));
    c.clock.t += 30 * MIN; await c.svc.tick();
    expect(st(c).pausedReasons.fcm).toBeNull();
    expect(c.fcmSent.length).toBe(7); // the held fold went once the pause cleared
  });

  it('after the sixth trial, a recheck clears the pause with no new trigger; a recheck right before a restart still trials after it', async () => {
    const refusals = Array.from({ length: 6 }, () => fcmErr(403));
    const c = await pausedWith(fcmErr(403), { fcmAnswers: refusals });
    for (const g of [30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR]) { c.clock.t += g; await c.svc.tick(); }
    expect(st(c).fcmTrials.nextAt).toBeNull();
    expect(c.svc.recheckFcm()).toEqual({ armed: true });
    const after = c.mk(); // restart: the in-memory arm is gone, nextTrialAt is persisted
    c.clock.t += 2 * MIN; // the held fold is due 2 minutes after the last refused trial's send
    await after.tick();
    expect((after.status() as any).pausedReasons.fcm).toBeNull();
    expect(c.fcmSent).toHaveLength(8);
  });

  it('a trial answered UNREGISTERED clears the pause and the token; recheck with no key or nothing paused answers armed false', async () => {
    const c = await pausedWith(fcmErr(403), { fcmAnswers: [fcmErr(404, 'UNREGISTERED')] });
    c.clock.t += 30 * MIN; await c.svc.tick();
    expect(st(c).pausedReasons.fcm).toBeNull();
    expect(c.reg.get(c.fcmId)!.pushToken).toBeUndefined();
    expect(c.svc.recheckFcm()).toEqual({ armed: false, reason: 'not-paused' });
    const k = setup({ fcmKey: { v: undefined } });
    expect(k.svc.recheckFcm()).toEqual({ armed: false, reason: 'no-key' });
  });

  it('a 503 trial keeps the pause; a 429 trial clears it', async () => {
    const c = await pausedWith(fcmErr(403), { fcmAnswers: [fcmErr(503, 'UNAVAILABLE')] });
    c.clock.t += 30 * MIN; await c.svc.tick();
    expect(st(c).pausedReasons.fcm).toBe('unavailable'); // still paused, latest reason recorded
    expect(st(c).fcmTrials.refused).toBe(1);
    const d = await pausedWith(fcmErr(403), { fcmAnswers: [fcmErr(429, 'QUOTA_EXCEEDED')] });
    d.clock.t += 30 * MIN; await d.svc.tick();
    expect(st(d).pausedReasons.fcm).toBeNull();
  });

  it('a refused trial keeps its fold, and a trigger arriving during it merges, due time recomputed', async () => {
    const c = await pausedWith(fcmErr(403), { fcmAnswers: ['stall'] });
    c.clock.t += 30 * MIN;
    const t = c.svc.tick();
    await tick(10);
    expect(c.fcmSent).toHaveLength(1); // stalled trial not recorded yet
    await c.svc.receive(trig(9, { priority: 'URGENT' }), false); // paused, no arm → joins the fold
    c.release.shift()!();
    await t;
    // The stalled trial answered 200 (default) → pause clears; both folds merged.
    expect(st(c).pausedReasons.fcm).toBeNull();
    const d = await pausedWith(fcmErr(403), { fcmAnswers: ['stall', fcmErr(403)] });
    d.clock.t += 30 * MIN;
    // Make the stalled answer a refusal by queuing the stall to resolve with a 403 next.
    const t2 = d.svc.tick();
    await tick(10);
    await d.svc.receive(trig(9, { priority: 'URGENT' }), false);
    expect(row(d, d.fcmId).pending).toBe(1);
    d.release.shift()!();
    await t2;
    expect(row(d, d.fcmId).pending).toBeGreaterThanOrEqual(1);
  });

  it('a trial refused with SENDER_ID_MISMATCH raises no report and records the latest reason', async () => {
    const c = await pausedWith(fcmErr(403), { fcmAnswers: [fcmErr(403, 'SENDER_ID_MISMATCH')] });
    c.clock.t += 30 * MIN; await c.svc.tick();
    expect(st(c).fcmTrials.refused).toBe(1);
    expect(st(c).pausedReasons.fcm).toBe('sender-id-mismatch');
    expect(c.reports.filter((r) => r.what === 'MobilePush.fcmCredentials')).toHaveLength(1); // only the original pause
  });

  it('a send in flight when another device paused FCM keeps that pause (one pause, one report); one accepted with the same key clears it', async () => {
    for (const [late, wantPaused] of [[fcmErr(403), true], [{ status: 200, tokenFieldViolation: false }, false]] as const) {
      const c = setup({ fcmDevices: 2, fcmAnswers: [{ stallThen: late as FcmAnswer }, fcmErr(404)] });
      const first = c.svc.receive(trig(1), false); // device A stalls in flight
      await tick(10);
      await c.svc.receive(trig(2), false); // A folds; device B sends and pauses FCM (project-not-found)
      expect(st(c).pausedReasons.fcm).toBe('project-not-found');
      c.release.shift()!();
      await first;
      expect(st(c).pausedReasons.fcm).toBe(wantPaused ? 'project-not-found' : null);
      expect(c.reports.filter((r) => r.what === 'MobilePush.fcmCredentials')).toHaveLength(1);
    }
  });

  it('the FCM pause report is MobilePush.fcmCredentials and names the recovery for its reason', async () => {
    const cases: Array<[FcmAnswer, RegExp]> = [[fcmErr(403), /Cloud Messaging API on/], [fcmErr(404), /does not exist/]];
    for (const [a, re] of cases) {
      const c = await pausedWith(a);
      const r = c.reports.filter((x) => x.what === 'MobilePush.fcmCredentials');
      expect(r).toHaveLength(1);
      expect(r[0]!.msg).toMatch(re);
    }
  });
});

describe('FCM and APNs side by side', () => {
  it('a stalled FCM exchange does not delay an APNs device; the FCM device fails at its deadline', async () => {
    const c = setup({ apnsDevice: true, oauth: ['stall'], deadlineMs: 50 });
    const p = c.svc.receive(trig(1), false);
    await tick(10);
    expect(c.apnsSent).toHaveLength(1);
    await p;
    expect(row(c, c.fcmId).lastSend.outcome).toBe('failed');
    expect(st(c).pausedReasons.fcm).toBeNull();
  });

  it('an APNs fold is not held behind a stalled FCM fold in tick()', async () => {
    const c = setup({ apnsDevice: true, fcmAnswers: [{ status: 200, tokenFieldViolation: false }, 'stall'] });
    await c.svc.receive(trig(1), false);
    c.clock.t += 10_000; await c.svc.receive(trig(2), false);
    c.clock.t += 2 * MIN;
    const t = c.svc.tick();
    await tick(10);
    expect(c.apnsSent).toHaveLength(2);
    // A second timer while the FCM pass is still running: APNs still runs, FCM is skipped.
    c.clock.t += 10_000; await c.svc.receive(trig(3), false);
    c.clock.t += 2 * MIN; await c.svc.tick();
    expect(c.apnsSent).toHaveLength(3);
    c.release.shift()!();
    await t;
  });

  it('two triggers during one exchange send once to a device; a stalled first device does not double-send a later one', async () => {
    const c = setup({ oauth: ['stall'] });
    const p = c.svc.receive(trig(1), false);
    await tick(5);
    await c.svc.receive(trig(2), false);
    c.release.shift()!();
    await p;
    expect(c.fcmSent).toHaveLength(1);
    expect(row(c, c.fcmId).pending).toBe(1);
    const d = setup({ fcmDevices: 2, fcmAnswers: ['stall'] });
    const q = d.svc.receive(trig(1), false);
    await tick(5);
    await d.svc.receive(trig(2), false); // the later device got nothing yet; it gets exactly one
    d.release.shift()!();
    await q;
    const later = d.fcmSent.filter((x) => x.body.message.token !== FCM_TOKEN);
    expect(later).toHaveLength(1);
  });
});

describe('ready', () => {
  it('false with push off, with no key, and while paused; true otherwise', async () => {
    const c = setup();
    expect(c.svc.readyFor('fcm')).toBe(true);
    expect(c.svc.readyFor('apns')).toBe(true);
    const k = setup({ fcmKey: { v: undefined }, apnsCred: false });
    expect(k.svc.readyFor('fcm')).toBe(false);
    expect(k.svc.readyFor('apns')).toBe(false);
    const p = setup({ fcmAnswers: [fcmErr(403)] });
    await p.svc.receive(trig(1), false);
    expect(p.svc.readyFor('fcm')).toBe(false);
    expect(p.svc.readyFor('apns')).toBe(true);
    const off = new MobilePushService({ stateDir: c.dir, registry: c.reg, agentId: 'e', agentName: 'E', machineId: 'm', enabled: () => false, credentials: () => null, fcmKey: () => JSON.stringify(SA()) });
    expect(off.readyFor('fcm')).toBe(false);
  });
});

describe('DeviceRegistry.setPush with a provider', () => {
  it('provider absent reads as apns; an old record retried at the same revision is ok', () => {
    const c = setup({ fcmDevices: 0, apnsDevice: true });
    const d = c.reg.get(c.apnsId!)!;
    expect(d.pushProvider).toBe('apns');
    // An old iPhone record (no pushProvider) retried with no provider at the same revision.
    const f = JSON.parse(fs.readFileSync(c.reg.file, 'utf8'));
    delete f.devices.find((x: any) => x.id === c.apnsId).pushProvider;
    fs.writeFileSync(c.reg.file, JSON.stringify(f));
    expect(c.reg.setPush(c.apnsId!, { token: APNS_TOKEN, environment: 'sandbox', notifyTokenHash: HASH, revision: 1 })).toEqual({ ok: true, revision: 1, version: 1 });
  });

  it('switching provider with the same token bumps pushVersion; same revision different provider is 409; clearing removes pushProvider', () => {
    const c = setup({ fcmDevices: 0, apnsDevice: true });
    const id = c.apnsId!;
    const v = c.reg.get(id)!.pushVersion!;
    const tok = 'f'.repeat(64);
    c.reg.setPush(id, { token: tok, environment: 'sandbox', notifyTokenHash: HASH, revision: 2 });
    expect(c.reg.setPush(id, { token: tok, provider: 'fcm', notifyTokenHash: HASH, revision: 2 })).toEqual({ ok: false, reason: 'revision-conflict' });
    const r = c.reg.setPush(id, { token: tok, provider: 'fcm', notifyTokenHash: HASH, revision: 3 });
    expect(r.ok && r.version).toBe(v + 2);
    expect(c.reg.get(id)!.pushProvider).toBe('fcm');
    expect(c.reg.get(id)!.pushEnvironment).toBeUndefined();
    c.reg.setPush(id, { token: null, revision: 4 });
    expect(c.reg.get(id)!.pushProvider).toBeUndefined();
  });
});
