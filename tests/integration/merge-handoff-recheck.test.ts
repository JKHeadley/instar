// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration tests for the local-verify routes over the real HTTP
 * pipeline (in-process createRoutes + a real LocalVerifyService on a temp
 * state dir; only the child process and gh are fakes). Spec
 * docs/specs/local-verify-merge-authority.md §2.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type PrView, type MergeHandoffResult } from '../../src/localVerify/LocalVerifyService.js';
import { LOCAL_VERIFY_LIMITS, computePolicyHash } from '../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../src/localVerify/record.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'merge-handoff-recheck.test.ts' }); });

function baseCtx(stateDir: string, over: Partial<RouteContext>): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null,
    startTime: new Date(),
    ...over,
  } as never;
}

function view(over: Partial<PrView> = {}): PrView {
  return { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b'), ...over };
}

function record(): LocalVerifyRecord {
  return {
    repo: REPO, pr: 7, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(),
  };
}

function setup(views: Record<number, PrView>, existingStateDir?: string) {
  const stateDir = existingStateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvroutes-')));
  if (!existingStateDir) dirs.push(stateDir);
  if (!existingStateDir) {
    const healthDir = path.join(stateDir, 'state', 'local-verify');
    fs.mkdirSync(healthDir, { recursive: true });
    fs.writeFileSync(path.join(healthDir, 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null,
      reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z',
    }));
  }
  const children: Array<{ resultPath: string; inputPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const priorities: boolean[] = [];
  let holders: number[] = [];
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, {
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async () => true, baseHead: async () => sha('b'),
    spawnRun: (a) => {
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      children.push({ resultPath: a.args[a.args.indexOf('--result') + 1], inputPath: a.args[a.args.indexOf('--input') + 1], resolve });
      return { pid: 90_000 + children.length, exited };
    },
    isGroupAlive: () => false,
    killGroup: () => {},
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => holders.map((pid) => ({ pid })),
    suiteCapacity: () => 1,
    setSuitePriority: (active) => { priorities.push(active); },
    setTimer: () => {},
  });
  return { stateDir, svc, children, priorities, setHolders: (next: number[]) => { holders = next; } };
}

// Exercise the real route middleware without opening a listening socket.
async function getStatus(stateDir: string, svc: LocalVerifyService) {
  const router = createRoutes(baseCtx(stateDir, { localVerify: svc }));
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    let status = 200;
    const headers = new Map<string, unknown>();
    const res = {
      status(code: number) { status = code; return this; },
      json(body: unknown) { resolve({ status, body }); return this; },
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
      getHeader(name: string) { return headers.get(name.toLowerCase()); },
      removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    };
    router.handle({ method: 'GET', url: '/local-verify', originalUrl: '/local-verify', headers: {} } as never, res as never,
      (err?: unknown) => reject(err ?? new Error('route fell through')));
  });
}

describe('merge hand-off re-check counts on GET /local-verify', () => {
  it.each([[true, true], [false, true], [false, false]])('counts UNKNOWN, recovery=%s, re-check=%s, and hold-active separately', async (merged, recheckEntered) => {
    const s = setup({ 7: view(), 9: view() });
    let answer!: (r: MergeHandoffResult) => void;
    s.svc.setMergeHandoff(() => new Promise((resolve) => { answer = resolve; }));
    const before = await getStatus(s.stateDir, s.svc);
    expect(before.status).toBe(200);
    expect(before.body.mergeLine).toMatchObject({ unknownHandoffs: 0, recoveredHandoffs: 0, holdActiveSkips: 0 });
    await s.svc.request(7);
    fs.writeFileSync(s.children[0].resultPath, JSON.stringify({ kind: 'record', record: record(), reasons: [], overlaps: [], keptWorktree: null }));
    s.children[0].resolve({ status: 0, signal: null });
    await s.svc.whenIdle();
    await new Promise((r) => setImmediate(r));
    // A derived green record for the same verified tree arrives while the hold is open.
    expect(await s.svc.request(9)).toMatchObject({ ok: true, status: 'recorded' });
    expect((await getStatus(s.stateDir, s.svc)).body.mergeLine.holdActiveSkips).toBe(1);
    answer({ acted: merged, reason: merged ? 'merged' : 'handoff-not-eligible:not-mergeable-unknown', firstMergeable: 'UNKNOWN', recheckEntered, recheckReads: recheckEntered ? 1 : 0, recheckSeconds: recheckEntered ? 5 : 0 });
    await new Promise((r) => setImmediate(r));
    expect((await getStatus(s.stateDir, s.svc)).body.mergeLine).toMatchObject({ handoffs: 1, unknownHandoffs: 1, recoveredHandoffs: merged ? 1 : 0, holdActiveSkips: 1, hold: null });
    const rows = fs.readFileSync(s.svc.auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const start = rows.find((row) => row.event === 'merge-handoff');
    expect(rows.find((row) => row.event === 'merge-handoff-result')).toMatchObject({ handoffStartedAt: start.handoffStartedAt, firstMergeable: 'UNKNOWN', recheckEntered, recheckReads: recheckEntered ? 1 : 0, recheckSeconds: recheckEntered ? 5 : 0, recovered: merged });
    s.svc.shutdown();
  });
});
