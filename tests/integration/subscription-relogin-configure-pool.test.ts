// spec docs/specs/one-tap-unattended-repair.md — the fronting route, the target point of use, and
// delivery acceptance, over real HTTP with real Ed25519 issuance signatures and a real
// DeliveredMandateStore on the target.
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DeliveredMandateStore } from '../../src/coordination/DeliveredMandateStore.js';
import { packageMandateForDelivery } from '../../src/coordination/AccountFollowMeMandateBridge.js';
import { acceptMandateDelivery } from '../../src/coordination/AccountFollowMeMandateDelivery.js';
import { describeSubscriptionReloginConfig } from '../../src/core/SubscriptionReloginOperatorConfig.js';

interface TestServer { url: string; close: () => Promise<void> }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((done) => server.close(() => done())),
    }));
  });
}

const FRONT = 'm_front';
const TARGET = 'm_target';
const POOL = ['a@x.io', 'b@x.io', 'c@x.io'];

function makeHome(prefix: string, block: Record<string, unknown> | undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const config = { authToken: 'test', dashboardPin: '123456', stateDir: dir, port: 0,
    ...(block ? { subscriptionPool: { assistedRelogin: block } } : {}) };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return { dir, config };
}
const unattended = (ids: string[], extra: Record<string, unknown> = {}) => ({ enabled: true, mode: 'unattended', dryRun: false,
  unattendedPolicy: { identities: ids, minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }, ...extra });
const readBlock = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).subscriptionPool?.assistedRelogin;
const revisionOf = (dir: string) => describeSubscriptionReloginConfig(readBlock(dir)).revision;
const pool = (emails: string[]) => ({ list: () => emails.map((email, i) => ({ id: `acct-${i}`, email })) });

describe('one-tap repair setting: configure-pool → configure-with-mandate', () => {
  const servers: TestServer[] = [];
  const dirs: string[] = [];
  let keys: crypto.KeyPairKeyObjectResult;
  let target: { dir: string; config: Record<string, unknown>; store: DeliveredMandateStore; server: TestServer };
  let front: { dir: string; config: Record<string, unknown>; server: TestServer };
  let deliveries: number;
  let mandateSeq: number;

  async function start(targetBlock: Record<string, unknown> | undefined, frontBlock: Record<string, unknown> | undefined = unattended(['a@x.io'])) {
    keys = crypto.generateKeyPairSync('ed25519');
    const t = makeHome('cfgpool-target-', targetBlock); dirs.push(t.dir);
    const store = new DeliveredMandateStore({ filePath: path.join(t.dir, 'state', 'delivered-mandates.json') });
    const tApp = express(); tApp.use(express.json());
    tApp.use(createRoutes({ config: t.config, startTime: new Date(), meshSelfId: TARGET, deliveredMandateStore: store,
      subscriptionPool: pool(POOL), verifyDashboardOperatorSession: () => false } as any));
    const tServer = await listen(tApp); servers.push(tServer);
    target = { ...t, store, server: tServer };

    const f = makeHome('cfgpool-front-', frontBlock); dirs.push(f.dir);
    deliveries = 0; mandateSeq = 0;
    const fApp = express(); fApp.use(express.json());
    fApp.use(createRoutes({
      config: f.config, startTime: new Date(), meshSelfId: FRONT, subscriptionPool: pool(['a@x.io']),
      verifyDashboardOperatorSession: (token: string | undefined) => token === 'operator-proof',
      resolvePeerUrls: () => [{ machineId: TARGET, url: tServer.url }],
      coordination: { store: { issue: (input: any) => ({ id: `cfg-${++mandateSeq}`, createdAt: new Date().toISOString(), ...input }) },
        gate: { evaluate: () => ({ decision: 'deny' }) } },
      packageMandateForDelivery: (m: any) => packageMandateForDelivery(m, FRONT, keys.privateKey),
      // The real target-side acceptance, as the mesh handler runs it: account follow-me and repair
      // both OFF on the target — a configure-only mandate must still be accepted.
      deliverMandateToMachine: async ({ portable }: any) => {
        deliveries += 1;
        const r = acceptMandateDelivery({ enabled: () => false, reloginEnabled: () => false, selfMachineId: () => TARGET,
          operatorMachinePublicKey: () => keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), store }, FRONT, portable);
        return r.accepted ? { ok: true, status: 200 } : { ok: false, status: 200, reason: r.reason };
      },
    } as any));
    const fServer = await listen(fApp); servers.push(fServer);
    front = { ...f, server: fServer };
  }

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'configure-pool.test cleanup' });
  });

  const post = (base: string, url: string, body: unknown, session = 'operator-proof') => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Operator-Session': session }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }));

  it('carries each machine\'s setting on the existing read, including from a machine with repair off', async () => {
    await start({ enabled: false });
    const local = await fetch(`${target.server.url}/subscription-relogin`, { headers: { Authorization: 'Bearer test' } });
    expect(local.status).toBe(503);
    const body = await local.json() as any;
    expect(body.config).toMatchObject({ machineId: TARGET, mode: 'off', verifiedPoolEmails: POOL, activationPending: false });
    expect(body.config.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    const merged = await (await fetch(`${front.server.url}/subscription-relogin?scope=pool`)).json() as any;
    expect(merged.pool.configs.map((c: any) => c.machineId).sort()).toEqual([FRONT, TARGET]);
  });

  it('refuses without the session header, and refuses a PIN in the body', async () => {
    await start(unattended(['a@x.io']));
    const target0 = { machineId: TARGET, expectedRevision: revisionOf(target.dir), identities: POOL, minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 };
    expect((await post(front.server.url, '/subscription-relogin/configure-pool', { mode: 'unattended', targets: [target0] }, '')).status).toBe(401);
    expect((await post(front.server.url, '/subscription-relogin/configure-pool', { mode: 'unattended', pin: '123456', targets: [target0] }, '')).status).toBe(401);
    expect(deliveries).toBe(0);
  });

  it('refreshes a remote unattended machine\'s list with a single-use mandate, with provenance', async () => {
    await start(unattended(['a@x.io'], { generation: 2 }));
    const expectedRevision = revisionOf(target.dir);
    const r = await post(front.server.url, '/subscription-relogin/configure-pool', { mode: 'unattended',
      targets: [{ machineId: TARGET, expectedRevision, identities: POOL, minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }] });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([expect.objectContaining({ machineId: TARGET, ok: true, changed: true, restartRequested: true })]);
    expect(readBlock(target.dir)).toMatchObject({ mode: 'unattended', generation: 3, unattendedPolicy: { identities: POOL } });
    expect(r.body.results[0].revision).toBe(revisionOf(target.dir));
    const flag = JSON.parse(fs.readFileSync(path.join(target.dir, 'state', 'restart-requested.json'), 'utf8'));
    expect(flag.targetVersion).toBeUndefined();
    const audit = fs.readFileSync(path.join(target.dir, 'logs', 'subscription-relogin-config.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ via: 'mandate', deliveredBy: FRONT, mandateId: 'cfg-1' });
    // Replay of the consumed mandate is refused.
    const replay = await post(target.server.url, '/subscription-relogin/configure-with-mandate', { mandateId: 'cfg-1', action: 'configure',
      config: { enabled: true, mode: 'unattended', dryRun: false, unattendedPolicy: { identities: POOL, minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 } },
      expectedRevision });
    expect(replay).toMatchObject({ status: 403, body: { error: 'not-authorized' } });
  });

  it('never escalates a remote machine that is asks-first, watch-only or off', async () => {
    for (const block of [{ enabled: true, mode: 'approval', dryRun: false, unattendedPolicy: { identities: ['a@x.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 } },
      { enabled: true, mode: 'unattended' }, { enabled: false }]) {
      await start(block as any);
      const before = fs.readFileSync(path.join(target.dir, 'config.json'), 'utf8');
      const r = await post(front.server.url, '/subscription-relogin/configure-pool', { mode: 'unattended',
        targets: [{ machineId: TARGET, expectedRevision: revisionOf(target.dir), identities: ['a@x.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }] });
      expect(r.body.results[0]).toMatchObject({ ok: false, error: 'owner-must-enable-here' });
      expect(fs.readFileSync(path.join(target.dir, 'config.json'), 'utf8')).toBe(before);
      for (const s of servers.splice(0)) await s.close();
    }
  });

  it('refuses an email the target does not hold and a remote change to the waits', async () => {
    await start(unattended(['a@x.io'], { unattendedPolicy: { identities: ['a@x.io'], minimumSuccessfulRepairs: 10, minimumEvidenceDays: 30 } }));
    const rev = revisionOf(target.dir);
    const foreign = await post(front.server.url, '/subscription-relogin/configure-pool', { mode: 'unattended',
      targets: [{ machineId: TARGET, expectedRevision: rev, identities: ['a@x.io', 'z@evil.io'], minimumSuccessfulRepairs: 10, minimumEvidenceDays: 30 }] });
    expect(foreign.body.results[0]).toMatchObject({ ok: false, error: 'identity-not-on-this-machine' });
    const waits = await post(front.server.url, '/subscription-relogin/configure-pool', { mode: 'unattended',
      targets: [{ machineId: TARGET, expectedRevision: rev, identities: POOL, minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }] });
    expect(waits.body.results[0]).toMatchObject({ ok: false, error: 'invalid-config' });
  });

  it('orders commands: a request read at an older revision is refused after the counter moved (A→B→A)', async () => {
    await start(unattended(['a@x.io']));
    const revA = revisionOf(target.dir);
    const toB = await post(front.server.url, '/subscription-relogin/configure-pool', { mode: 'approval',
      targets: [{ machineId: TARGET, expectedRevision: revA, identities: ['a@x.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }] });
    expect(toB.body.results[0]).toMatchObject({ ok: true, mode: 'approval' });
    // Back to unattended can only be done on the machine itself; simulate the owner doing it there.
    const blk = readBlock(target.dir); blk.mode = 'unattended'; blk.generation += 1;
    const raw = JSON.parse(fs.readFileSync(path.join(target.dir, 'config.json'), 'utf8')); raw.subscriptionPool.assistedRelogin = blk;
    fs.writeFileSync(path.join(target.dir, 'config.json'), JSON.stringify(raw));
    const late = await post(front.server.url, '/subscription-relogin/configure-pool', { mode: 'unattended',
      targets: [{ machineId: TARGET, expectedRevision: revA, identities: POOL, minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }] });
    expect(late.body.results[0]).toMatchObject({ ok: false, error: 'stale-config' });
  });

  it('turns this machine on locally from off, setting no waits, and reports the applied revision', async () => {
    await start(unattended(['a@x.io']), { enabled: false });
    const r = await post(front.server.url, '/subscription-relogin/configure-pool', { mode: 'unattended',
      targets: [{ machineId: FRONT, expectedRevision: revisionOf(front.dir), identities: ['a@x.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }] });
    expect(r.body.results).toEqual([expect.objectContaining({ machineId: FRONT, ok: true, mode: 'unattended', changed: true })]);
    expect(readBlock(front.dir)).toMatchObject({ enabled: true, mode: 'unattended', dryRun: false,
      unattendedPolicy: { identities: ['a@x.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 } });
    const audit = fs.readFileSync(path.join(front.dir, 'logs', 'subscription-relogin-config.jsonl'), 'utf8');
    expect(audit).toContain('configure-pool-self');
    expect(deliveries).toBe(0);
  });

  it('finish-restart re-queues only the restart, consumes its mandate, and never rewrites the setting', async () => {
    await start(unattended(['a@x.io'], { generation: 1 }));
    // Simulate a write that landed on disk but whose restart request was lost: on-disk ≠ boot.
    const raw = JSON.parse(fs.readFileSync(path.join(target.dir, 'config.json'), 'utf8'));
    raw.subscriptionPool.assistedRelogin.generation = 2;
    raw.subscriptionPool.assistedRelogin.unattendedPolicy.minimumSuccessfulRepairs = 5;
    fs.writeFileSync(path.join(target.dir, 'config.json'), JSON.stringify(raw));
    const before = fs.readFileSync(path.join(target.dir, 'config.json'), 'utf8');
    const rev = revisionOf(target.dir);
    const r = await post(front.server.url, '/subscription-relogin/configure-pool', { action: 'finish-restart', targets: [{ machineId: TARGET, expectedRevision: rev }] });
    expect(r.body.results[0]).toMatchObject({ ok: true, restartRequested: true, changed: false, revision: rev });
    expect(fs.readFileSync(path.join(target.dir, 'config.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(target.dir, 'state', 'restart-requested.json'))).toBe(true);
    const replay = await post(target.server.url, '/subscription-relogin/configure-with-mandate', { mandateId: 'cfg-1', action: 'finish-restart', expectedRevision: rev });
    expect(replay).toMatchObject({ status: 403, body: { error: 'not-authorized' } });
  });

  it('a tampered config or a mandate for another machine is refused', async () => {
    await start(unattended(['a@x.io']));
    const rev = revisionOf(target.dir);
    const issued = await post(front.server.url, '/subscription-relogin/configure-pool', { mode: 'approval',
      targets: [{ machineId: TARGET, expectedRevision: rev, identities: ['b@x.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }] });
    expect(issued.body.results[0]).toMatchObject({ ok: false, error: 'invalid-config' });
    // The mandate from that attempt is unconsumed (refused before consume); tamper with the config:
    const tampered = await post(target.server.url, '/subscription-relogin/configure-with-mandate', { mandateId: 'cfg-1', action: 'configure',
      config: { enabled: true, mode: 'unattended', dryRun: false, unattendedPolicy: { identities: POOL, minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 } },
      expectedRevision: rev });
    expect(tampered).toMatchObject({ status: 403, body: { error: 'config-mismatch' } });
    expect(readBlock(target.dir).unattendedPolicy.identities).toEqual(['a@x.io']);
  });
});
