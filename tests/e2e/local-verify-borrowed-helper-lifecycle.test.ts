// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 lifecycle (docs/specs/local-verify-borrowed-unit-slices.md, Tests "E2E lifecycle"): a run
 * machine and a helper on the production path, on one host.
 *
 *  - Helper: built by buildHelperRuntime, the function server.ts calls, served through createRoutes.
 *    Dark (404) until `monitoring.localVerify.helper.enabled`, then alive (200). Its slices run directly
 *    on the host through the named TEST-ONLY seam `sandbox: 'test-bypass'` (HOME pointed elsewhere);
 *    helperWiring.test.ts proves production setup can never select it. GitHub and the tree source are
 *    test doubles (no network); the signer and key lookup are the production ones over real paired
 *    machine identities.
 *  - Run machine: a LocalVerifyService whose shadow client is wired by wireBorrowedShadow (the
 *    server.ts function, real HTTP client, real audit log), riding one `main` verify (the run child is
 *    a fake), with the tree-reading seams replaced. The record is written first; then the comparison
 *    lands as one `borrowed-shadow` audit row, including the known-red canary.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { buildHelperRuntime, type HelperRuntime } from '../../src/localVerify/helper/helperWiring.js';
import { TestBypassDriver } from '../../src/localVerify/helper/testBypassDriver.js';
import { wireBorrowedShadow } from '../../src/localVerify/localVerifyWiring.js';
import { LocalVerifyService, type LocalVerifyServiceSeams } from '../../src/localVerify/LocalVerifyService.js';
import { BORROWED_CANARY, BORROWED_CANARY_FILES } from '../../src/localVerify/borrowedCanary.js';
import { computePolicyHash } from '../../src/localVerify/policy.js';
import type { FileCounts } from '../../src/localVerify/laneReport.js';
import type { VerifyRunResult } from '../../src/localVerify/orchestrator.js';
import { FakeGitHub, FakeOwner, MemoryTrees, UNIT_A, UNIT_TMUX, treeFiles } from '../helpers/borrowedHelperFixture.js';

const AUTH = 'e2e-token';
const HELPER_ID = 'm_e2e_helper';
const RUN_ID = 'm_e2e_run';
const HEAD = 'e'.repeat(40);
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-borrowed-helper-lifecycle.test.ts' });
});

const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d; };

/** Real machine identities, renamed and pinned both ways (the way pairing does). */
async function pair(aDir: string, aId: string, bDir: string, bId: string): Promise<void> {
  const idOf = async (dir: string, id: string) => {
    await new MachineIdentityManager(dir).generateIdentity({ name: id });
    const own = path.join(dir, 'machine', 'identity.json');
    const identity = { ...JSON.parse(fs.readFileSync(own, 'utf-8')), machineId: id };
    fs.writeFileSync(own, JSON.stringify(identity));
    return identity;
  };
  const a = await idOf(aDir, aId);
  const b = await idOf(bDir, bId);
  const pin = (dir: string, id: string, identity: unknown) => {
    const p = path.join(dir, 'machines', id, 'identity.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(identity));
  };
  pin(aDir, bId, b);
  pin(bDir, aId, a);
}

function ctx(stateDir: string, helper: HelperRuntime): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null, localVerify: null, localVerifyHelper: helper,
    startTime: new Date(),
  } as never;
}

async function listen(c: RouteContext): Promise<string> {
  const a = express();
  a.use(express.json({ limit: '8mb' }));
  a.use(authMiddleware(() => AUTH, 'echo'));
  a.use(createRoutes(c));
  const s = http.createServer(a);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', () => r(null)));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** The on-host slice: a vitest-shaped report for the requested files (canary files answer their seeded outcomes). */
const bypass = () => new TestBypassDriver({
  runSlice: async ({ treeDir, files, env }) => {
    expect(env.HOME).not.toBe(os.homedir()); // HOME pointed elsewhere
    const testResults = files.map((f) => {
      const e = BORROWED_CANARY[f] ?? { passed: 2, failed: 0, skipped: 0, todo: 0 };
      const statuses = [...Array(e.passed).fill('passed'), ...Array(e.failed).fill('failed'), ...Array(e.skipped).fill('skipped'), ...Array(e.todo).fill('todo')];
      return { name: path.join(treeDir, f), status: e.failed ? 'failed' : 'passed', startTime: 1, endTime: 101, assertionResults: statuses.map((s, i) => ({ title: `t${i}`, status: s, failureMessages: s === 'failed' ? ['x'] : [] })) };
    });
    return { exitCode: testResults.some((t) => t.status === 'failed') ? 1 : 0, reportText: JSON.stringify({ testResults }) };
  },
});

describe('borrowed helper lifecycle (production wiring, test-bypass seam)', () => {
  it('the helper role is dark (404) until enabled, then alive over HTTP (200)', async () => {
    const helperDir = tmp('lvbh-');
    let helperCfg: unknown = null;
    const runtime = buildHelperRuntime({
      liveConfig: { get: <T>(k: string, fb: T): T => (k === 'monitoring.localVerify.helper' ? helperCfg as T : fb) },
      stateDir: helperDir, sandbox: 'test-bypass', testBypassDriver: bypass(),
      overrides: { github: new FakeGitHub(), trees: new MemoryTrees({}), ownerLoad: new FakeOwner(), allowLoopback: true },
    });
    const url = await listen(ctx(helperDir, runtime));
    const H = { Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'echo' };
    expect((await request(url).get('/local-verify/helper-status').set(H)).status).toBe(404);
    helperCfg = { enabled: true, pinnedRepoUrl: 'https://github.com/JKHeadley/instar', pinnedRequesters: [RUN_ID] };
    const alive = await request(url).get('/local-verify/helper-status').set(H);
    expect(alive.status).toBe(200);
    expect(alive.body).toMatchObject({ enabled: true, paused: false, sandbox: { kind: 'test-bypass' } });
    runtime.shutdown();
  });

  it('a main verify on the run machine shadows a helper end to end: prepare, slices, canary, record first, then one borrowed-shadow row', async () => {
    const helperDir = tmp('lvbh-');
    const runDir = tmp('lvbr-');
    await pair(helperDir, HELPER_ID, runDir, RUN_ID);

    const files = { ...treeFiles(), ...Object.fromEntries(BORROWED_CANARY_FILES.map((f) => [f, "it('c', () => {});\n"])) };
    const trees = new MemoryTrees({ [HEAD]: files });
    const github = new FakeGitHub();
    github.onMain.set(HEAD, true);
    const runtime = buildHelperRuntime({
      liveConfig: { get: <T>(k: string, fb: T): T => (k === 'monitoring.localVerify.helper' ? { enabled: true, pinnedRepoUrl: 'https://github.com/JKHeadley/instar', pinnedRequesters: [RUN_ID] } as T : fb) },
      stateDir: helperDir, sandbox: 'test-bypass', testBypassDriver: bypass(),
      overrides: { github, trees, ownerLoad: new FakeOwner(), hostFreeBytes: async () => 1024 ** 4, allowLoopback: true },
    });
    const helperUrl = await listen(ctx(helperDir, runtime));

    // The run machine: its own main verify, with the shadow wired the way server.ts wires it.
    fs.mkdirSync(path.join(runDir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({ v: 1, machineId: RUN_ID, state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: new Date().toISOString() }));
    const spawned: Array<{ resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
    const seams: LocalVerifyServiceSeams = {
      prView: async () => null, isPrOpen: async () => true,
      spawnRun: (a) => {
        let resolve!: (x: { status: number | null; signal: string | null }) => void;
        const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
        spawned.push({ resultPath: a.args[a.args.indexOf('--result') + 1], resolve });
        return { pid: 9100 + spawned.length, exited };
      },
      isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [], isAncestor: async () => false, setTimer: () => {},
    };
    const svc = new LocalVerifyService({
      repo: 'JKHeadley/instar', stateDir: runDir, agentHome: runDir, expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
      verifierVersion: '1.0.0', nodePath: process.execPath, mainEntry: '/opt/x/runVerifyMain.js', remoteUrl: 'https://github.com/JKHeadley/instar.git',
      machineId: RUN_ID, nodeVersion: process.version, protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
    }, seams);
    const local = new Map<string, FileCounts>([[UNIT_A, { passed: 2, failed: 0, skipped: 0, todo: 0, ms: 3000 }]]);
    let recordWritten = false;
    await wireBorrowedShadow(svc, {
      liveConfig: { get: <T>(k: string, fb: T): T => (k === 'monitoring.localVerify.borrowed' ? { mode: 'shadow', helpers: [{ machineId: HELPER_ID, url: helperUrl }] } as T : fb) },
      stateDir: runDir, agentHome: runDir, machineId: RUN_ID, authToken: AUTH, agentId: 'echo', version: 'e2e',
      treeSeams: {
        // A long excluded file makes the projected unit lane long enough to send the eligible one.
        unitFiles: async () => [{ file: UNIT_A, ms: 3000 }, { file: UNIT_TMUX, ms: 2_000_000 }],
        treeReader: () => ({ read: async (f) => files[f as keyof typeof files] ?? null }),
        localUnitReport: async () => { expect(recordWritten).toBe(true); return local; },
      },
    });

    svc.noteMainHead(HEAD);
    expect(spawned.length).toBe(1);
    const audit = () => fs.existsSync(path.join(runDir, 'logs', 'local-verify.jsonl'))
      ? fs.readFileSync(path.join(runDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    // Wait for the helper to have run both slices (the eligible one and the canary), then finish the run.
    const helperAudit = () => fs.existsSync(path.join(helperDir, 'logs', 'local-verify.jsonl')) ? fs.readFileSync(path.join(helperDir, 'logs', 'local-verify.jsonl'), 'utf-8') : '';
    for (let i = 0; i < 600 && !helperAudit().includes('"helper-cancel"'); i++) await new Promise((r) => setTimeout(r, 50));
    expect(helperAudit()).toContain('"helper-prepared"');
    const record = {
      repo: 'JKHeadley/instar', pr: 0, headSha: HEAD, baseSha: HEAD, baseRefName: 'main', mergeTree: 'd'.repeat(40), kind: 'main' as const,
      lanes: [{ name: 'unit' as const, gating: true, files: 1, tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
      nodeVersion: process.version, machineId: RUN_ID, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      outcome: 'success' as const, harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false, verifierVersion: '1.0.0', policyHash: computePolicyHash(),
    };
    const result: VerifyRunResult = { kind: 'record', record, reasons: [], overlaps: [], keptWorktree: null };
    fs.writeFileSync(spawned[0].resultPath, JSON.stringify(result));
    recordWritten = true;
    spawned[0].resolve({ status: 0, signal: null });
    await new Promise((r) => setImmediate(r));
    await svc.settle();
    for (let i = 0; i < 200 && !audit().some((a) => a.event === 'borrowed-shadow'); i++) await new Promise((r) => setTimeout(r, 25));

    expect(audit().some((a) => a.event === 'main-record' && a.outcome === 'success')).toBe(true);
    const row = audit().find((a) => a.event === 'borrowed-shadow')!;
    expect(row).toMatchObject({
      src: 'borrowed', helper: HELPER_ID, recorded: true, compared: true, done: 2, agree: 1, invalidAnswers: 0,
      canary: { compared: 5, falseGreen: 0, falseRed: 0 }, breakerOutcome: 'good',
    });
    expect(audit().some((a) => a.event === 'borrowed-shadow-error')).toBe(false);
    expect(svc.mainRunObserverInfo()).toMatchObject({ mode: 'shadow', helpers: [{ machineId: HELPER_ID }] });
    svc.shutdown();
    runtime.shutdown();
  }, 60_000);
});
