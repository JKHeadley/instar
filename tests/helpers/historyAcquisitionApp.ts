import { expect } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from './setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from './mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import type { AcquisitionConnection } from '../../src/import/HistoryAcquisitionWorker.js';
const HOST = 'echo-native-e2e.example.dev';
const requestId = () => Date.now() + '-' + crypto.randomUUID();

export async function historyApp(connection?: AcquisitionConnection, beforeBoot?: (stateDir:string) => Promise<void> | void) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'acquisition-chat-'));
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  // Every agent gets a machine identity at `instar init`; the receipt signer reads it.
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'native-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent:true,
    mobilePairing: { multiRoute: { enabled: false } }, // the single-host path; multi-route has its own e2e
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState:{lastState:'active',activeProvider:'cloudflare-named'},url:'https://' + HOST,on:() => undefined } as any;
  await beforeBoot?.(stateDir);
  const server = new AgentServer({config,sessionManager,state:new StateManager(stateDir),initiativeTracker:new InitiativeTracker(stateDir),
    tunnel,historyAcquisitionConnection:connection});
  const app = server.getApp();
  server.mobilePairing!.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'native-e2e');
  const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
  expect(m.status).toBe(200);
  const dms: string[] = [];
  server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
  server.mobilePairing!.deps.telegramOwnerPresent = () => true; // the Telegram path (no owner ⇒ the dashboard path, §4.4)
  const dev = makeDevice();
  const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
  expect(r.status).toBe(200);
  const deviceId = r.body.deviceId as string;
  const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
  const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const time = String(Date.now());
    const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
    const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
    q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    return raw ? q.send(raw.toString()) : q;
  };
  expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');

  const create = async () => {
    const out = await send('POST','/mobile/conversations',{title:'History import',requestId:requestId()});
    expect(out.status).toBe(200);
    return out.body.conversationKey as string;
  };
  const say = (key:string,text:string,id=requestId()) => send('POST','/mobile/chat/app/'+key,{text,requestId:id});
  const messages = async (key:string) => {
    const out = await send('GET','/mobile/chat/app/'+key+'/messages');
    expect(out.status).toBe(200);
    return out.body.messages as {role:string;text:string;originVerified:string}[];
  };
  const close = async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'tests/helpers/historyAcquisitionApp.ts'});
  };
  return {app,server,stateDir,auth,send,deviceId,create,say,messages,close};
}
