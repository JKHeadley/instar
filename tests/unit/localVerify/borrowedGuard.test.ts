// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Guard (docs/specs/local-verify-borrowed-unit-slices.md, "Using helper results": invariant): shadow
 * mode has exactly one use for a helper result, comparison. No helper result reaches `evaluateRun`.
 *
 *  1. Static: no borrowed / helper module calls or imports `evaluateRun` (or the orchestrator's run
 *     entry); the verifier's own import graph (VERIFIER_ROOTS, which decides what a record means)
 *     contains no borrowed / helper module; LocalVerifyService imports the observer for types only.
 *  2. Runtime: a `main` verify with a throwing borrowed client and with a silent (never-answering)
 *     one writes the same record, outcome and finish time as with borrowed mode off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { lex } from '../../../src/localVerify/borrowedEligibility.js';
import { VERIFIER_ROOTS, localImportGraph } from '../../../src/localVerify/verifierVersion.js';
import { LocalVerifyService, type LocalVerifyServiceSeams } from '../../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunResult } from '../../../src/localVerify/orchestrator.js';
import type { MainRunObserver } from '../../../src/localVerify/mainRunObserver.js';
import { BorrowedShadow } from '../../../src/localVerify/BorrowedShadow.js';
import type { HelperClient } from '../../../src/localVerify/borrowedClient.js';
import { machineKeys, pins } from '../../helpers/borrowedHelperFixture.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LV = path.join(ROOT, 'src', 'localVerify');
const borrowedModules = (): string[] => [
  ...fs.readdirSync(path.join(LV, 'helper')).filter((f) => f.endsWith('.ts')).map((f) => path.join(LV, 'helper', f)),
  ...fs.readdirSync(LV).filter((f) => /^(borrowed|Borrowed)\w*\.ts$|^mainRunObserver\.ts$/.test(f)).map((f) => path.join(LV, f)),
];

describe('static: no helper result can reach evaluateRun', () => {
  it('no borrowed or helper module calls or imports evaluateRun, runVerify or the run child', () => {
    const files = borrowedModules();
    expect(files.length).toBeGreaterThan(15);
    for (const f of files) {
      const code = lex(fs.readFileSync(f, 'utf-8')).codeOnly;
      expect(code, path.basename(f)).not.toMatch(/\bevaluateRun\b/);
      expect(code, path.basename(f)).not.toMatch(/\brunVerify\b/);
      expect(code, path.basename(f)).not.toMatch(/runVerifyMain/);
    }
  });

  it('the verifier\'s own import graph (what decides a record) contains no borrowed or helper module', () => {
    const roots = VERIFIER_ROOTS.map((r) => path.join(LV, `${r}.ts`));
    const graph = localImportGraph(roots).map((f) => path.relative(ROOT, f));
    expect(graph).toContain('src/localVerify/LocalVerifyService.ts');
    expect(graph.filter((f) => /localVerify\/(helper\/|borrowed|BorrowedShadow|mainRunObserver)/.test(f))).toEqual([]);
  });

  it('LocalVerifyService imports the observer for types only, and nothing else of the borrowed path', () => {
    const src = fs.readFileSync(path.join(LV, 'LocalVerifyService.ts'), 'utf-8');
    expect(src).toContain("import type { MainRunEnd, MainRunObserver, MainRunStart } from './mainRunObserver.js';");
    expect(src).not.toMatch(/from '\.\/(helper\/|borrowed|BorrowedShadow)/);
  });
});

// ── runtime: identical record with a throwing / silent client ──────────────────────────────

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'borrowedGuard.test.ts' }); });

function mainRecord(head: string): LocalVerifyRecord {
  return {
    repo: REPO, pr: 0, headSha: head, baseSha: head, baseRefName: 'main', mergeTree: sha('d'), kind: 'main',
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-11-18T10:00:00.000Z', finishedAt: '2026-11-18T10:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(),
  };
}

async function runMainVerify(observer: MainRunObserver | null) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvguard-')));
  dirs.push(stateDir);
  fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({ v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-11-18T00:00:00.000Z' }));
  const spawned: Array<{ resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  let t = Date.parse('2026-11-18T13:00:00.000Z');
  const seams: LocalVerifyServiceSeams = {
    prView: async () => null, isPrOpen: async () => true,
    spawnRun: (a) => {
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      spawned.push({ resultPath: a.args[a.args.indexOf('--result') + 1], resolve });
      return { pid: 7000 + spawned.length, exited };
    },
    isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [],
    isAncestor: async () => false, now: () => t, setTimer: () => {},
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/x/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, seams);
  if (observer) svc.setMainRunObserver(observer);
  svc.noteMainHead(sha('e'));
  expect(spawned.length).toBe(1);
  t += 40 * 60_000;
  const result: VerifyRunResult = { kind: 'record', record: mainRecord(sha('e')), reasons: [], overlaps: [], keptWorktree: null };
  fs.writeFileSync(spawned[0].resultPath, JSON.stringify(result));
  spawned[0].resolve({ status: 0, signal: null });
  await new Promise((r) => setImmediate(r));
  await svc.settle();
  await new Promise((r) => setImmediate(r));
  const audit = fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const strip = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.src !== 'borrowed' && !String(r.event).startsWith('borrowed'));
  const health = svc.mainHealth();
  return { audit: strip(audit), health: { state: health.state, lastGreenHead: (health as { lastGreenHead?: unknown }).lastGreenHead ?? null }, snapshot: { ...svc.snapshot(), records: svc.snapshot().records } };
}

function shadow(client: HelperClient, stateDir: string, sink: Array<Record<string, unknown>> = []): BorrowedShadow {
  const studio = machineKeys('m1');
  return new BorrowedShadow({
    config: () => ({ mode: 'shadow', helpers: [{ machineId: 'm_laptop', url: 'http://100.64.0.9:4042' }] }),
    client, signer: studio.signer, keyLookup: () => pins(studio), machineId: 'm1', stateDir, version: 'v', localWorkers: 4,
    unitFiles: async () => [{ file: 'tests/unit/a.test.ts', ms: 1000 }],
    treeReader: () => ({ read: async () => "it('x', () => {});" }),
    localUnitReport: async () => new Map(),
    audit: (e) => { sink.push(e); },
    sleep: (ms, signal) => new Promise((r) => { const tt = setTimeout(r, Math.min(ms, 5)); signal?.addEventListener('abort', () => { clearTimeout(tt); r(); }, { once: true }); }),
  });
}

describe('runtime: a failing or silent borrowed client leaves the main verify identical', () => {
  it('the record, its outcome and its finish time match borrowed mode off, with a throwing and with a silent client', async () => {
    const off = await runMainVerify(null);
    const throwing: HelperClient = {
      slice: async () => { throw new Error('boom'); }, cancel: async () => { throw new Error('boom'); },
      learned: async () => { throw new Error('boom'); }, status: async () => { throw new Error('boom'); },
    };
    const never = <T,>() => new Promise<T>(() => {});
    const silent: HelperClient = { slice: () => never(), cancel: () => never(), learned: () => never(), status: () => never() };
    const observerThrows: MainRunObserver = { onMainRunStart: () => { throw new Error('sync boom'); }, onMainRunEnd: () => { throw new Error('sync boom'); } };
    const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvguard-sh-')));
    dirs.push(stateDir);
    const sink: Array<Record<string, unknown>> = [];
    const throwingShadow = shadow(throwing, stateDir, sink);
    for (const obs of [throwingShadow, shadow(silent, stateDir), observerThrows]) {
      const withClient = await runMainVerify(obs);
      expect(withClient.health).toEqual(off.health);
      expect(withClient.audit.filter((r) => r.event === 'main-record')).toEqual(off.audit.filter((r) => r.event === 'main-record'));
      expect(withClient.audit.filter((r) => r.event !== 'borrowed-shadow-error')).toEqual(off.audit);
      expect(withClient.snapshot.inFlight).toEqual(off.snapshot.inFlight);
    }
    // The shadow really ran on that verify: the throwing client's failure was caught and audited.
    await new Promise((r) => setTimeout(r, 20));
    expect(sink.some((e) => e.event === 'borrowed-shadow-error' || e.event === 'borrowed-shadow')).toBe(true);
  });
});
