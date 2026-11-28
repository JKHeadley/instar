/** Production-path proof (docs/specs/permanent-agent-links.md): AgentServer wires the phone's
 * identity route (device-signed) and the agent's link builder (Bearer). With `agentLinks.enabled`
 * true, a paired phone gets a proof that verifies over the transcript it can build itself; with the
 * flag false, both routes answer `agent-links-off`. No network call runs. */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type express from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import type { TailscaleExec } from '../../src/core/MobileOwnNames.js';
import { computeCanonicalId } from '../../src/identity/types.js';
import { parseAgentLink, proofTranscript, verifyProof } from '../../src/core/AgentLinks.js';
import { featureEvidence } from '../../src/monitoring/FeatureEvidenceLog.js';

const CF = 'links-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

function boot(agentLinksEnabled: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'links-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  // The agent's identity (as the existing identity paths would have written it).
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const priv = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
  fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({ publicKey: pub.toString('base64'), privateKey: priv.toString('base64'), createdAt: new Date().toISOString() }));
  const config = {
    projectName: 'links-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    agentLinks: { enabled: agentLinksEnabled },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: CF },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${CF}`, on: () => undefined } as any;
  // The stable-origin self-probe and the Tailscale CLI are injected (as in mobile-multi-route-alive):
  // no network call and no real tailscale command runs.
  const tailscaleExec: TailscaleExec = async () => { throw new Error('no tailscale in this test'); };
  let app: express.Express | null = null;
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app!).get(u.pathname + u.search).set('Host', u.hostname);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel,
    mobileRoutes: { tailscaleExec, fetchFn, start: false } });
  app = server.getApp() as express.Express;
  servers.push(server);
  return { server, app: app as express.Express, pub };
}

async function pairPhone(server: AgentServer, app: express.Express) {
  const mp = server.mobilePairing!;
  const m = await request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'links-e2e').send({});
  expect(m.status).toBe(200);
  const dms: string[] = [];
  mp.deps.ownerDM = async (text) => { dms.push(text); return 1; };
  mp.deps.telegramOwnerPresent = () => true;
  const dev = makeDevice();
  const red = await request(app).post('/mobile/pairing-codes/redeem').set('Host', CF).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
  expect(red.status).toBe(200);
  const id = red.body.deviceId as string;
  const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const time = String(Date.now());
    const sig = dev.sign(canonicalString(id, CF, method, p, time, raw));
    const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
    q.set('Host', CF).set('X-Instar-Device', id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    return raw ? q.send(raw.toString()) : q;
  };
  const code = /is (\d{3}) (\d{3})\./.exec(dms[0])!.slice(1).join('');
  expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  return { id, send };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/agent-links-alive.test.ts' });
});

describe('permanent agent links — production wiring', () => {
  it('on: a paired phone gets a proof that verifies; the agent builds links for the same id', async () => {
    const { server, app, pub } = boot(true);
    const phone = await pairPhone(server, app);
    const nonce = crypto.randomBytes(32).toString('base64url');
    const r = await phone.send('GET', `/mobile/agent-link/identity?nonce=${nonce}`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.canonicalId).toBe(computeCanonicalId(pub));
    expect(r.body.publicKey).toBe(pub.toString('base64'));
    // The phone builds the transcript itself: its own device id, the host it signed for, its own nonce.
    const transcript = proofTranscript(r.body.canonicalId, phone.id, CF, nonce);
    expect(verifyProof(pub, transcript, Buffer.from(r.body.proof, 'base64'))).toBe(true);
    // A different host or nonce does not verify (the proof is bound to this request).
    expect(verifyProof(pub, proofTranscript(r.body.canonicalId, phone.id, 'other.example.dev', nonce), Buffer.from(r.body.proof, 'base64'))).toBe(false);

    // Bad nonce → 400; Bearer → 403 (the route is device-signed only).
    expect((await phone.send('GET', '/mobile/agent-link/identity?nonce=short')).status).toBe(400);
    const bearer = await request(app).get(`/mobile/agent-link/identity?nonce=${nonce}`).set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'links-e2e');
    expect(bearer.status).toBe(403);

    // The agent's builder (Bearer) names the same id.
    const built = await request(app).post('/agent-links').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'links-e2e')
      .send({ target: 'conversation', ref: 144473 });
    expect(built.status).toBe(200);
    expect(built.body.url).toBe(`https://instar.sh/a#v=1&i=${computeCanonicalId(pub)}&t=conversation&r=tg:144473`);
    expect(parseAgentLink(built.body.url.split('#')[1])).toMatchObject({ id: computeCanonicalId(pub), target: 'conversation', ref: 'tg:144473' });
    expect(built.body.warning).toBeUndefined();
    const bad = await request(app).post('/agent-links').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'links-e2e').send({ target: 'settings' });
    expect(bad.status).toBe(400);
    // Without the token the builder is refused (Bearer gate).
    expect((await request(app).post('/agent-links').send({ target: 'home' })).status).toBe(401);
  });

  it('off: both routes answer agent-links-off', async () => {
    const { server, app } = boot(false);
    const phone = await pairPhone(server, app);
    const nonce = crypto.randomBytes(32).toString('base64url');
    const r = await phone.send('GET', `/mobile/agent-link/identity?nonce=${nonce}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'agent-links-off' });
    const b = await request(app).post('/agent-links').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'links-e2e').send({ target: 'home' });
    expect(b.status).toBe(404);
    expect(b.body).toEqual({ error: 'agent-links-off' });
  });

  it('records one evidence row per outcome', async () => {
    const { server, app } = boot(true);
    const phone = await pairPhone(server, app);
    const rows: string[] = [];
    const orig = featureEvidence.recordAtMostEvery.bind(featureEvidence);
    featureEvidence.recordAtMostEvery = ((feature: string, key: string, ms: number, input: any) => { if (feature === 'agentLinks') rows.push(key.split('|').slice(0, 2).join('|')); return orig(feature, key, ms, input); }) as typeof featureEvidence.recordAtMostEvery;
    try {
      await phone.send('GET', `/mobile/agent-link/identity?nonce=${crypto.randomBytes(32).toString('base64url')}`);
      await phone.send('GET', '/mobile/agent-link/identity?nonce=bad');
    } finally { featureEvidence.recordAtMostEvery = orig; }
    expect(rows).toEqual(['identity|served', 'identity|bad-nonce']);
  });
});
