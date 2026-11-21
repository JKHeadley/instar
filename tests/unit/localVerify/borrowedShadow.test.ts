// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: the run machine's shadow client (docs/specs/local-verify-borrowed-unit-slices.md, F) driving a
 * real HelperService in-process (FakeSandboxDriver underneath): prepare-then-poll, eligible slices plus
 * the canary at a random position, cancel at the end, comparison only after the record is written,
 * the learned-list report, the `borrowed-shadow` audit row, mode off doing nothing, failures caught
 * as `borrowed-shadow-error`, and the asking rate (docs/specs/local-verify-borrowed-slices-count.md, F
 * "Asking the helper"): one status request per verify with a 2-second limit and a whole-status
 * signature that must hold; after 10 unanswered in a row only every 5th verify asks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { BorrowedShadow, type BorrowedShadowDeps } from '../../../src/localVerify/BorrowedShadow.js';
import { parseHelperStatus, type HelperClient } from '../../../src/localVerify/borrowedClient.js';
import { ASK_LIMITS } from '../../../src/localVerify/borrowedAsk.js';
import { BORROWED_CANARY, BORROWED_CANARY_FILES } from '../../../src/localVerify/borrowedCanary.js';
import { parseVitestJson, type FileCounts } from '../../../src/localVerify/laneReport.js';
import { HEAD, UNIT_A, UNIT_B, UNIT_SCAN, UNIT_TMUX, helperRig, memoryTreeHash, pins, type HelperRig } from '../../helpers/borrowedHelperFixture.js';
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
    async status(_h, _signal, query) { calls.push('status'); return parseHelperStatus(wire(r.svc.status({ ...(query?.run ? { runAttemptId: query.run } : {}), ...(query?.since !== undefined ? { sinceSeq: query.since } : {}) }))); },
  };
}

function setup(o: { mode?: 'off' | 'practice' | 'count'; dryRun?: boolean; client?: (r: HelperRig, calls: string[]) => HelperClient; unitFiles?: BorrowedShadowDeps['unitFiles'] } = {}) {
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
    config: () => ({ mode: o.mode ?? 'practice', helpers: [{ machineId: 'm_laptop', url: 'http://100.64.0.9:4042' }], ...(o.dryRun ? { dryRun: true } : {}) }),
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
  // The main verify's own merge tree and per-file counts (the service hands both over with the end).
  const digest = (f: string) => parseVitestJson(vitestReport(r.driver.root, { [f]: ['passed', 'passed'] }), r.driver.root, { outcomeDigest: true }).files.get(f)!.outcomeDigest!;
  const fileCounts = Object.fromEntries([UNIT_A, UNIT_B].map((f) => [f, [2, 0, 0, 0, digest(f)] as [number, number, number, number, string]]));
  const end = (token: string, rec = true) => { recorded = rec; shadow.onMainRunEnd({ headSha: HEAD, runToken: token, recorded: rec, outcome: rec ? 'success' : null, cancelled: !rec, ...(rec ? { mergeTree: memoryTreeHash(r.trees.files[HEAD]), fileCounts } : {}) }); };
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
      // The scan records and does not block: the file with a scan hit is eligible (A, B and it), and
      // its hit is still counted and audited. (It is not sent in this run only because its 100 s is
      // over the planner's long-file bound.) The Mac-only file stays out.
      helperOutcome: 'good', scanHits: 1, eligibleFiles: 3,
    });
    expect(row.scanHitShare).toBeGreaterThan(0);
    expect(s.audits.some((a) => a.event === 'scan-hit' && a.file === UNIT_SCAN && a.pattern === 'homedir-call')).toBe(true);
    expect(s.calls).toContain('learned'); // B's difference reported to the helper's learned list
    expect(s.r.audits.some((a) => a.event === 'helper-learned')).toBe(true);
    expect((s.shadow.info() as { helpers: Array<{ lastShadow: unknown; countedRuns: number }> }).helpers[0]).toMatchObject({ countedRuns: 1 });
    expect(fs.existsSync(path.join(s.stateDir, 'state', 'local-verify', 'borrowed-helpers.json'))).toBe(true);
  });

  it('the dry run sends every eligible file on a green tree; a file the helper failed there is a first comparison, not yet on the learned list', async () => {
    const s = setup({ dryRun: true, unitFiles: async () => [{ file: UNIT_A, ms: 3000 }, { file: UNIT_B, ms: 3000 }] });
    s.shadow.onMainRunStart({ headSha: HEAD, runToken: 'dry', startedAt: s.r.clock.t });
    await waitFor(() => s.calls.includes('cancel'));
    s.end('dry');
    await waitFor(() => s.audits.some((a) => a.event === 'borrowed-shadow'));
    expect(s.audits.find((a) => a.event === 'borrowed-shadow')).toMatchObject({ dryRun: true, dryRunCovered: 2, agree: 1 });
    // The amended rule: the helper failing where the run machine passed joins on the second comparison in a row.
    const learned = (s.r.svc.status() as { learned: { entries: Array<{ file: string }>; candidates: number } }).learned;
    expect([learned.entries, learned.candidates]).toEqual([[], 1]);
    expect(s.r.audits.find((a) => a.event === 'helper-learned')).toMatchObject({ treeHash: memoryTreeHash(s.r.trees.files[HEAD]), candidates: 1, added: 0 });
  });

  it('does nothing while mode is off', async () => {
    const s = setup({ mode: 'off' });
    s.shadow.onMainRunStart({ headSha: HEAD, runToken: 'tok', startedAt: s.r.clock.t });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.calls).toEqual([]);
  });

  it('observes main verifies in count mode exactly as in practice: every request is a merged commit, the check slice or compare-only, never count', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const s = setup({ mode: 'count', client: (r, calls) => { const c = inProcessClient(r, calls); return { ...c, slice: async (h, body, ms, signal) => { seen.push(JSON.parse(JSON.stringify(body))); return c.slice(h, body, ms, signal); } }; } });
    s.shadow.onMainRunStart({ headSha: HEAD, runToken: 'cnt', startedAt: s.r.clock.t });
    await waitFor(() => s.calls.includes('cancel'));
    s.end('cnt');
    await waitFor(() => s.audits.some((a) => a.event === 'borrowed-shadow'));
    expect(s.audits.find((a) => a.event === 'borrowed-shadow')).toMatchObject({ recorded: true, compared: true, invalidAnswers: 0, canary: { compared: 5 } });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const b of seen) expect(b).toMatchObject({ lane: 'unit', baseSha: HEAD, headSha: HEAD });
    expect(seen.filter((b) => b.prepare).every((b) => b.use === undefined)).toBe(true);
    expect(seen.filter((b) => !b.prepare).map((b) => b.use).sort()).toEqual(expect.arrayContaining(['check', 'compare']));
    expect(seen.some((b) => b.use === 'count')).toBe(false);
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

  it('asks once per verify with the 2-second limit, before anything else, and reads the answer only when its signature holds', async () => {
    const timeouts: Array<number | undefined> = [];
    const s = setup({ client: (r, calls) => { const c = inProcessClient(r, calls); return { ...c, status: async (h, signal, query, timeoutMs) => { timeouts.push(timeoutMs); return c.status(h, signal, query, timeoutMs); } }; } });
    s.shadow.onMainRunStart({ headSha: HEAD, runToken: 'ask1', startedAt: s.r.clock.t });
    await waitFor(() => s.calls.includes('cancel'));
    s.end('ask1');
    await waitFor(() => s.audits.some((a) => a.event === 'borrowed-shadow'));
    expect(s.calls[0]).toBe('status');
    expect(timeouts[0]).toBe(ASK_LIMITS.statusTimeoutMs);
    expect((s.shadow.info() as { helpers: Array<{ asking: unknown }> }).helpers[0].asking).toEqual({ unanswered: 0, silentSince: null, skippedSinceAsk: 0 });
  });

  it('a status answer whose signature does not hold is no answer: nothing is sent and the silence is counted', async () => {
    // The same answer with one field changed after signing.
    const s = setup({ client: (r, calls) => { const c = inProcessClient(r, calls); return { ...c, status: async () => { calls.push('status'); return parseHelperStatus({ ...JSON.parse(JSON.stringify(r.svc.status())), paused: true }); } }; } });
    s.shadow.onMainRunStart({ headSha: HEAD, runToken: 'bad', startedAt: s.r.clock.t });
    s.end('bad');
    await waitFor(() => s.audits.some((a) => a.event === 'borrowed-status-refused'));
    expect(s.audits.find((a) => a.event === 'borrowed-status-refused')).toMatchObject({ helper: 'm_laptop', reason: 'signature-bad' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.calls.filter((c) => c !== 'status')).toEqual([]);
    expect((s.shadow.info() as { helpers: Array<{ asking: { unanswered: number } }> }).helpers[0].asking.unanswered).toBe(1);
  });

  it('a silent helper is asked on each of 10 verifies, then only on every 5th; the slowdown is audited once', async () => {
    const dead: HelperClient = { slice: async () => null, cancel: async () => null, learned: async () => null, status: async () => null };
    const s = setup({ client: (_r, calls) => ({ ...dead, status: async () => { calls.push('status'); return null; } }) });
    const asked = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const before = s.calls.length;
        s.shadow.onMainRunStart({ headSha: HEAD, runToken: `t${before}-${i}-${Math.random()}`, startedAt: s.r.clock.t });
        await new Promise((r) => setTimeout(r, 10));
      }
      return s.calls.filter((c) => c === 'status').length;
    };
    expect(await asked(10)).toBe(10); // every verify
    expect(await asked(4)).toBe(10); // the next four are passed over
    expect(await asked(1)).toBe(11); // the 5th asks
    expect(await asked(4)).toBe(11);
    expect(await asked(1)).toBe(12);
    expect(s.audits.filter((a) => a.event === 'borrowed-asking-slowed').length).toBe(1);
    expect(s.calls.filter((c) => c !== 'status')).toEqual([]);
  });
});
