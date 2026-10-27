import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ScriptCanaryRunner, canaryVariantsFor, startFixtureStub, writeStubProber, scriptCanaryConditionKey, type ScriptCanaryRunnerDeps } from '../../src/scheduler/ScriptCanaryRunner.js';
import { parseScriptOutput, type ParsedScriptRun } from '../../src/scheduler/jobScriptProtocol.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/ScriptCanaryRunner.test.ts' }); });

function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-')); dirs.push(d); return d; }

type Call = { slug: string; serverUrl: string; extraArgs?: string[]; env?: Record<string, string> };

/** A fake "script" that behaves like a correct converted script: fails on a bad response. */
async function honestScript(serverUrl: string): Promise<ParsedScriptRun> {
  try {
    const res = await fetch(serverUrl + '/health');
    const text = await res.text();
    if (res.status !== 200) return parseScriptOutput('JOB_RESULT failed http-' + res.status, 1, {});
    JSON.parse(text);
    return parseScriptOutput('JOB_RESULT ok fine', 0, {});
  } catch {
    return parseScriptOutput('JOB_RESULT failed malformed', 1, {});
  }
}

function harness(opts: { jobs: Array<Record<string, unknown>>; behaviour?: (c: Call) => Promise<ParsedScriptRun> }) {
  const root = tmp();
  const calls: Call[] = [];
  const raised: Array<Record<string, unknown>> = [];
  const cleared: string[] = [];
  const history: Array<Record<string, unknown>> = [];
  let n = 0;
  let now = Date.parse('2026-10-26T12:00:00Z');
  const deps: ScriptCanaryRunnerDeps = {
    scheduler: {
      listScriptJobs: () => opts.jobs as never,
      runScriptCanary: async (slug, o) => {
        const c = { slug, ...o };
        calls.push(c);
        const parsed = opts.behaviour ? await opts.behaviour(c) : await honestScript(o.serverUrl);
        return { parsed, exitCode: parsed.result === 'failure' ? 1 : 0, stdout: '' };
      },
    },
    history: {
      recordStart: (o) => { const runId = `${o.slug}-r${n++}`; history.push({ ...o, runId }); return runId; },
      recordCompletion: (o) => { history.push({ ...o, completed: true }); },
    },
    machineId: 'm-1',
    stateDir: root,
    logsDir: path.join(root, 'logs'),
    raiseAttention: (i) => { raised.push(i as never); },
    clearAttention: (k) => { cleared.push(k); },
    now: () => now,
  };
  return { deps, calls, raised, cleared, history, root, advance: (ms: number) => { now += ms; } };
}

describe('ScriptCanaryRunner', () => {
  it('serves the fixture on a loopback ephemeral port', async () => {
    const stub = await startFixtureStub({ status: 500, body: 'x' });
    try {
      const u = new URL(stub.url);
      expect(u.hostname).toBe('127.0.0.1');
      expect(Number(u.port)).toBeGreaterThan(0);
      const r = await fetch(stub.url + '/anything');
      expect(r.status).toBe(500);
      expect(await r.text()).toBe('x');
    } finally { await stub.close(); }
  });

  it('stub prober exits with the requested code', () => {
    const p = writeStubProber(tmp(), 2);
    let code = 0;
    try { execFileSync(process.execPath, [p]); } catch (e) { code = (e as { status: number }).status; }
    expect(code).toBe(2);
  });

  it('a passing pass records script-canary runs, audits with runId and clears the item', async () => {
    const h = harness({ jobs: [{ slug: 'llm-decision-grading', runner: 'script' }] });
    const report = await new ScriptCanaryRunner(h.deps).tick();
    expect(report?.failingSlugs).toEqual([]);
    expect(h.calls).toHaveLength(2); // server-500 + malformed-body
    expect(h.history.filter(r => r.trigger === 'script-canary')).toHaveLength(2);
    expect(h.history.filter(r => r.completed).every(r => r.result === 'success')).toBe(true);
    const audit = fs.readFileSync(path.join(h.root, 'logs', 'job-anomaly.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(audit).toHaveLength(2);
    expect(audit.every(a => a.kind === 'script-canary' && typeof a.runId === 'string')).toBe(true);
    expect(h.cleared).toEqual([scriptCanaryConditionKey('m-1')]);
    expect(h.raised).toHaveLength(0);
  });

  it('a script that always reports ok fails its canary', async () => {
    const h = harness({ jobs: [{ slug: 'x', runner: 'script' }], behaviour: async () => parseScriptOutput('JOB_RESULT ok always', 0, {}) });
    const report = await new ScriptCanaryRunner(h.deps).tick();
    expect(report?.failingSlugs).toEqual(['x']);
    expect(h.history.filter(r => r.completed).every(r => r.result === 'failure')).toBe(true);
  });

  it('many failing jobs raise ONE item per machine, refreshed on change, cleared when all pass', async () => {
    let broken = new Set(['a', 'b']);
    const behaviour = async (c: Call) => broken.has(c.slug) ? parseScriptOutput('JOB_RESULT ok always', 0, {}) : honestScript(c.serverUrl);
    const h = harness({ jobs: [{ slug: 'a', runner: 'script' }, { slug: 'b', runner: 'script' }, { slug: 'c', runner: 'script' }], behaviour });
    const runner = new ScriptCanaryRunner(h.deps);
    const r1 = await runner.tick();
    expect(r1?.failingSlugs).toEqual(['a', 'b']);
    expect(h.raised).toHaveLength(1);
    expect(h.raised[0]).toMatchObject({ conditionKey: 'script-canary:m-1', priority: 'HIGH', source: 'agent' });
    expect(String(h.raised[0].summary)).toContain('- a:');
    expect(String(h.raised[0].summary)).toContain('- b:');

    h.advance(25 * 3600_000);
    await runner.tick();
    expect(h.raised).toHaveLength(1); // unchanged list → no re-raise

    broken = new Set(['a']);
    h.advance(25 * 3600_000);
    await runner.tick();
    expect(h.raised).toHaveLength(2);
    expect(h.raised[1].conditionKey).toBe('script-canary:m-1');
    expect(String(h.raised[1].summary)).not.toContain('- b:');

    broken = new Set();
    h.advance(25 * 3600_000);
    await runner.tick();
    expect(h.cleared).toEqual(['script-canary:m-1']);
  });

  it('runs at most once a day; only tick() starts it', async () => {
    const h = harness({ jobs: [{ slug: 'x', runner: 'script' }] });
    const runner = new ScriptCanaryRunner(h.deps);
    expect(await runner.tick()).not.toBeNull();
    const n = h.calls.length;
    h.advance(3600_000);
    expect(await runner.tick()).toBeNull();
    expect(h.calls.length).toBe(n);
    // A fresh process reads the machine-local marker and still waits.
    expect(await new ScriptCanaryRunner(h.deps).tick()).toBeNull();
    const publicMethods = Object.getOwnPropertyNames(ScriptCanaryRunner.prototype).filter(k => k !== 'constructor' && !k.startsWith('private'));
    expect(publicMethods.filter(k => /enable|^start|^run$|^runAll$/i.test(k))).toEqual([]);
  });

  it('cannot be enabled or redirected from the manifest, config or environment', async () => {
    const prev = process.env.INSTAR_SCRIPT_CANARY;
    process.env.INSTAR_SCRIPT_CANARY = '1';
    try {
      const h = harness({ jobs: [{
        slug: 'health-check', runner: 'script', scriptSupervision: 'deterministic',
        canary: true, canaryArgs: ['--server-url', 'http://evil.example'],
        execute: { type: 'script', value: 'health-check.mjs --canary --server-url http://evil.example' },
      }] });
      // Constructing the runner with the env set does nothing on its own.
      new ScriptCanaryRunner(h.deps);
      await new Promise(r => setTimeout(r, 20));
      expect(h.calls).toHaveLength(0);
      await new ScriptCanaryRunner(h.deps).tick();
      expect(h.calls.length).toBeGreaterThan(0);
      for (const c of h.calls) {
        expect(new URL(c.serverUrl).hostname).toBe('127.0.0.1');
        expect(c.extraArgs?.join(' ')).not.toContain('evil');
        expect(c.env).toEqual({ INSTAR_SCRIPT_CANARY: '1' });
      }
      const expected = canaryVariantsFor({ slug: 'health-check' } as never).map(v => ['--canary', ...(v.flags ?? [])]);
      expect(h.calls.map(c => c.extraArgs)).toEqual(expected);
    } finally {
      if (prev === undefined) delete process.env.INSTAR_SCRIPT_CANARY; else process.env.INSTAR_SCRIPT_CANARY = prev;
    }
  });

  it('prober scripts get a stub prober per exit code; the real prober never runs', async () => {
    const h = harness({ jobs: [{ slug: 'stall-matrix-live-check', runner: 'script' }], behaviour: async (c) => {
      const i = c.extraArgs!.indexOf('--prober');
      expect(i).toBeGreaterThan(-1);
      const p = c.extraArgs![i + 1];
      const tmpRoot = fs.realpathSync(os.tmpdir());
      expect(p.startsWith(os.tmpdir()) || fs.realpathSync(p).startsWith(tmpRoot)).toBe(true);
      let code = 0;
      try { execFileSync(process.execPath, [p]); } catch (e) { code = (e as { status: number }).status; }
      if (code === 2) return parseScriptOutput('JOB_RESULT skipped ledger-unreachable', 0, {});
      if (code !== 0) return parseScriptOutput('JOB_RESULT failed prober-' + code, 1, {});
      return honestScript(c.serverUrl);
    } });
    const report = await new ScriptCanaryRunner(h.deps).tick();
    expect(report?.failingSlugs).toEqual([]);
    expect(h.calls.length).toBe(4);
    expect(h.calls.every(c => c.extraArgs!.includes('--prober'))).toBe(true);
  });

  it('health-check drives the episode harness and the floor, both sides', async () => {
    const floorCalls: Array<{ consecutiveFailures: number; mode: string }> = [];
    const episodeRuns: string[] = [];
    const behaviour = async (c: Call): Promise<ParsedScriptRun> => {
      const res = await fetch(c.serverUrl + '/health');
      if (res.status !== 200) return parseScriptOutput('JOB_RESULT failed http-500', 1, {});
      const disk = Number(c.extraArgs![c.extraArgs!.indexOf('--disk-free-override') + 1]);
      const lines = ['JOB_ANOMALY llm-unreliable 2 degraded', 'JOB_ANOMALY degradation:canary-fixture 1 x'];
      if (disk < 5) lines.unshift('JOB_ANOMALY disk-critical 3 3% free');
      lines.push('JOB_RESULT ok checked');
      return parseScriptOutput(lines.join('\n'), 0, { anomalies: [
        { kind: 'disk-critical', class: 'critical' }, { kind: 'llm-unreliable', class: 'recoverable' }, { kind: 'degradation:*', class: 'recoverable' },
      ] });
    };
    const h = harness({ jobs: [{ slug: 'health-check', runner: 'script', scriptSupervision: 'triage' }], behaviour });
    h.deps.episodeHarness = (runId, reasons, clock) => {
      episodeRuns.push(runId);
      const t0 = clock.now(); clock.advance(6 * 3600_000);
      return { ok: reasons.some(r => r.class === 'critical') && clock.now() - t0 === 6 * 3600_000, failures: ['no critical push'] };
    };
    h.deps.floorFn = ({ parsed, consecutiveFailures, mode }) => {
      floorCalls.push({ consecutiveFailures, mode });
      if (parsed.anomalies.some(a => a.class === 'critical')) return 'needs_session';
      if (parsed.result === 'failure' && consecutiveFailures >= 1) return 'needs_session';
      return 'routine';
    };
    const report = await new ScriptCanaryRunner(h.deps).tick();
    expect(report?.failingSlugs).toEqual([]);
    expect(episodeRuns).toHaveLength(1);
    expect(floorCalls.every(c => c.mode === 'audit-only')).toBe(true);
    expect(floorCalls).toHaveLength(4);

    // A floor that never asks for a session fails the canary.
    h.advance(25 * 3600_000);
    h.deps.floorFn = () => 'routine';
    const bad = await new ScriptCanaryRunner(h.deps).tick();
    expect(bad?.failingSlugs).toEqual(['health-check']);
  });

  it('missing wiring is a failing canary, never a silent pass', async () => {
    const h = harness({ jobs: [{ slug: 'commitment-checkin-reminder', runner: 'script', scriptSupervision: 'triage' }] });
    const report = await new ScriptCanaryRunner(h.deps).tick();
    expect(report?.failingSlugs).toEqual(['commitment-checkin-reminder']);
    expect(report?.outcomes.some(o => o.problems.some(p => p.includes('floor not wired')))).toBe(true);
  });

  it('a deterministic script is never fed to the floor', async () => {
    let called = 0;
    const h = harness({ jobs: [{ slug: 'llm-decision-grading', runner: 'script', scriptSupervision: 'deterministic' }] });
    h.deps.floorFn = () => { called++; return 'routine'; };
    await new ScriptCanaryRunner(h.deps).tick();
    expect(called).toBe(0);
  });
});
