/**
 * Multi-machine organization routes on real AgentServers (org-members-and-keepers §Multi-machine, CMT-1873)
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
import { publishedPaths, readPublished, setOrgForward, handleOrgForward, markPublishedElsewhere } from '../../src/server/orgPackRoutes.js';
import { validateBundle } from '../../src/core/OrgPack.js';

const HOST = 'org-mm.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/org-multimachine.test.ts' });
});

const POLICY = '## Never\n- Share donor details outside the organization\n';

async function boot(name: string) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `org-mm-${name}-`));
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

describe('a machine without the key forwards to the one that has it', () => {
  it('keeps admin drafts on the key machine and identifies it to an authenticated peer', async () => {
    const publisher = await boot('publisher');
    const peer = await boot('peer');
    const draft = { orgName: 'Monroe Institute', policyMarkdown: POLICY };
    const first = await publisher.bearer(request(publisher.app).post('/org/draft')).send(draft);
    expect(first.status).toBe(200);
    expect((await publisher.signed('POST', '/mobile/org/publish', {
      draftId: first.body.draftId, readBackConfirmed: true, shareUpdates: true,
    })).status).toBe(200);
    const orgId = readPublished(publisher.stateDir)!.bundle.record.orgId;

    // A peer may have a valid local draft created before it received the publisher marker.
    const legacy = await peer.bearer(request(peer.app).post('/org/draft')).send(draft);
    expect(legacy.status).toBe(200);
    const savedBefore = fs.readdirSync(publishedPaths(peer.stateDir).drafts);
    markPublishedElsewhere(peer.stateDir, orgId, 'publisher');
    const refused = await peer.bearer(request(peer.app).post('/org/draft')).send(draft);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'org-key-elsewhere', machineId: 'publisher' });
    expect(refused.body.detail).toContain('publisher');
    expect(fs.readdirSync(publishedPaths(peer.stateDir).drafts)).toEqual(savedBefore);

    const publishBody = { draftId: legacy.body.draftId, readBackConfirmed: true };
    const bearerPublish = await peer.bearer(request(peer.app).post('/mobile/org/publish')).send(publishBody);
    expect(bearerPublish.status).toBe(403);
    expect(bearerPublish.body.machineId).toBeUndefined();
    const signedPublish = await peer.signed('POST', '/mobile/org/publish', publishBody);
    expect(signedPublish.status).toBe(409);
    expect(signedPublish.body).toMatchObject({ error: 'org-key-elsewhere', machineId: 'publisher' });
    expect(readPublished(peer.stateDir)).toBeNull();
    expect(fs.readdirSync(publishedPaths(peer.stateDir).root).some(name => name.endsWith('.signing-key'))).toBe(false);

    // A recovered publisher's local key takes precedence over an earlier peer marker.
    markPublishedElsewhere(publisher.stateDir, orgId, 'former-publisher');
    const local = await publisher.bearer(request(publisher.app).post('/org/draft')).send(draft);
    expect(local.status).toBe(200);
    const saved = path.join(publishedPaths(publisher.stateDir).drafts, local.body.draftId + '.json');
    expect(JSON.parse(fs.readFileSync(saved, 'utf8')).base).toMatchObject({ orgId, version: 1 });
  }, 60000);

  it('public pack, check-in and the admin members page reach the key machine', async () => {
    const keyMachine = await boot('keymachine');
    const lease = await boot('leasemachine');
    const d = await keyMachine.bearer(request(keyMachine.app).post('/org/draft')).send({ orgName: 'Monroe Institute', policyMarkdown: POLICY });
    expect((await keyMachine.signed('POST', '/mobile/org/publish', { draftId: d.body.draftId, readBackConfirmed: true, shareUpdates: true })).status).toBe(200);
    const orgId = readPublished(keyMachine.stateDir)!.bundle.record.orgId;
    const inv = new URLSearchParams(String((await keyMachine.bearer(request(keyMachine.app).post('/org/invitations')).send({})).body.link).split('#')[1]);
    setOrgForward((op) => handleOrgForward(keyMachine.stateDir, op));
    // Before the key machine's publish marker reaches it, the lease machine answers as before (no forwarding).
    expect((await request(lease.app).get('/org/pack/current')).status).toBe(404);
    markPublishedElsewhere(lease.stateDir, orgId, 'keymachine');
    try {
      // The lease machine has nothing published, yet serves the pack and takes check-ins for the key machine.
      const pack = await request(lease.app).get('/org/pack/current');
      expect(pack.status).toBe(200);
      expect(pack.body.record.orgId).toBe(orgId);
      const m = newMemberKeyPair();
      const { sig: _s, ...unsigned } = { v: 1 as const, orgId, memberKey: m.publicKey, agentName: 'Wren', personName: 'Jordan', appliedVersion: 1, state: 'joined' as const, at: Date.now(), inviteToken: inv.get('t')!, sig: '' };
      const ci = await request(lease.app).post('/org/checkin').send(signPayload(unsigned, m.privateKeyPem));
      expect(ci.status).toBe(200);
      expect(ci.body.enrolled).toBe(true);
      // The admin's page through the lease machine: device only, and it shows the key machine's members.
      expect((await lease.bearer(request(lease.app).get('/mobile/org/members'))).status).toBe(403);
      const page = await lease.signed('GET', '/mobile/org/members');
      expect(page.status).toBe(200);
      expect(page.body.members.map((x: { agentName: string }) => x.agentName)).toContain('Wren');
      const rm = await lease.signed('POST', '/mobile/org/members/remove', { memberKey: m.publicKey });
      expect(rm.status).toBe(200);
      // With no machine answering, the lease machine says so instead of 404.
      setOrgForward(async () => null);
      expect((await lease.signed('GET', '/mobile/org/members')).body.error).toBe('org-key-machine-asleep');
    } finally {
      setOrgForward(null);
    }
  }, 60000);
});
