// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration for docs/specs/local-verify-peer-works-through-restart.md over the real HTTP
 * pipeline (createRoutes on a listening express server, the coordinator's real `makePeerClient`):
 *  - the live setter (`wireLocalVerifySwitches`) changes behaviour without a restart: a restart pause
 *    stops dispatch with the setting off and lets a PR through to the idle peer with it on;
 *  - `GET /local-verify` shows `worksThroughRestart`, `restartEpisode` and per reservation
 *    `sentDuringPause` / `adoptedEpoch`;
 *  - a running peer answer carries the run's progress through the real client;
 *  - the `migrateClaudeMd` step that rewrites the peer line is idempotent.
 * Only the run child and gh are fakes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LocalVerifyService } from '../../src/localVerify/LocalVerifyService.js';
import { makePeerClient, wireLocalVerifySwitches } from '../../src/localVerify/localVerifyWiring.js';
import { verifyPaths } from '../../src/localVerify/orchestrator.js';
import { computePolicyHash } from '../../src/localVerify/policy.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { LOCAL_VERIFY_PEERS_CLAUDEMD_LINE, LOCAL_VERIFY_PEERS_NEW_EPOCH_PHRASE, LOCAL_VERIFY_PEERS_OLD_EPOCH_PHRASE, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const AUTH = 'test-token';
const SETTING = 'monitoring.localVerify.peerWorksThroughRestart.enabled';
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-peer-works-through-restart.test.ts' });
});

const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };

function ctx(stateDir: string, svc: LocalVerifyService, holdsLease: boolean, holder: string): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null, localVerify: svc,
    coordinator: { holdsLease: () => holdsLease, getSyncStatus: () => ({ leaseHolder: holder, leaseEpoch: 7 }) } as never,
    startTime: new Date(),
  } as never;
}

async function listen(c: RouteContext): Promise<{ url: string; app: express.Express }> {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => AUTH, 'echo'));
  a.use(createRoutes(c));
  const s = http.createServer(a);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', () => r(null)));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, app: a };
}

const KEYS = generateSigningKeyPair();
const HASH = signerKeyHashOf(KEYS.publicKey);
const SIGNER: MachineSigner = { machineId: () => 'peer1', signerKeyHash: () => HASH, sign: (payload) => ({ machineId: 'peer1', signerKeyHash: HASH, sig: edSign(payload, KEYS.privateKey) }) };
const PINS: MachineKeyLookup = (_m, hash) => (hash === HASH ? { status: 'ok', publicKeyPem: KEYS.publicKey } : { status: 'unknown' });
const viewFor = (pr: number) => ({ author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: pr === 3 ? sha('a') : sha('c'), baseRefName: 'main', baseRefOid: sha('b') });
const config = { get: (values: Record<string, unknown>) => <T,>(k: string, fb: T): T => (k in values ? values[k] as T : fb) };

/** A peer-only service served over HTTP: its run child never exits (the attempt stays running). */
async function servedPeer(values: Record<string, unknown>) {
  const stateDir = tmp('lvpwtr-peer-');
  const agentHome = tmp('lvpwtr-peerhome-');
  const children: string[] = [];
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome, expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'peer1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false, peerOnly: true,
  }, {
    prView: async (pr) => viewFor(pr), isPrOpen: async () => true, baseHead: async () => sha('b'),
    spawnRun: (a) => { children.push(a.args[a.args.indexOf('--input') + 1]); return { pid: 91_000 + children.length, exited: new Promise(() => {}) }; },
    isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [], setTimer: () => {},
  });
  svc.setPeerWiring({ peerRoleEnabled: () => true, signer: SIGNER, lease: { holdsLease: () => false, leaseEpoch: () => 7, holderMachineId: () => 'coord' } });
  wireLocalVerifySwitches(svc, { get: config.get(values) });
  const { url } = await listen(ctx(stateDir, svc, false, 'coord'));
  return { svc, url, agentHome, children };
}

/** A coordinator using the real HTTP client, with the switches wired through the production setter. */
async function servedCoordinator(peerUrl: string, values: Record<string, unknown>) {
  const stateDir = tmp('lvpwtr-coord-');
  fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
    v: 1, machineId: 'coord', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: new Date().toISOString(),
  }));
  const localStarts: number[] = [];
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: tmp('lvpwtr-coordhome-'), expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'coord', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, {
    prView: async (pr) => viewFor(pr), isPrOpen: async () => true, baseHead: async () => sha('b'),
    spawnRun: () => { localStarts.push(1); return { pid: 92_000 + localStarts.length, exited: new Promise(() => {}) }; },
    isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [], setSuitePriority: () => {},
  });
  svc.setPeerWiring({
    peers: () => [{ machineId: 'peer1', url: peerUrl }], client: makePeerClient(AUTH, 'echo'),
    lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'coord' }, keyLookupFactory: () => PINS,
  });
  wireLocalVerifySwitches(svc, { get: config.get(values) });
  const { app } = await listen(ctx(stateDir, svc, true, 'coord'));
  return { svc, app, localStarts };
}

const waitFor = async (until: () => boolean) => { for (let i = 0; i < 300 && !until(); i++) await new Promise((r) => setTimeout(r, 10)); };

describe('peer works through restart (integration, real HTTP)', () => {
  it('the live setter: paused + off sends nothing; flipped on (no restart) a PR goes to the idle peer, stamped and visible on GET /local-verify', async () => {
    const peerValues: Record<string, unknown> = {};
    const peer = await servedPeer(peerValues);
    const values: Record<string, unknown> = {};
    const coord = await servedCoordinator(peer.url, values);
    expect((await coord.svc.request(3)).ok).toBe(true); // runs here (its child never exits)
    expect(coord.localStarts).toHaveLength(1);
    coord.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: Date.now(), otherBlockers: false }));
    await coord.svc.tick();
    expect((await coord.svc.request(4)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(peer.children).toHaveLength(0);

    const get = async () => (await request(coord.app).get('/local-verify').set('Authorization', `Bearer ${AUTH}`)).body;
    let body = await get();
    expect(body.peers.worksThroughRestart).toBe(false);
    expect(body.peers.restartEpisode).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{32}$/) }); // the episode is tracked either way (measurement only)

    values[SETTING] = true;
    await coord.svc.tick();
    await waitFor(() => coord.svc.snapshot().peers.reserved[0]?.state === 'accepted');
    expect(peer.children).toHaveLength(1);
    body = await get();
    expect(body.peers.worksThroughRestart).toBe(true);
    expect(body.peers.reserved).toEqual([expect.objectContaining({ pr: 4, state: 'accepted', sentDuringPause: body.peers.restartEpisode.id, adoptedEpoch: null })]);
    expect(coord.localStarts).toHaveLength(1); // the local slot starts nothing while paused

    values[SETTING] = 'yes'; // only a real boolean true is on
    expect((await get()).peers.worksThroughRestart).toBe(false);
    coord.svc.shutdown();
    peer.svc.shutdown();
  });

  it('a running peer answer carries the run\'s progress through the real client when the peer\'s setting is on, and none when off', async () => {
    const peerValues: Record<string, unknown> = {};
    const peer = await servedPeer(peerValues);
    const client = makePeerClient(AUTH, 'echo');
    const target = { machineId: 'peer1', url: peer.url };
    const attemptId = 'e'.repeat(32);
    expect(await client.run(target, { attemptId, pr: 3, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0',
      policyHash: computePolicyHash(), coordinatorMachineId: 'coord', leaseEpoch: 7 })).toEqual({ ok: true, attemptId });
    const p = verifyPaths(peer.agentHome, sha('a'));
    fs.mkdirSync(p.reportsDir, { recursive: true });
    fs.writeFileSync(path.join(p.reportsDir, 'e2e-1.progress.json'), JSON.stringify({ v: 1, writtenAt: Date.now(), finishedFiles: 12,
      running: [{ file: path.join(p.runDir, 'tests/e2e/slow.test.ts'), startedAt: Date.now() - 90_000 }] }));
    expect(await client.result(target, attemptId)).toEqual({ state: 'running' });
    peerValues[SETTING] = true;
    const res = await client.result(target, attemptId);
    expect(res).toMatchObject({ state: 'running', progress: { finishedFiles: 12, slowdown: 1, running: [{ file: 'tests/e2e/slow.test.ts', lane: 'e2e', recordedMs: null }] } });
    peer.svc.shutdown();
  });

  it('migrateClaudeMd rewrites the peer line\'s lease-epoch phrase in an existing agent once (idempotent); the template matches', () => {
    expect(LOCAL_VERIFY_PEERS_CLAUDEMD_LINE).toContain(LOCAL_VERIFY_PEERS_NEW_EPOCH_PHRASE);
    expect(generateClaudeMd('fixture', 'Fixture', 4042, true)).toContain(LOCAL_VERIFY_PEERS_NEW_EPOCH_PHRASE);
    const projectDir = tmp('lvpwtr-mig-');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const claudeMd = path.join(projectDir, 'CLAUDE.md');
    const oldLine = LOCAL_VERIFY_PEERS_CLAUDEMD_LINE.replace(LOCAL_VERIFY_PEERS_NEW_EPOCH_PHRASE, LOCAL_VERIFY_PEERS_OLD_EPOCH_PHRASE);
    fs.writeFileSync(claudeMd, `# CLAUDE.md\n\n### Local Verify\n- Ask: \`POST /local-verify\`\n${oldLine}\n`);
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    const run = () => { const r = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] }; (m as unknown as { migrateClaudeMd(x: typeof r): void }).migrateClaudeMd(r); return r; };
    const label = 'CLAUDE.md: Local Verify peer line names the works-through-restart setting';
    expect(run().upgraded).toContain(label);
    const once = fs.readFileSync(claudeMd, 'utf-8');
    expect(once).toContain(LOCAL_VERIFY_PEERS_CLAUDEMD_LINE);
    expect(once).not.toContain(LOCAL_VERIFY_PEERS_OLD_EPOCH_PHRASE);
    expect(run().upgraded).not.toContain(label);
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe(once);
    expect(once.split(SETTING).length - 1).toBe(1);
  });
});
