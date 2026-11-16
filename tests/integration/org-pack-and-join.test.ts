/**
 * Organization pack end to end on two real AgentServers (docs/specs/org-pack-and-join.md,
 * Acceptance 4–5): an admin agent drafts and publishes (owner-device signed), a second agent joins
 * from the invitation link, its session context carries the rules, a v2 with a changed line is held
 * until accepted, leave + rejoin restores the rules, and the bearer can never publish or join.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString, deviceFingerprint } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { OrgPackUpdater } from '../../src/core/OrgPackUpdater.js';
import { readPublished } from '../../src/server/orgPackRoutes.js';

const HOST = 'org-int.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/org-pack-and-join.test.ts' });
});

const POLICY = `## Purpose\nHelp staff do their work well.\n\n## Never\n- Share donor details outside the organization\n- Spend organization money\n\n## Ask first\n- Sending any message to someone outside the organization\n\n## Normally\n- Write plainly and briefly\n`;

async function boot(name: string) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `org-int-${name}-`));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: `${name} machine` });
  // An owner device (the app), written as an active owner record with the stored host.
  const dev = makeDevice();
  const deviceId = `dev-${name}`;
  fs.writeFileSync(path.join(stateDir, 'state', 'mobile-devices.json'), JSON.stringify({ devices: [{
    id: deviceId, deviceName: 'Mac', label: null, pairedAt: new Date().toISOString(), status: 'active',
    publicKey: dev.publicKey, fingerprint: deviceFingerprint(dev.publicKey), host: HOST, approvedAt: new Date().toISOString(), approvedVia: 'dashboard-pin',
  }] }));
  const config = {
    projectName: name, projectDir: dir, stateDir, port: 0, authToken: `${name}-token`, developmentAgent: true,
    mobilePairing: { enabled: true, multiRoute: { enabled: false }, native: { enabled: true } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
  servers.push(server);
  const app = server.getApp();
  let t = 0;
  const signed = (method: 'POST' | 'GET', p: string, body?: unknown) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    t = Math.max(Date.now(), t + 1);
    const time = String(t);
    const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
    q.set('Host', HOST).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', dev.sign(canonicalString(deviceId, HOST, method, p, time, raw)));
    return raw ? q.send(raw.toString()) : q;
  };
  const bearer = (q: request.Test) => q.set('Authorization', `Bearer ${name}-token`);
  return { app, stateDir, signed, bearer };
}

describe('organization pack across two agents', () => {
  it('publish, invite, join, held update, accept, leave, rejoin', async () => {
    const admin = await boot('admin');
    const member = await boot('member');

    const draft = await admin.bearer(request(admin.app).post('/org/draft')).send({ orgName: 'Monroe Institute', policyMarkdown: POLICY });
    expect(draft.status).toBe(200);
    expect(draft.body.never).toHaveLength(2);
    expect(draft.body.tryList.length).toBeGreaterThan(10);

    // The bearer can never publish (§B2).
    const byBearer = await admin.bearer(request(admin.app).post('/mobile/org/publish')).send({ draftId: draft.body.draftId });
    expect(byBearer.status).toBe(403);

    const pub = await admin.signed('POST', '/mobile/org/publish', { draftId: draft.body.draftId, readBackConfirmed: true, maxIndependence: 'balanced', keepers: ['Justin'], shareUpdates: true });
    expect(pub.status).toBe(200);
    expect(pub.body.code).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);

    const inv = await admin.bearer(request(admin.app).post('/org/invitations')).send({ label: 'Pat' });
    expect(inv.status).toBe(200);
    const bundle = String(inv.body.link).split('#p=')[1]!;

    expect((await member.bearer(request(member.app).post('/mobile/org/join')).send({ bundle })).status).toBe(403);
    const join = await member.signed('POST', '/mobile/org/join', { bundle });
    expect(join.status).toBe(200);
    expect(join.body.applied).toBe('joined');
    const ctx = await member.bearer(request(member.app).get('/intent/org/session-context'));
    expect(JSON.stringify(ctx.body)).toContain('Never: Share donor details outside the organization');
    expect(JSON.stringify(ctx.body)).toContain('ASK YOUR PERSON FIRST');

    // v2 changes a line: the update check holds it until the person accepts it in the app.
    const draft2 = await admin.bearer(request(admin.app).post('/org/draft')).send({ orgName: 'Monroe Institute', policyMarkdown: POLICY.replace('Write plainly and briefly', 'Write plainly') });
    expect((await admin.signed('POST', '/mobile/org/publish', { draftId: draft2.body.draftId, readBackConfirmed: true, maxIndependence: 'balanced', shareUpdates: true })).status).toBe(200);
    const v2 = readPublished(admin.stateDir)!.bundle;
    const updater = new OrgPackUpdater({
      stateDir: member.stateDir, machineId: 'm', isLeaseHolder: () => true, effects: () => ({}), notify: () => {},
      lookup: async () => ['203.0.113.10'],
      fetchFn: (async () => new Response(JSON.stringify(v2))) as unknown as typeof fetch,
    });
    // The joined record has no update origin (no stable origin in the test), so point it at one.
    const memFile = path.join(member.stateDir, 'org', 'membership.json');
    fs.writeFileSync(memFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(memFile, 'utf-8')), updateOrigin: 'https://admin.example.dev' }));
    expect(await updater.tick(true)).toBe('held');
    const status = await member.bearer(request(member.app).get('/org/status'));
    expect(status.body.held).toEqual([2]);
    const accept = await member.signed('POST', '/mobile/org/update-accept', { version: 2 });
    expect(accept.status).toBe(200);
    expect(accept.body.applied).toBe('updated');

    // Leave, then rejoin at the same version.
    expect((await member.signed('POST', '/mobile/org/leave', {})).status).toBe(200);
    expect(fs.existsSync(path.join(member.stateDir, 'ORG-INTENT.md'))).toBe(false);
    const inv2 = await admin.bearer(request(admin.app).post('/org/invitations')).send({});
    const rejoin = await member.signed('POST', '/mobile/org/join', { bundle: String(inv2.body.link).split('#p=')[1] });
    expect(rejoin.body.applied).toBe('joined');
    // The first invitation (v1) can no longer roll it back.
    const old = await member.signed('POST', '/mobile/org/join', { bundle });
    expect(old.status).toBe(409);
    expect(old.body.error).toBe('older-version');
  });

  it('the public pack answers only when shareUpdates is on', async () => {
    const admin = await boot('pub');
    expect((await request(admin.app).get('/org/pack/current')).status).toBe(404);
    const d = await admin.bearer(request(admin.app).post('/org/draft')).send({ orgName: 'X', policyMarkdown: POLICY });
    await admin.signed('POST', '/mobile/org/publish', { draftId: d.body.draftId, readBackConfirmed: true, shareUpdates: false });
    expect((await request(admin.app).get('/org/pack/current')).status).toBe(404);
    const d2 = await admin.bearer(request(admin.app).post('/org/draft')).send({ orgName: 'X', policyMarkdown: POLICY });
    await admin.signed('POST', '/mobile/org/publish', { draftId: d2.body.draftId, readBackConfirmed: true, shareUpdates: true });
    const pub = await request(admin.app).get('/org/pack/current');
    expect(pub.status).toBe(200);
    expect(pub.body.record.version).toBe(2);
  });
});
