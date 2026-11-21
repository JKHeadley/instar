/**
 * identity-security piece 3d through the real device routes on a lone agent: the first approver is lost; a new phone
 * asks; the owner starts from the chat; three notices; 72 h; Finish with a fresh code; the new phone approves. And a
 * recovery stopped by an approval during the wait.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, createMobilePairingRouter, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { presenceEnrollMessage } from '../../src/server/mobileConsoleTicket.js';
import { mayApprove, migrateApprovers, resetApproverStateCacheForTests, verifyApproverPresence } from '../../src/server/mobileApprover.js';
import { resetApproverClaimForTests } from '../../src/server/mobileApproverClaim.js';
import { resetApproverGrantForTests } from '../../src/server/mobileApproverGrant.js';
import { approverRecoveryTap, approverResetCommand, recoveryHooksFor, recoveryTick, resetApproverRecoveryForTests, setRecoveryChat } from '../../src/server/mobileApproverRecovery.js';
import { resetRecoveryCacheForTests } from '../../src/core/approverRecovery.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { wireOwnerRecordStore, resetOwnerRecordWiringForTests, setOwnerRecordRecoveryHooks } from '../../src/core/ownerRecordWiring.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const H = 3600_000;
const dirs: string[] = []; const services: MobilePairingService[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of services.splice(0)) s.stop();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/identity-piece3d-recovery-flow.test.ts' });
  resetOwnerRecordWiringForTests(); resetApproverClaimForTests(); resetApproverGrantForTests(); resetApproverStateCacheForTests(); resetApproverRecoveryForTests(); resetRecoveryCacheForTests(); setRecoveryChat(null);
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-flow-')); dirs.push(dir);
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const dms: Array<{ text: string; buttons?: Array<{ text: string; data: string }> }> = [];
  let msgId = 100;
  const deps = { config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self', telegramOwnerPresent: () => true,
    ownerDM: async (text: string) => { dms.push({ text }); return ++msgId; } } as unknown as MobilePairingDeps;
  const svc = new MobilePairingService(deps); services.push(svc);
  wireOwnerRecordStore(config, new MachineIdentityManager(dir));
  migrateApprovers(svc, { now: Date.now(), earliestPeerMigration: null, allPeersAnswered: false, singleMachine: true });
  setOwnerRecordRecoveryHooks(recoveryHooksFor(svc));
  setRecoveryChat(async (text, buttons) => { dms.push({ text, buttons }); return ++msgId; });
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps));
  const pair = () => { const dev = makeDevice(); const presence = makeDevice(); const c = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST }); if (!c.ok) throw new Error('setup'); svc.devices.applyConfirm(c.device.id, { ok: true }); return { dev, presence, id: c.device.id }; };
  return { app, svc, dms, pair, dir };
}
type Phone = ReturnType<ReturnType<typeof setup>['pair']>;
let tick = 0;
function post(app: express.Express, p: Phone, url: string, body: unknown) {
  const time = String(Date.now() + (tick++ % 1000)); const raw = Buffer.from(JSON.stringify(body));
  return request(app).post(url).set('Content-Type', 'application/json').set('Host', HOST).set('X-Instar-Device', p.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', p.dev.sign(canonicalString(p.id, HOST, 'POST', url, time, raw))).send(raw.toString());
}
const codeIn = (text: string) => /([A-Z]+-\d{4})/.exec(text)![1]!;
async function first(c: ReturnType<typeof setup>, p: Phone) {
  await post(c.app, p, '/mobile/approver/first', { presenceKey: p.presence.publicKey, presenceProof: p.presence.sign(presenceEnrollMessage(p.id, HOST, p.presence.publicKey)) });
  const conf = await post(c.app, p, '/mobile/approver/first/confirm', { code: codeIn(c.dms.at(-1)!.text) });
  expect((await post(c.app, p, '/mobile/approver/first/sign', { entry: conf.body.entry, sig: p.presence.sign(conf.body.sign) })).status).toBe(200);
}
async function askAndStart(c: ReturnType<typeof setup>, b: Phone) {
  const ask = await post(c.app, b, '/mobile/approver/request', { presenceKey: b.presence.publicKey, presenceProof: b.presence.sign(presenceEnrollMessage(b.id, HOST, b.presence.publicKey)) });
  expect(ask.status, JSON.stringify(ask.body)).toBe(200);
  const card = approverResetCommand(c.svc, ask.body.matchCode);
  expect(card.buttons?.map((x) => x.text)).toEqual(['Start', 'Never mind']);
  const started = approverRecoveryTap(c.svc, card.buttons![0]!.data.slice(5), true);
  expect(started.text, started.text).toContain('Started');
}

describe('recovery through the private chat (piece 3d)', () => {
  it('a lost only approver: 72 h, three notices, a fresh code, and the new phone approves', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date()); // start from the real clock: the claim code store reads the real one
    const c = setup();
    const a = c.pair(); await first(c, a);
    const b = c.pair();
    expect(mayApprove(c.svc, b.id)).toBe(false);
    await askAndStart(c, b);
    await recoveryTick(c.svc); // notice 1 went with the start
    const notices = () => c.dms.filter((m) => m.buttons?.[0]?.text === 'Stop it').length;
    expect(notices()).toBe(1);
    expect((await post(c.app, b, '/mobile/approver/recovery/finish', {})).body.error).toBe('not-ready');
    vi.setSystemTime(Date.now() + 36 * H); await recoveryTick(c.svc); expect(notices()).toBe(2);
    vi.setSystemTime(Date.now() + 35 * H); await recoveryTick(c.svc); expect(notices()).toBe(3);
    vi.setSystemTime(Date.now() + 1 * H + 60_000); await recoveryTick(c.svc);
    expect(c.dms.some((m) => m.text.includes('The wait is over'))).toBe(true);
    expect((await post(c.app, b, '/mobile/approver/recovery/finish', {})).status).toBe(200);
    const conf = await post(c.app, b, '/mobile/approver/recovery/finish/confirm', { code: codeIn(c.dms.at(-1)!.text) });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect(conf.body.entry.body.via).toBe('recovered');
    const done = await post(c.app, b, '/mobile/approver/recovery/finish/sign', { entry: conf.body.entry, sig: b.presence.sign(conf.body.sign) });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(mayApprove(c.svc, b.id)).toBe(true); // a lone agent: settled at once
    expect(mayApprove(c.svc, a.id)).toBe(true); // Finish itself takes nothing away
    await recoveryTick(c.svc); // settled noted
    vi.setSystemTime(Date.now() + 16 * 60_000); await recoveryTick(c.svc); // one clean round later
    expect(mayApprove(c.svc, a.id)).toBe(false); // the lost key named at the start is revoked (umbrella §4.5a)
    expect(mayApprove(c.svc, b.id)).toBe(true);
  });

  it('an approval by a living approver during the wait stops it, and nothing is granted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date()); // start from the real clock: the claim code store reads the real one
    const c = setup();
    const a = c.pair(); await first(c, a);
    const b = c.pair();
    await askAndStart(c, b);
    await recoveryTick(c.svc); // the first notice's acceptance is recorded before the clock moves
    vi.setSystemTime(Date.now() + 10 * H);
    expect(verifyApproverPresence(c.svc, a.id, 'x', a.presence.sign('x'))).toBe('ok'); // the old phone approves something
    vi.setSystemTime(Date.now() + 1 * H); await recoveryTick(c.svc);
    // The next tick sees the approval and ends the recovery at once (review M6): the owner is told, nothing is granted.
    expect(c.dms.some((m) => m.text.includes('was stopped') && m.text.includes('approved something'))).toBe(true);
    vi.setSystemTime(Date.now() + 70 * H); await recoveryTick(c.svc);
    const fin = await post(c.app, b, '/mobile/approver/recovery/finish', {});
    expect(fin.body.error).toBe('not-ready');
    expect(mayApprove(c.svc, b.id)).toBe(false);
  });

  it('the bare command explains; a retired key, or no enrolment, refuses', () => {
    const c = setup();
    expect(approverResetCommand(c.svc, '').text).toContain('Ask to approve on this device');
    expect(approverResetCommand(c.svc, '123456').text).toContain('nothing to recover');
  });
});
