// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 lifecycle test for first parts (spec docs/specs/local-verify-likely-failing-first.md):
 * the service is built through buildLocalVerifyService and wired through wireLocalVerifySwitches
 * and wireLocalVerifyPeers, the same functions server.ts calls. Proves on the production wiring:
 * the setting is read live per machine, the list file is written where the service reads it,
 * the list store is real and shared by the recorder and the run input, and a verify handed to a
 * peer over real HTTP carries the list.
 */

import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildLocalVerifyService, wireLocalVerifyPeers, wireLocalVerifySwitches } from '../../src/localVerify/localVerifyWiring.js';
import type { LocalVerifyService, LocalVerifyServiceSeams } from '../../src/localVerify/LocalVerifyService.js';
import { LikelyFailingStore } from '../../src/localVerify/likelyFailingList.js';
import type { VerifyRunInput } from '../../src/localVerify/orchestrator.js';
import type { LocalVerifyRecord } from '../../src/localVerify/record.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'localVerify', 'runVerifyMain.js');
const F1 = 'tests/unit/localVerify/record.test.ts';
const F2 = 'tests/e2e/local-verify-lifecycle.test.ts';
const sha = (c: string) => c.repeat(40);
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((resolve) => s.close(resolve));
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-likely-failing-first-lifecycle.test.ts' });
});

function sourceCheckout(): { home: string; stateDir: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvfirst-life-')));
  dirs.push(home);
  fs.mkdirSync(path.join(home, '.git'));
  fs.mkdirSync(path.join(home, 'scripts'));
  fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// stand-in\n');
  const stateDir = path.join(home, '.instar');
  fs.mkdirSync(stateDir);
  return { home, stateDir };
}

function ctx(stateDir: string, localVerify: RouteContext['localVerify']): RouteContext {
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

function serve(c: RouteContext) {
  const a = express();
  a.use(express.json());
  a.use(createRoutes(c));
  return a;
}

/** Give the peer a real machine identity and pin it on the coordinator, the way pairing does (SEC-113 D1). */
async function pairPeerIdentity(peerStateDir: string, coordStateDir: string, peerId: string): Promise<void> {
  await new MachineIdentityManager(peerStateDir).generateIdentity({ name: 'lv first-part e2e peer' });
  const own = path.join(peerStateDir, 'machine', 'identity.json');
  const identity = { ...JSON.parse(fs.readFileSync(own, 'utf-8')), machineId: peerId };
  fs.writeFileSync(own, JSON.stringify(identity));
  const pinned = path.join(coordStateDir, 'machines', peerId, 'identity.json');
  fs.mkdirSync(path.dirname(pinned), { recursive: true });
  fs.writeFileSync(pinned, JSON.stringify(identity));
}

interface Run { input: VerifyRunInput; resultPath: string; end: (x: { status: number | null; signal: string | null }) => void }

/** Replace the process and GitHub seams of a production-built service with in-memory ones; returns the runs it spawns. */
function fakeRuns(svc: LocalVerifyService, heads: Record<number, string>, pidBase: number): { runs: Run[]; seams: LocalVerifyServiceSeams } {
  const seams = (svc as unknown as { seams: LocalVerifyServiceSeams }).seams;
  const runs: Run[] = [];
  seams.prView = async (pr) => (heads[pr] ? { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: heads[pr], baseRefName: 'main', baseRefOid: sha('b') } : null);
  seams.baseHead = async () => sha('b');
  seams.isPrOpen = async () => true;
  seams.foreignSuiteHolders = () => [];
  seams.isGroupAlive = () => false;
  seams.killGroup = () => {};
  seams.spawnRun = (a) => {
    let end!: Run['end'];
    const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { end = r; });
    runs.push({ input: JSON.parse(fs.readFileSync(a.args[a.args.indexOf('--input') + 1], 'utf-8')) as VerifyRunInput, resultPath: a.args[a.args.indexOf('--result') + 1], end });
    return { pid: pidBase + runs.length, exited };
  };
  return { runs, seams };
}

/** A failed record for the run with this input (it carries the verifier version and policy the service gave its child). */
function failedRecordFor(input: VerifyRunInput, files: string[]): LocalVerifyRecord {
  const now = Date.now();
  return {
    repo: input.repo, pr: input.pr, headSha: input.headSha, baseSha: input.baseSha, baseRefName: input.baseRefName, mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 2, failed: 1, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: input.nodeVersion, machineId: input.machineId, startedAt: new Date(now - 60_000).toISOString(), finishedAt: new Date(now - 30_000).toISOString(),
    outcome: 'failure', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: input.verifierVersion, policyHash: input.policyHash, failedFiles: files,
  };
}

const until = async (cond: () => boolean, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end && !cond();) await new Promise((r) => setTimeout(r, 10)); };

describe('first parts lifecycle (production wiring)', () => {
  it('the built dist ships the modules the run child needs', () => {
    for (const name of ['firstPart.js', 'likelyFailingList.js', 'firstPartTrial.js']) {
      expect(fs.existsSync(path.join(path.dirname(DIST_ENTRY), name)), name).toBe(true);
    }
  });

  it('alive over HTTP: off by default, the setting is read live through the production switch wiring, and the brake writes `off` through it', async () => {
    const { home, stateDir } = sourceCheckout();
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
    });
    expect(built.reason).toBeNull();
    const svc = built.service!;
    const values: Record<string, unknown> = {};
    const writes: Array<[string, unknown]> = [];
    wireLocalVerifySwitches(svc, {
      get: <T,>(k: string, fb: T): T => (k in values ? (values[k] as T) : fb),
      set: (k: string, v: unknown) => { writes.push([k, v]); values[k] = v; },
    });
    await svc.boot();
    const app = serve(ctx(stateDir, svc));
    // Feature is alive: 200, not 503, and the read surface is there with the default.
    const first = await request(app).get('/local-verify');
    expect(first.status).toBe(200);
    expect(first.body.likelyFailingFirst).toMatchObject({ setting: 'off', list: { files: 0, problem: null, top: [] } });
    // Read live at each call: no restart between these.
    values['monitoring.localVerify.likelyFailingFirst'] = 'alternate';
    expect((await request(app).get('/local-verify')).body.likelyFailingFirst.setting).toBe('alternate');
    values['monitoring.localVerify.likelyFailingFirst'] = 'on';
    expect((await request(app).get('/local-verify')).body.likelyFailingFirst.setting).toBe('on');
    values['monitoring.localVerify.likelyFailingFirst'] = 'sometimes';
    expect((await request(app).get('/local-verify')).body.likelyFailingFirst.setting).toBe('off');
    // Wiring integrity: the off-writer is the live config's own setter, not a no-op.
    const off = (svc as unknown as { likelyFailingFirstOff: (() => void) | null }).likelyFailingFirstOff;
    expect(typeof off).toBe('function');
    off!();
    expect(writes).toEqual([['monitoring.localVerify.likelyFailingFirst', 'off']]);
    expect(svc.likelyFailingFirst()).toBe('off');
    svc.shutdown();
  });

  it('a config without a setter still wires the reader; the brake then rests on the trial state file', async () => {
    const { home, stateDir } = sourceCheckout();
    const svc = buildLocalVerifyService({
      config: { enabled: true }, expectedGhLogin: 'EchoOfDawn', repo: 'JKHeadley/instar',
      repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
    }).service!;
    wireLocalVerifySwitches(svc, { get: <T,>(k: string, fb: T): T => (k === 'monitoring.localVerify.likelyFailingFirst' ? 'on' as T : fb) });
    expect(svc.likelyFailingFirst()).toBe('on');
    expect((svc as unknown as { likelyFailingFirstOff: (() => void) | null }).likelyFailingFirstOff).toBeNull();
    svc.shutdown();
  });

  it('the list store is real and shared: a recorded failure is written where the service reads it, and reaches the next run child’s input', async () => {
    const { home, stateDir } = sourceCheckout();
    const svc = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
    }).service!;
    const values: Record<string, unknown> = { 'monitoring.localVerify.likelyFailingFirst': 'on' };
    wireLocalVerifySwitches(svc, { get: <T,>(k: string, fb: T): T => (k in values ? (values[k] as T) : fb) });
    // Wiring integrity: one real store object, at the path the state registry names.
    const listFile = path.join(stateDir, 'state', 'local-verify', 'likely-failing.json');
    expect(svc.likelyFailing).toBeInstanceOf(LikelyFailingStore);
    expect(svc.likelyFailing.file).toBe(listFile);
    const { runs } = fakeRuns(svc, { 3: sha('a'), 4: sha('c') }, 9300);
    await svc.boot();
    // PR 3 fails on F1: recorded through the production completion path.
    expect((await svc.request(3, { explicit: true })).ok).toBe(true);
    await until(() => runs.length === 1);
    expect(runs).toHaveLength(1);
    expect(runs[0].input.likelyFailingFirst).toMatchObject({ setting: 'on', list: [], previous: [] });
    fs.writeFileSync(runs[0].resultPath, JSON.stringify({ kind: 'record', record: failedRecordFor(runs[0].input, [F1]), reasons: [`file-failed:${F1}:1`], overlaps: [], keptWorktree: null }));
    runs[0].end({ status: 0, signal: null });
    await svc.whenIdle();
    // Written where the service reads it.
    expect(fs.existsSync(listFile)).toBe(true);
    expect(Object.keys((JSON.parse(fs.readFileSync(listFile, 'utf-8')) as { files: Record<string, unknown> }).files)).toEqual([F1]);
    // A second reader on the same path (as after a restart) sees what the recorder wrote.
    expect(new LikelyFailingStore(listFile, () => Date.now(), () => {}).listFor(4)).toEqual([F1]);
    // The next verify's child gets it: recorder and run input share the store.
    expect((await svc.request(4, { explicit: true })).ok).toBe(true);
    await until(() => runs.length === 2);
    expect(runs[1].input).toMatchObject({ pr: 4 });
    expect(runs[1].input.likelyFailingFirst).toMatchObject({ setting: 'on', list: [F1], previous: [] });
    // And PR 3's own next verify gets F1 as its previous failure, not from the list.
    expect(svc.firstPartFor(3)).toMatchObject({ list: [], previous: [F1] });
    const body = (await request(serve(ctx(stateDir, svc))).get('/local-verify')).body;
    expect(body.likelyFailingFirst.list).toMatchObject({ files: 1, problem: null });
    expect(body.likelyFailingFirst.list.top[0]).toMatchObject({ file: F1, prs: 1 });
    svc.shutdown();
  });

  it('a verify handed to a peer over real HTTP carries the list; the peer runs it under its own setting and never builds a list', async () => {
    const coord = sourceCheckout();
    const peerHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvfirst-peer-e2e-')));
    dirs.push(peerHome);
    const peerStateDir = path.join(peerHome, '.instar');
    fs.mkdirSync(peerStateDir);
    const coordinator = buildLocalVerifyService({
      config: { enabled: true }, expectedGhLogin: 'EchoOfDawn', repo: 'JKHeadley/instar',
      repoPath: coord.home, stateDir: coord.stateDir, agentHome: coord.home, machineId: 'm_coord', mainEntry: DIST_ENTRY,
    }).service!;
    const peer = buildLocalVerifyService({
      config: { enabled: true, peer: { enabled: true } }, expectedGhLogin: 'EchoOfDawn', repo: 'JKHeadley/instar',
      repoPath: peerHome, stateDir: peerStateDir, agentHome: peerHome, machineId: 'm_peer', mainEntry: DIST_ENTRY,
    }).service!;
    const heads = { 3: sha('a'), 5: sha('c') };
    const c = fakeRuns(coordinator, heads, 9400);
    const p = fakeRuns(peer, heads, 9500);
    // The two machines differ, as in the trial: the coordinator's switch is off, the peer's is on.
    wireLocalVerifySwitches(coordinator, { get: <T,>(_k: string, fb: T): T => fb });
    wireLocalVerifySwitches(peer, { get: <T,>(k: string, fb: T): T => (k === 'monitoring.localVerify.likelyFailingFirst' ? 'on' as T : fb) });
    await pairPeerIdentity(peerStateDir, coord.stateDir, 'm_peer');
    wireLocalVerifyPeers(peer, {
      liveConfig: { get: <T,>(k: string, fb: T): T => (k === 'monitoring.localVerify.peer.enabled' ? true as T : fb) },
      authToken: 'test-token', agentId: 'echo', stateDir: peerStateDir,
      lease: { holdsLease: () => false, leaseEpoch: () => 7, holderMachineId: () => 'm_coord' },
    });
    const peerContext = { ...ctx(peerStateDir, peer), coordinator: { holdsLease: () => false, getSyncStatus: () => ({ leaseHolder: 'm_coord', leaseEpoch: 7 }) } } as never;
    const server = http.createServer(serve(peerContext));
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const peerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // No peer is offered work until the list has something in it.
    let peers: unknown[] = [];
    wireLocalVerifyPeers(coordinator, {
      liveConfig: { get: <T,>(k: string, fb: T): T => (k === 'monitoring.localVerify.peers' ? peers as T : fb) },
      authToken: 'test-token', agentId: 'echo', stateDir: coord.stateDir,
      lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'm_coord' },
    });
    await coordinator.boot();
    await peer.boot();
    // The coordinator verifies PR 5 itself; it fails on F1 and F2, which enters the coordinator's list.
    expect((await coordinator.request(5, { explicit: true })).ok).toBe(true);
    await until(() => c.runs.length === 1);
    expect(c.runs).toHaveLength(1);
    expect('likelyFailingFirst' in c.runs[0].input).toBe(false); // its own setting is off
    fs.writeFileSync(c.runs[0].resultPath, JSON.stringify({ kind: 'record', record: failedRecordFor(c.runs[0].input, [F2, F1].sort()), reasons: [], overlaps: [], keptWorktree: null }));
    c.runs[0].end({ status: 0, signal: null });
    await coordinator.whenIdle();
    expect(coordinator.likelyFailing.listFor(3).sort()).toEqual([F1, F2].sort());
    // Now the coordinator's own slot is taken, so PR 3 goes to the peer.
    c.seams.foreignSuiteHolders = () => [{ pid: 9001 }];
    peers = [{ machineId: 'm_peer', url: peerUrl }];
    expect((await coordinator.request(3, { explicit: true })).ok).toBe(true);
    await until(() => p.runs.length === 1);
    expect(p.runs).toHaveLength(1);
    // The peer's run child got the coordinator's list and assignment, under the PEER's setting.
    const block = p.runs[0].input.likelyFailingFirst!;
    expect(block.setting).toBe('on');
    expect([...block.list].sort()).toEqual([F1, F2].sort());
    expect(block.previous).toEqual([]);
    expect(block.group === 'with' || block.group === 'without').toBe(true);
    expect(block.group).toBe(coordinator.firstPartFor(3).group); // the coordinator's one assignment of PR 3
    // The peer never built a list of its own.
    expect(fs.existsSync(path.join(peerStateDir, 'state', 'local-verify', 'likely-failing.json'))).toBe(false);
    expect(fs.existsSync(path.join(peerStateDir, 'state', 'local-verify', 'first-part-groups.json'))).toBe(false);
    expect((await request(serve(ctx(coord.stateDir, coordinator))).get('/local-verify')).body.peers.reserved)
      .toEqual([expect.objectContaining({ pr: 3, state: 'accepted' })]);
    coordinator.shutdown();
    peer.shutdown();
  });
});
