// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 lifecycle test for docs/specs/local-verify-peer-works-through-restart.md: the coordinator is built
 * through buildLocalVerifyService and wired through wireLocalVerifySwitches / wireLocalVerifyPeers (the
 * functions server.ts calls), with a fake peer client. A coordinator restart in the middle of a peer
 * attempt ends in the import of that attempt, and the first tick after boot (lease not yet held) does not
 * cancel it. Plus wiring integrity: the setting's setter and PR 3451's holding record are wired, not no-ops.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildLocalVerifyService, wireLocalVerifyPeers, wireLocalVerifySwitches } from '../../src/localVerify/localVerifyWiring.js';
import type { LocalVerifyService, LocalVerifyServiceSeams } from '../../src/localVerify/LocalVerifyService.js';
import type { PeerClient, PeerResult, PeerRunRequest } from '../../src/localVerify/peer.js';
import { requestDigest, signPeerResult } from '../../src/localVerify/peerResultSignature.js';
import type { LocalVerifyRecord } from '../../src/localVerify/record.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'localVerify', 'runVerifyMain.js');
const SETTING = 'monitoring.localVerify.peerWorksThroughRestart.enabled';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-peer-works-through-restart-lifecycle.test.ts' }); });

function sourceCheckout(): { home: string; stateDir: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvpwtr-e2e-')));
  dirs.push(home);
  fs.mkdirSync(path.join(home, '.git'));
  fs.mkdirSync(path.join(home, 'scripts'));
  fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// stand-in\n');
  const stateDir = path.join(home, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
    v: 1, machineId: 'm_coord', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: new Date().toISOString(),
  }));
  return { home, stateDir };
}

function ctx(stateDir: string, localVerify: LocalVerifyService): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null, localVerify, localVerifyStatus: null,
    startTime: new Date(),
  } as never;
}

const KEYS = generateSigningKeyPair();
const HASH = signerKeyHashOf(KEYS.publicKey);
const SIGNER: MachineSigner = { machineId: () => 'm_peer', signerKeyHash: () => HASH, sign: (payload) => ({ machineId: 'm_peer', signerKeyHash: HASH, sig: edSign(payload, KEYS.privateKey) }) };
const PINS: MachineKeyLookup = (_m, hash) => (hash === HASH ? { status: 'ok', publicKeyPem: KEYS.publicKey } : { status: 'unknown' });

/** A fake peer that signs its finished answer over the request it received, as a real peer does. */
function fakePeer(verifierVersion: string, policyHash: string) {
  const received = new Map<string, PeerRunRequest>();
  const cancels: string[] = [];
  let answer: (req: PeerRunRequest) => PeerResult = () => ({ state: 'running' });
  const client: PeerClient = {
    status: async () => ({ inFlight: null, verifierVersion, policyHash, slotBusy: false, signerKeyHash: HASH }),
    run: async (_p, req) => { received.set(req.attemptId, req); return { ok: true, attemptId: req.attemptId }; },
    result: async (_p, id) => {
      const req = received.get(id);
      if (!req) return { state: 'unknown' };
      const r = answer(req);
      if (r.state !== 'done') return r;
      const digest = requestDigest(req);
      return { ...r, requestDigest: digest, sig: signPeerResult(SIGNER, { record: r.record, requestDigest: digest }) };
    },
    cancel: async (_p, id) => { cancels.push(id); },
  };
  return { client, received, cancels, answer: (f: typeof answer) => { answer = f; }, prime: (reqs: Iterable<PeerRunRequest>) => { for (const r of reqs) received.set(r.attemptId, r); } };
}

/** The production path: build, wire switches and peers as server.ts does, then the fake peer client and pins. */
function buildCoordinator(o: { home: string; stateDir: string; values: Record<string, unknown>; lease: { holds: boolean; epoch: number; holder: string | null } }) {
  const built = buildLocalVerifyService({
    config: { enabled: true }, expectedGhLogin: 'EchoOfDawn', repo: 'JKHeadley/instar',
    repoPath: o.home, stateDir: o.stateDir, agentHome: o.home, machineId: 'm_coord', mainEntry: DIST_ENTRY,
  });
  expect(built.reason).toBeNull();
  const svc = built.service!;
  const get = <T,>(k: string, fb: T): T => (k in o.values ? o.values[k] as T : fb);
  const lease = { holdsLease: () => o.lease.holds, leaseEpoch: () => o.lease.epoch, holderMachineId: () => o.lease.holder };
  wireLocalVerifySwitches(svc, { get });
  wireLocalVerifyPeers(svc, { liveConfig: { get }, authToken: 'test-token', agentId: 'echo', stateDir: o.stateDir, lease });
  const seams = (svc as unknown as { seams: LocalVerifyServiceSeams }).seams;
  seams.prView = async () => ({ author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: HEAD, baseRefName: 'main', baseRefOid: BASE });
  seams.baseHead = async () => BASE;
  seams.isPrOpen = async () => true;
  seams.foreignSuiteHolders = () => [{ pid: 9001 }]; // the local slot is taken: the PR goes to the peer
  seams.spawnRun = () => { throw new Error('nothing runs locally in this test'); };
  const inner = svc as unknown as { cfg: { verifierVersion: string }; policyHash: string };
  return { svc, verifierVersion: inner.cfg.verifierVersion, policyHash: inner.policyHash };
}

const waitFor = async (until: () => boolean) => { for (let i = 0; i < 300 && !until(); i++) await new Promise((r) => setTimeout(r, 10)); };
const audits = (stateDir: string, event: string) => {
  const f = path.join(stateDir, 'logs', 'local-verify.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.event === event) : [];
};

describe('local-verify peer works through restart (production wiring, lifecycle)', () => {
  it.each([1, 2] as const)('routes a reduced PR with %i unit workers only when the peer confirms the contract', async (unitWorkers) => {
    const { home, stateDir } = sourceCheckout();
    const machineId = 'm_' + '3'.repeat(32);
    const trial = { version: 1 as const, machineId, collector: 'darwin-vm-stat-native-pressure-v1' as const,
      floorBytes: 8192, reserveBytes: 4096, recoveryMs: 3000, unitWorkers, integration: 1 as const, e2e: 1 as const };
    const values = { 'monitoring.localVerify.smallPeerTrial': trial,
      'monitoring.localVerify.peers': [{ machineId, url: 'http://127.0.0.1:1' }] };
    const c = buildCoordinator({ home, stateDir, values, lease: { holds: true, epoch: 7, holder: 'm_coord' } });
    const fake = fakePeer(c.verifierVersion, c.policyHash);
    const status = fake.client.status;
    fake.client.status = async (peer) => ({ ...(await status(peer))!, smallPeerTrial: trial });
    c.svc.setPeerWiring({ client: fake.client, keyLookupFactory: () => PINS,
      peerFit: () => ({ eligible: false, reason: 'machine-too-small', smallPeerHeadroom: true, score: 0.1 }) });
    try {
      await c.svc.boot();
      await c.svc.tick();
      expect((await c.svc.request(3)).ok).toBe(true);
      await waitFor(() => fake.received.size === 1);
      expect([...fake.received.values()][0]).toMatchObject({ pr: 3, smallPeerTrial: trial });
    } finally { c.svc.shutdown(); }
  });

  it('a coordinator restart mid-attempt ends in the import of that attempt; the first tick after boot (lease not yet held) does not cancel', async () => {
    const { home, stateDir } = sourceCheckout();
    const values: Record<string, unknown> = { 'monitoring.localVerify.peers': [{ machineId: 'm_peer', url: 'http://127.0.0.1:1' }], [SETTING]: true };
    const lease1 = { holds: true, epoch: 7, holder: 'm_coord' as string | null };
    const c1 = buildCoordinator({ home, stateDir, values, lease: lease1 });
    const peer1 = fakePeer(c1.verifierVersion, c1.policyHash);
    c1.svc.setPeerWiring({ client: peer1.client, keyLookupFactory: () => PINS });
    await c1.svc.boot();
    await c1.svc.tick(); // the holding record starts here (epoch 7)
    expect((await c1.svc.request(3)).ok).toBe(true);
    await waitFor(() => c1.svc.snapshot().peers.reserved[0]?.state === 'accepted');
    const [req] = [...peer1.received.values()];
    expect(req).toMatchObject({ pr: 3, leaseEpoch: 7 });
    c1.svc.shutdown();

    // The restart: the same machine boots at the next epoch, and on its first tick does not hold the lease yet.
    const lease2 = { holds: false, epoch: 8, holder: null as string | null };
    const c2 = buildCoordinator({ home, stateDir, values, lease: lease2 });
    const peer2 = fakePeer(c2.verifierVersion, c2.policyHash);
    peer2.prime(peer1.received.values());
    peer2.answer((r) => ({ state: 'done', record: {
      repo: 'JKHeadley/instar', pr: r.pr, headSha: r.headSha, baseSha: r.baseSha, baseRefName: r.baseRefName, mergeTree: 'c'.repeat(40),
      lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
      nodeVersion: 'v24', machineId: 'm_peer', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
      verifierVersion: r.verifierVersion, policyHash: r.policyHash, attempt: { id: r.attemptId, coordinatorMachineId: 'm_coord', leaseEpoch: r.leaseEpoch },
    } as LocalVerifyRecord }));
    c2.svc.setPeerWiring({ client: peer2.client, keyLookupFactory: () => PINS });
    await c2.svc.boot();
    await c2.svc.tick();
    expect(c2.svc.snapshot().peers.reserved).toEqual([expect.objectContaining({ pr: 3, attemptId: req.attemptId, adoptedEpoch: null })]);
    expect(peer2.cancels).toEqual([]);
    expect(audits(stateDir, 'peer-attempt-adoption-waiting')).toEqual([expect.objectContaining({ attemptId: req.attemptId, why: 'not-held' })]);

    lease2.holds = true;
    lease2.holder = 'm_coord';
    await c2.svc.tick();
    expect(audits(stateDir, 'peer-attempt-adopted')).toEqual([expect.objectContaining({ pr: 3, attemptId: req.attemptId, fromEpoch: 7, toEpoch: 8 })]);
    expect(audits(stateDir, 'peer-imported')).toEqual([expect.objectContaining({ pr: 3, attemptId: req.attemptId, outcome: 'success' })]);
    expect(c2.svc.getRecord(3, HEAD, 'main')).toMatchObject({ outcome: 'success', machineId: 'm_peer' });
    expect(peer2.cancels).toEqual([]);
    c2.svc.shutdown();
  });

  it('wiring integrity: the setting setter reads the live config (not a no-op) and the holding record carries since', async () => {
    const { home, stateDir } = sourceCheckout();
    const values: Record<string, unknown> = {};
    const lease = { holds: true, epoch: 4, holder: 'm_coord' as string | null };
    const c = buildCoordinator({ home, stateDir, values, lease });
    const on = c.svc as unknown as { peerWorksThroughRestartOn(): boolean };
    expect(on.peerWorksThroughRestartOn()).toBe(false); // absent ⇒ off; no default written
    values[SETTING] = true;
    expect(on.peerWorksThroughRestartOn()).toBe(true);
    values[SETTING] = 'true';
    expect(on.peerWorksThroughRestartOn()).toBe(false);
    await c.svc.boot();
    await c.svc.tick();
    const trust = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'local-verify', 'peer-trust.json'), 'utf-8')) as { holding: unknown };
    expect(trust.holding).toEqual({ holder: 'm_coord', epoch: 4, since: 4 });
    const a = express();
    a.use(express.json());
    a.use(createRoutes(ctx(stateDir, c.svc)));
    const r = await request(a).get('/local-verify');
    expect(r.status).toBe(200);
    expect(r.body.peers).toMatchObject({ worksThroughRestart: false, restartEpisode: null, reserved: [] });
    c.svc.shutdown();
  });
});
