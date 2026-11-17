/**
 * Work agents page, departure and a second policy keeper on real AgentServers
 * (docs/specs/org-members-and-keepers.md, Acceptance 4): the admin publishes with updates on; the
 * member joins with the link's token and checks in; the page lists it; a keeper's proposal is
 * countersigned and served; a removal reaches the member as a notice, a restore clears it, a second
 * removal is a new notice; the bearer can never act on members or keepers.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Application } from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString, deviceFingerprint } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { OrgMemberSide } from '../../src/core/OrgMemberSide.js';
import { encodeKeeperCode } from '../../src/core/OrgKeepers.js';
import { newMemberKeyPair, signPayload } from '../../src/core/OrgMembers.js';
import { readPublished } from '../../src/server/orgPackRoutes.js';
import { validateBundle } from '../../src/core/OrgPack.js';

const HOST = 'org-mk.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/org-members-and-keepers.test.ts' });
});

const POLICY = '## Never\n- Share donor details outside the organization\n';

async function boot(name: string) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `org-mk-${name}-`));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: `${name} machine` });
  const dev = makeDevice();
  const deviceId = `device-${name}`;
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

/** A fetch that delivers the member's outgoing calls to the admin's server (the network stand-in). */
function fetchTo(app: Application): typeof fetch {
  return (async (url: URL | string, init?: { method?: string; body?: string }) => {
    const u = new URL(String(url));
    const r = init?.method === 'POST'
      ? await request(app).post(u.pathname).set('Content-Type', 'application/json').send(init.body ?? '')
      : await request(app).get(u.pathname);
    return { status: r.status, ok: r.status < 300, text: async () => r.text } as unknown as Response;
  }) as typeof fetch;
}

describe('work agents, departure and keepers', () => {
  it('check-in, the page, a keeper version, removal and restore', async () => {
    const admin = await boot('admin');
    const member = await boot('member');
    const net = { fetchFn: fetchTo(admin.app), lookup: async () => ['93.184.216.34'] };
    const ORIGIN = 'https://admin.example.dev';

    const draft = await admin.bearer(request(admin.app).post('/org/draft')).send({ orgName: 'Monroe Institute', policyMarkdown: POLICY });
    expect((await admin.signed('POST', '/mobile/org/publish', { draftId: draft.body.draftId, readBackConfirmed: true, shareUpdates: true })).status).toBe(200);
    const orgId = readPublished(admin.stateDir)!.bundle.record.orgId;
    const inv = await admin.bearer(request(admin.app).post('/org/invitations')).send({});
    const [, frag] = String(inv.body.link).split('#');
    const params = new URLSearchParams(frag);
    expect(params.get('t')).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    // The member joins with the token and checks in.
    expect((await member.signed('POST', '/mobile/org/join', { bundle: params.get('p'), inviteToken: params.get('t') })).status).toBe(200);
    const side = new OrgMemberSide(member.stateDir, orgId);
    expect(await side.send(ORIGIN, { agentName: 'Wren', personName: 'Jordan Lee', appliedVersion: 1, state: 'joined' }, net)).toBe(true);
    expect(side.state()!.enrolled).toBe(true);

    // The page (owner device only; the bearer sees the agent's own read view).
    expect((await admin.bearer(request(admin.app).post('/mobile/org/members/remove')).send({ memberKey: side.state()!.publicKey })).status).toBe(403);
    const page = await admin.signed('GET', '/mobile/org/members');
    expect(page.status).toBe(200);
    const row = page.body.members.find((m: { agentName: string }) => m.agentName === 'Wren');
    expect(row).toMatchObject({ personName: 'Jordan Lee', appliedVersion: 1, state: 'joined', behind: false });
    expect(page.body.invitations[0].uses).toBe(1);

    // A keeper's proposal is countersigned and served.
    const keeper = newMemberKeyPair();
    expect((await admin.signed('POST', '/mobile/org/keepers/add', { code: encodeKeeperCode({ orgId, name: 'Ana', publicKey: keeper.publicKey }) })).status).toBe(200);
    const cur = readPublished(admin.stateDir)!.bundle.record;
    const proposal = signPayload({ v: 1 as const, orgId, baseVersion: cur.version, basePolicySha256: cur.policySha256, policy: POLICY + '- Spend organization money\n',
      maxIndependence: cur.maxIndependence, proposedBy: 'Someone Else', keeperKey: keeper.publicKey, at: Date.now() }, keeper.privateKeyPem);
    const prop = await request(admin.app).post('/org/pack/propose').send(proposal);
    expect(prop.status).toBe(200);
    const served = await request(admin.app).get('/org/pack/current');
    expect(served.body.record).toMatchObject({ version: cur.version + 1, publishedBy: 'Ana', signerPublicKey: cur.signerPublicKey });
    expect(validateBundle(served.body, { pinnedKey: cur.signerPublicKey, versionFloor: 0, joined: false, joinedVersion: null, joinedHash: null, joinedOrgId: null }).ok).toBe(true);
    // The admin's own draft from the old base is now stale.
    expect((await admin.signed('POST', '/mobile/org/publish', { draftId: draft.body.draftId, readBackConfirmed: true, shareUpdates: true })).body.error).toBe('stale-base');

    // Removal reaches the member as a notice; restore clears it; a second removal is a new notice.
    const key = side.state()!.publicKey;
    const r1 = await admin.signed('POST', '/mobile/org/members/remove', { memberKey: key });
    expect(r1.status).toBe(200);
    await side.send(ORIGIN, { agentName: 'Wren', personName: 'Jordan Lee', appliedVersion: 1, state: 'joined' }, net);
    const st = await member.signed('GET', '/mobile/org/status');
    expect(st.body.removedNotice).toBeTruthy();
    expect((await admin.signed('POST', '/mobile/org/members/restore', { memberKey: key })).status).toBe(200);
    await side.send(ORIGIN, { agentName: 'Wren', personName: 'Jordan Lee', appliedVersion: 1, state: 'joined' }, net);
    expect((await member.signed('GET', '/mobile/org/status')).body.removedNotice).toBeNull();
    const r2 = await admin.signed('POST', '/mobile/org/members/remove', { memberKey: key });
    expect(r2.body.removal.id).not.toBe(r1.body.removal.id);
    await side.send(ORIGIN, { agentName: 'Wren', personName: 'Jordan Lee', appliedVersion: 1, state: 'joined' }, net);
    expect((await member.signed('GET', '/mobile/org/status')).body.removedNotice).toBeTruthy();
    // A removed member cannot come back by itself, even with a fresh link.
    const fresh = new URLSearchParams(String((await admin.bearer(request(admin.app).post('/org/invitations')).send({})).body.link).split('#')[1]).get('t');
    side.onJoin({ inviteToken: fresh, afterLeave: true, consent: true });
    await side.send(ORIGIN, { agentName: 'Wren', personName: 'Jordan Lee', appliedVersion: 1, state: 'joined' }, net);
    const after = await admin.signed('GET', '/mobile/org/members');
    expect(after.body.members.find((m: { memberKey: string }) => m.memberKey === key).state).toBe('removed');
  }, 60000);
});
