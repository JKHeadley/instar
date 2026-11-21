// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * LocalVerifyService and a verify of a waiting change with a borrowed helper (spec
 * docs/specs/local-verify-borrowed-slices-count.md, F "Where the exchange runs", "The record"):
 *  - the run input carries the seam's child input (port, the verify's own token, the baselines),
 *    and nothing when the seam offers none;
 *  - after the record is written the seam hears the lane flow's result, once;
 *  - a record naming the helper the verify STARTED with is kept even when the setting was switched
 *    off in the middle of the verify (stage 4's open item), and a record naming another helper is not.
 * Real fs in a temp state dir; the child process, gh and the clock are fakes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type LocalVerifyServiceSeams, type PrView } from '../../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunInput, VerifyRunResult } from '../../../src/localVerify/orchestrator.js';
import type { BorrowedRunSeam, BorrowedVerifyResult } from '../../../src/localVerify/mainRunObserver.js';
import type { BorrowedFlowResult } from '../../../src/localVerify/borrowedLaneFlow.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'borrowedServiceVerify.test.ts' }); });

const view = (): PrView => ({ author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b') });
const record = (over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord => ({
  repo: REPO, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
  lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
  nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-21T12:00:30.000Z', finishedAt: '2026-10-21T12:20:00.000Z',
  outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
  verifierVersion: '1.0.0', policyHash: computePolicyHash(), ...over,
});
const FLOW: BorrowedFlowResult = { helper: 'm_laptop', assigned: 'counting', treeHash: sha('d'), lanes: {}, sentFiles: { unit: ['tests/unit/x.test.ts'] }, disagreements: 0 };
const BORROWED_FIELD = { helper: 'm_laptop', assigned: 'counting' as const, lanes: [{ lane: 'unit' as const, files: 1, filesDigest: 'a'.repeat(64) }] };

function seam(state: { configured: boolean }) {
  const results: BorrowedVerifyResult[] = [];
  const s: BorrowedRunSeam = {
    childInput: (token) => (state.configured ? { port: 4042, token, baselines: [] } : null),
    helperFor: () => (state.configured ? 'm_laptop' : null),
    onVerifyResult: (e) => { results.push(e); },
    onMainRed: () => {},
    onVerifyStart: () => {}, onVerifyEnd: () => {}, wantsMainFileCounts: () => false, onGreenMain: () => {},
    peerStatusExtras: () => ({}), onPeerStatus: () => {},
    // The setting is read live: once it is off, no helper is "known".
    knownHelper: (h) => state.configured && h === 'm_laptop',
    tick: () => {}, info: () => null,
    proxy: async () => ({ status: 404, body: {} }), decide: () => ({ status: 404, body: {} }), dryRun: () => ({ status: 404, body: {} }),
    helperHere: () => ({ status: 404, body: {} }), acceptPeerBaseline: () => ({ status: 404, body: {} }),
  };
  return { s, results };
}

function setup() {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvbsv-')));
  dirs.push(stateDir);
  fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({ v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z' }));
  const spawned: Array<{ input: VerifyRunInput; resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const records: LocalVerifyRecord[] = [];
  const seams: LocalVerifyServiceSeams = {
    prView: async () => view(), isPrOpen: async () => true, baseHead: async () => sha('b'),
    spawnRun: (a) => {
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      const inputPath = a.args[a.args.indexOf('--input') + 1];
      spawned.push({ input: JSON.parse(fs.readFileSync(inputPath, 'utf-8')) as VerifyRunInput, resultPath: a.args[a.args.indexOf('--result') + 1], resolve });
      return { pid: 7000 + spawned.length, exited };
    },
    isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [],
    onRecord: (r) => { records.push(r); }, now: () => Date.parse('2026-10-21T12:30:00.000Z'), setTimer: () => {},
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24', protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' },
  }, seams);
  const flush = async () => { for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r)); };
  const finish = async (result: VerifyRunResult) => {
    const s = spawned[spawned.length - 1];
    fs.writeFileSync(s.resultPath, JSON.stringify(result));
    s.resolve({ status: 0, signal: null });
    await flush();
  };
  return { svc, spawned, records, flush, finish };
}

describe('a verify of a waiting change with a borrowed helper', () => {
  it('the run input carries the child input with the verify\'s own token; the seam hears the flow\'s result once the record is written', async () => {
    const h = setup();
    const state = { configured: true };
    const b = seam(state);
    h.svc.setBorrowedRunSeam(b.s);
    await h.svc.request(1, { explicit: true });
    await h.flush();
    const inp = h.spawned[0].input;
    expect(inp.borrowed).toMatchObject({ port: 4042, baselines: [] });
    expect(inp.borrowed!.token).toMatch(/^[0-9a-f]{32}$/);
    await h.finish({ kind: 'record', record: record({ borrowed: BORROWED_FIELD }), reasons: [], overlaps: [], keptWorktree: null, borrowed: FLOW });
    expect(h.records.map((r) => r.borrowed?.helper)).toEqual(['m_laptop']);
    expect(b.results).toEqual([{ token: inp.borrowed!.token, pr: 1, headSha: sha('a'), outcome: 'success', flow: FLOW }]);
  });

  it('the setting switched off in the middle of the verify: the record naming the helper it started with is kept', async () => {
    const h = setup();
    const state = { configured: true };
    h.svc.setBorrowedRunSeam(seam(state).s);
    await h.svc.request(1, { explicit: true });
    await h.flush();
    state.configured = false;
    await h.finish({ kind: 'record', record: record({ borrowed: BORROWED_FIELD }), reasons: [], overlaps: [], keptWorktree: null, borrowed: FLOW });
    expect(h.records).toHaveLength(1);
    expect(h.records[0].borrowed?.helper).toBe('m_laptop');
  });

  it('a record naming a helper this verify did not start with is rejected; no seam offers nothing to the child', async () => {
    const h = setup();
    h.svc.setBorrowedRunSeam(seam({ configured: false }).s);
    await h.svc.request(1, { explicit: true });
    await h.flush();
    expect('borrowed' in h.spawned[0].input).toBe(false);
    await h.finish({ kind: 'record', record: record({ borrowed: { ...BORROWED_FIELD, helper: 'm_other' } }), reasons: [], overlaps: [], keptWorktree: null });
    expect(h.records).toHaveLength(0);
  });
});
