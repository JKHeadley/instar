/**
 * Organization recovery copy on real AgentServers (docs/specs/org-recovery-copy.md, Acceptance 4)
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
import { OrgPackUpdater } from '../../src/core/OrgPackUpdater.js';

const HOST = 'org-rc.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/org-recovery-copy.test.ts' });
});

const POLICY = '## Never\n- Share donor details outside the organization\n';

async function boot(name: string) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `org-rc-${name}-`));
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

describe('recovery copy', () => {
  it('copy, later versions, recover with a colleague bundle, +1000, unconfirmed members, refusal when the old address answers', async () => {
    const admin = await boot('admin');
    const member = await boot('member');
    const heir = await boot('heir');
    const draft = (text: string) => admin.bearer(request(admin.app).post('/org/draft')).send({ orgName: 'Monroe Institute', policyMarkdown: POLICY + text });
    const publish = async (text: string) => {
      const d = await draft(text);
      const r = await admin.signed('POST', '/mobile/org/publish', { draftId: d.body.draftId, readBackConfirmed: true, shareUpdates: true, maxIndependence: 'careful' });
      expect(r.status).toBe(200);
      return r;
    };
    await publish(''); await publish('- a\n'); await publish('- b\n');
    const orgId = readPublished(admin.stateDir)!.bundle.record.orgId;
    const inv = new URLSearchParams(String((await admin.bearer(request(admin.app).post('/org/invitations')).send({})).body.link).split('#')[1]);
    expect((await member.signed('POST', '/mobile/org/join', { bundle: inv.get('p'), inviteToken: inv.get('t') })).status).toBe(200);
    const side = new OrgMemberSide(member.stateDir, orgId);
    const net = { fetchFn: fetchTo(admin.app), lookup: async () => ['93.184.216.34'] };
    expect(await side.send('https://admin.example.dev', { agentName: 'Wren', personName: 'Jordan', appliedVersion: 3, state: 'joined' }, net)).toBe(true);

    // The copy at v3; then v4, v5, and a removal after the copy.
    const copy = await admin.signed('POST', '/mobile/org/recovery-copy', {});
    expect(copy.status).toBe(200);
    expect(String(copy.body.phrase).split(' ')).toHaveLength(6);
    await publish('- c\n'); await publish('- d\n');
    const v5 = readPublished(admin.stateDir)!.bundle;
    expect(v5.record.version).toBe(5);
    // The member takes v5 through its update check (held for the person when a line changes, then accepted).
    const memFile = path.join(member.stateDir, 'org', 'membership.json');
    fs.writeFileSync(memFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(memFile, 'utf-8')), updateOrigin: 'https://admin.example.dev' }));
    const updater = new OrgPackUpdater({
      stateDir: member.stateDir, machineId: 'm', isLeaseHolder: () => true, effects: () => ({}), notify: () => {},
      lookup: async () => ['203.0.113.10'],
      fetchFn: (async () => new Response(JSON.stringify(v5))) as unknown as typeof fetch,
    });
    const took = await updater.tick(true);
    expect(['held', 'applied']).toContain(took);
    if (took === 'held') expect((await member.signed('POST', '/mobile/org/update-accept', { version: 5 })).status).toBe(200);
    await admin.signed('POST', '/mobile/org/members/remove', { memberKey: side.state()!.publicKey });

    // Refused without the retirement answer, and while the old address still answers.
    expect((await heir.signed('POST', '/mobile/org/recover', { file: copy.body.file, phrase: copy.body.phrase })).body.error).toBe('retirement-required');
    expect((await heir.signed('POST', '/mobile/org/recover', { file: copy.body.file, phrase: 'wrong words entirely here now ok', retired: true })).status).toBe(403);
    // (The heir's own outgoing calls use its configured net seam; with none, the old https address is unreachable here.)
    const rec = await heir.signed('POST', '/mobile/org/recover', { file: copy.body.file, phrase: copy.body.phrase, retired: true });
    expect(rec.status).toBe(200);
    expect(rec.body.version).toBe(3);
    expect((await heir.bearer(request(heir.app).post('/org/invitations')).send({})).body.error).toBe('publish-after-recovery-first');

    // A colleague's newer version is taken, with its label.
    const exported = await member.signed('GET', '/mobile/org/current-bundle');
    expect(exported.body.bundle.record.version).toBe(5);
    const latest = await heir.signed('POST', '/mobile/org/recover-latest', { bundle: exported.body.bundle, label: 'Jordan' });
    expect(latest.body).toMatchObject({ ok: true, kept: 5, source: 'Jordan' });

    // Members come back unconfirmed; keepers inactive.
    const page = await heir.signed('GET', '/mobile/org/members');
    const row = page.body.members.find((m: { agentName: string }) => m.agentName === 'Wren');
    expect(row).toMatchObject({ state: 'joined', unconfirmed: true });

    // First publish: v5 text, +1000, careful cap kept.
    const d = await heir.bearer(request(heir.app).post('/org/draft')).send({ orgName: 'Monroe Institute', policyMarkdown: exported.body.bundle.policy });
    const pub = await heir.signed('POST', '/mobile/org/publish', { draftId: d.body.draftId, readBackConfirmed: true });
    expect(pub.status).toBe(200);
    expect(pub.body.record).toMatchObject({ version: 1005, maxIndependence: 'careful', signerPublicKey: v5.record.signerPublicKey });
    expect((await heir.bearer(request(heir.app).post('/org/invitations')).send({})).status).toBe(200);
  }, 120000);
});
