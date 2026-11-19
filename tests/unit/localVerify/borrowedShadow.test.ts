// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: the run machine's shadow client (docs/specs/local-verify-borrowed-unit-slices.md, F) driving a
 * real HelperService in-process (FakeSandboxDriver underneath): prepare-then-poll, eligible slices plus
 * the canary at a random position, cancel at the end, comparison only after the record is written,
 * the learned-list report, the `borrowed-shadow` audit row, mode off doing nothing, failures caught
 * as `borrowed-shadow-error`, and the unreachable breaker skipping a helper.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { BorrowedShadow, type BorrowedShadowDeps } from '../../../src/localVerify/BorrowedShadow.js';
import { parseHelperStatus, type HelperClient } from '../../../src/localVerify/borrowedClient.js';
import { BORROWED_CANARY, BORROWED_CANARY_FILES } from '../../../src/localVerify/borrowedCanary.js';
import type { FileCounts } from '../../../src/localVerify/laneReport.js';
import { HEAD, UNIT_A, UNIT_B, UNIT_SCAN, UNIT_TMUX, helperRig, pins, type HelperRig } from '../../helpers/borrowedHelperFixture.js';
import { vitestReport } from '../../helpers/fakeSandboxDriver.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'borrowedShadow.test.ts' }); });

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};

/** An in-process client: every call goes straight to the helper service, through JSON like the wire. */
function inProcessClient(r: HelperRig, calls: string[]): HelperClient {
  const wire = (x: unknown) => JSON.parse(JSON.stringify(x));
  return {
    async slice(_h, body) { calls.push((body as { prepare?: boolean }).prepare ? 'prepare' : 'slice'); const a = await r.svc.handleSlice(wire(body), r.route); return { status: a.status, body: wire(a.body) }; },
    async cancel(_h, body) { calls.push('cancel'); const a = await r.svc.handleCancel(wire(body), r.route); return { status: a.status, body: wire(a.body) }; },
    async learned(_h, body) { calls.push('learned'); const a = await r.svc.handleLearned(wire(body), r.route); return { status: a.status, body: wire(a.body) }; },
    async status() { calls.push('status'); return parseHelperStatus(wire(r.svc.status())); },
  };
}

function setup(o: { mode?: 'off' | 'shadow'; dryRun?: boolean; client?: (r: HelperRig, calls: string[]) => HelperClient; unitFiles?: BorrowedShadowDeps['unitFiles'] } = {}) {
  const r = helperRig({}, dirs);
  for (const f of BORROWED_CANARY_FILES) r.trees.files[HEAD][f] = "it('c', () => {});\n";
  // The helper's runner: canary files answer their seeded outcomes; A passes; B fails.
  r.driver.slice = async (files) => {
    const m: Record<string, Array<'passed' | 'failed' | 'skipped' | 'todo'>> = {};
    for (const f of files) {
      const e = BORROWED_CANARY[f];
      m[f] = e ? [...Array(e.passed).fill('passed'), ...Array(e.failed).fill('failed'), ...Array(e.skipped).fill('skipped'), ...Array(e.todo).fill('todo')] : f === UNIT_B ? ['passed', 'failed'] : ['passed', 'passed'];
    }
    return { exitCode: Object.values(m).some((s) => s.includes('failed')) ? 1 : 0, resultText: vitestReport(r.driver.root, m) };
  };
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvshadow-')));
  dirs.push(stateDir);
  const audits: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const local = new Map<string, FileCounts>([[UNIT_A, { passed: 2, failed: 0, skipped: 0, todo: 0, ms: 3000 }], [UNIT_B, { passed: 2, failed: 0, skipped: 0, todo: 0, ms: 3000 }]]);
  let recorded = false;
  const shadow = new BorrowedShadow({
    config: () => ({ mode: o.mode ?? 'shadow', helpers: [{ machineId: 'm_laptop', url: 'http://100.64.0.9:4042' }], ...(o.dryRun ? { dryRun: true } : {}) }),
    client: (o.client ?? inProcessClient)(r, calls),
    signer: r.requester.signer,
    keyLookup: () => pins(r.helperKeys),
    machineId: 'm_studio', stateDir, version: 'run-v', localWorkers: 4,
    // A long excluded file makes the projected unit lane long enough to send the small eligible files.
    unitFiles: o.unitFiles ?? (async () => [{ file: UNIT_A, ms: 3000 }, { file: UNIT_B, ms: 3000 }, { file: UNIT_SCAN, ms: 100_000 }, { file: UNIT_TMUX, ms: 2_000_000 }]),
    treeReader: () => ({ read: async (f) => r.trees.files[HEAD][f] ?? null }),
    localUnitReport: async () => { if (!recorded) throw new Error('read before the record was written'); return local; },
    audit: (e) => audits.push(e),
    now: () => r.clock.t,
    sleep: (_ms, signal) => new Promise((res) => { const t = setTimeout(res, 2); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); }),
    random: () => 0.99,
  });
  const end = (token: string, rec = true) => { recorded = rec; shadow.onMainRunEnd({ headSha: HEAD, runToken: token, recorded: rec, outcome: rec ? 'success' : null, cancelled: !rec }); };
  return { r, shadow, audits, calls, end, stateDir };
}

describe('BorrowedShadow', () => {
  it('prepares, polls until ready, sends eligible slices and the canary, cancels, then compares after the record and reports', async () => {
    const s = setup();
    s.shadow.onMainRunStart({ headSha: HEAD, runToken: 'tok1', startedAt: s.r.clock.t });
    await waitFor(() => s.calls.includes('cancel'));
    expect(s.calls.filter((c) => c === 'slice').length).toBe(2); // one slice of A+B, then the canary (random → last)
    expect(s.audits.some((a) => a.event === 'borrowed-shadow')).toBe(false); // not before the record is written
    s.end('tok1');
    await waitFor(() => s.audits.some((a) => a.event === 'borrowed-shadow'));
    const row = s.audits.find((a) => a.event === 'borrowed-shadow')!;
    expect(row).toMatchObject({
      helper: 'm_laptop', recorded: true, compared: true, done: 2, agree: 1, invalidAnswers: 0,
      disagree: { files: [{ file: UNIT_B, direction: 'helper-red/local-green' }], total: 1 },
      canary: { compared: 5, falseGreen: 0, falseRed: 0 }, prepNotReady: false, runVersion: 'run-v', helperVersion: '1.3.1903',
      breakerOutcome: 'good', scanHits: 1, eligibleFiles: 2,
    });
    expect(row.scanIneligibleShare).toBeGreaterThan(0);
    expect(s.audits.some((a) => a.event === 'scan-hit' && a.file === UNIT_SCAN && a.pattern === 'homedir-call')).toBe(true);
    expect(s.calls).toContain('learned'); // B's difference reported to the helper's learned list
    expect(s.r.audits.some((a) => a.event === 'helper-learned')).toBe(true);
    expect((s.shadow.info() as { helpers: Array<{ lastShadow: unknown; countedRuns: number }> }).helpers[0]).toMatchObject({ countedRuns: 1 });
    expect(fs.existsSync(path.join(s.stateDir, 'state', 'local-verify', 'borrowed-helpers.json'))).toBe(true);
  });

  it('the dry run sends every eligible file on a green tree, and its differences enter the learned list from one', async () => {
    const s = setup({ dryRun: true, unitFiles: async () => [{ file: UNIT_A, ms: 3000 }, { file: UNIT_B, ms: 3000 }] });
    s.shadow.onMainRunStart({ headSha: HEAD, runToken: 'dry', startedAt: s.r.clock.t });
    await waitFor(() => s.calls.includes('cancel'));
    s.end('dry');
    await waitFor(() => s.audits.some((a) => a.event === 'borrowed-shadow'));
    expect(s.audits.find((a) => a.event === 'borrowed-shadow')).toMatchObject({ dryRun: true, dryRunCovered: 2, agree: 1 });
    const learned = (s.r.svc.status() as { learned: { entries: Array<{ file: string; source: string }> } }).learned.entries;
    expect(learned.map((e) => [e.file, e.source])).toEqual([[UNIT_B, 'dry-run']]);
  });

  it('does nothing while mode is off', async () => {
    const s = setup({ mode: 'off' });
    s.shadow.onMainRunStart({ headSha: HEAD, runToken: 'tok', startedAt: s.r.clock.t });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.calls).toEqual([]);
  });

  it('a run that ends without a record is audited as not compared and never reads the local report', async () => {
    const s = setup();
    s.shadow.onMainRunStart({ headSha: HEAD, runToken: 'tok2', startedAt: s.r.clock.t });
    await waitFor(() => s.calls.includes('cancel'));
    s.end('tok2', false);
    await waitFor(() => s.audits.some((a) => a.event === 'borrowed-shadow'));
    expect(s.audits.find((a) => a.event === 'borrowed-shadow')).toMatchObject({ recorded: false, compared: false });
    expect(s.audits.some((a) => a.event === 'borrowed-shadow-error')).toBe(false);
  });

  it('every failure is caught and audited borrowed-shadow-error, never thrown', async () => {
    const s = setup({ unitFiles: async () => { throw new Error('ls-tree failed'); } });
    expect(() => s.shadow.onMainRunStart({ headSha: HEAD, runToken: 'tok3', startedAt: s.r.clock.t })).not.toThrow();
    await waitFor(() => s.audits.some((a) => a.event === 'borrowed-shadow-error'));
    expect(s.audits.find((a) => a.event === 'borrowed-shadow-error')).toMatchObject({ step: 'run', helper: 'm_laptop', detail: 'ls-tree failed' });
    s.end('tok3');
  });

  it('a helper unreachable three runs in a row is skipped, reported once', async () => {
    const dead: HelperClient = { slice: async () => null, cancel: async () => null, learned: async () => null, status: async () => null };
    const s = setup({ client: (_r, calls) => ({ ...dead, status: async () => { calls.push('status'); return null; } }) });
    for (let i = 0; i < 4; i++) {
      s.shadow.onMainRunStart({ headSha: HEAD, runToken: `t${i}`, startedAt: s.r.clock.t });
      s.end(`t${i}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(s.calls.filter((c) => c === 'status').length).toBe(3);
    expect(s.audits.filter((a) => a.event === 'helper-unreachable').length).toBe(1);
  });
});
