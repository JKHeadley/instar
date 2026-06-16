/**
 * Tier-1 tests for DefaultMergeRunner (green-pr-automerge §3.1/R5, Step 4).
 * Fake spawn + fs round-trip: contract probe, pre-exec hash pin, two-phase
 * in-flight record, deadline-kill, B10 independent confirm, result parsing,
 * and orphan reap (alive / dead / pid-less).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import path from 'node:path';

import {
  DefaultMergeRunner,
  parseResultLine,
  type SpawnArgs,
  type SpawnOutcome,
  type InFlightRecord,
} from '../../src/monitoring/MergeRunner.js';

let dir: string;
let scriptPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-runner-'));
  scriptPath = path.join(dir, 'safe-merge.mjs');
  fs.writeFileSync(scriptPath, '// fake safe-merge contract v2\n');
});
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ignore */ } });

const baseCfg = () => ({
  stateDir: dir,
  repo: 'JKHeadley/instar',
  safeMergePath: scriptPath,
  mergeTimeoutMs: 1000,
  mergeKillGraceMs: 100,
  expectedContractVersion: 2,
});

function fakeSpawn(map: { capabilities?: SpawnOutcome; merge?: SpawnOutcome }) {
  return async (a: SpawnArgs): Promise<SpawnOutcome> => {
    if (a.args.includes('--capabilities')) {
      return map.capabilities ?? { stdout: JSON.stringify({ contract: 2 }), stderr: '', status: 0, signal: null, deadlineKilled: false, pid: 111 };
    }
    if (a.onPid) a.onPid(222); // simulate phase-2 patch
    return map.merge ?? { stdout: 'safe-merge-result: {"result":"merged"}', stderr: '', status: 0, signal: null, deadlineKilled: false, pid: 222 };
  };
}

describe('parseResultLine', () => {
  it('extracts the classified result from the last result line', () => {
    expect(parseResultLine('noise\nsafe-merge-result: {"result":"refused:red-checks"}\n')).toBe('refused:red-checks');
  });
  it('returns null when no result line is present', () => {
    expect(parseResultLine('just some output')).toBeNull();
  });
});

describe('DefaultMergeRunner — contract probe + hash pin', () => {
  it('probes the contract and pins the script hash', async () => {
    const r = new DefaultMergeRunner(baseCfg(), { spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN' });
    const p = await r.probeContract();
    expect(p.ok).toBe(true);
    expect(p.version).toBe(2);
  });

  it('refuses a contract-version mismatch', async () => {
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({ capabilities: { stdout: JSON.stringify({ contract: 99 }), stderr: '', status: 0, signal: null, deadlineKilled: false, pid: 1 } }),
      confirmMerged: async () => true, prState: async () => 'OPEN',
    });
    expect((await r.probeContract()).ok).toBe(false);
  });

  it('refuses to run if the script hash changed between probe and exec', async () => {
    const r = new DefaultMergeRunner(baseCfg(), { spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN' });
    await r.probeContract();
    fs.writeFileSync(scriptPath, '// TAMPERED\n'); // swap after probe
    const result = await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(result.outcome).toBe('skipped:safe-merge-contract');
  });
});

describe('DefaultMergeRunner — run', () => {
  it('writes a two-phase in-flight record and clears it after', async () => {
    let pidAtPhase2: number | null = null;
    const spawn = async (a: SpawnArgs): Promise<SpawnOutcome> => {
      if (a.args.includes('--capabilities')) return { stdout: JSON.stringify({ contract: 2 }), stderr: '', status: 0, signal: null, deadlineKilled: false, pid: 1 };
      // Phase 1 record exists with null pid before onPid.
      const before = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'green-pr-automerge-inflight.json'), 'utf-8')) as InFlightRecord;
      expect(before.pid).toBeNull();
      a.onPid?.(222);
      const after = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'green-pr-automerge-inflight.json'), 'utf-8')) as InFlightRecord;
      pidAtPhase2 = after.pid;
      return { stdout: 'safe-merge-result: {"result":"merged"}', stderr: '', status: 0, signal: null, deadlineKilled: false, pid: 222 };
    };
    const r = new DefaultMergeRunner(baseCfg(), { spawn, confirmMerged: async () => true, prState: async () => 'OPEN' });
    await r.probeContract();
    const result = await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(result.outcome).toBe('merged');
    expect(result.confirmedMerged).toBe(true);
    expect(pidAtPhase2).toBe(222);
    expect(fs.existsSync(path.join(dir, 'state', 'green-pr-automerge-inflight.json'))).toBe(false); // cleared
  });

  it('B10: a "merged" outcome with a failing independent confirm is NOT confirmed', async () => {
    const r = new DefaultMergeRunner(baseCfg(), { spawn: fakeSpawn({}), confirmMerged: async () => false, prState: async () => 'OPEN' });
    await r.probeContract();
    const result = await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(result.outcome).toBe('merged');
    expect(result.confirmedMerged).toBe(false);
  });

  it('classifies a deadline-killed attempt', async () => {
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({ merge: { stdout: '', stderr: '', status: null, signal: 'SIGKILL', deadlineKilled: true, pid: 222 } }),
      confirmMerged: async () => false, prState: async () => 'OPEN',
    });
    await r.probeContract();
    const result = await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(result.deadlineKilled).toBe(true);
    expect(result.outcome).toBe('refused:checks-timeout');
  });
});

describe('DefaultMergeRunner — auto-arm strategy (mergerunner-auto-arm-handoff)', () => {
  /** Capture the merge spawn's argv + deadline for assertions. */
  function capturingSpawn(mergeOut: SpawnOutcome) {
    const captured: { args: string[]; deadlineMs: number }[] = [];
    const spawn = async (a: SpawnArgs): Promise<SpawnOutcome> => {
      if (a.args.includes('--capabilities')) return { stdout: JSON.stringify({ contract: 2 }), stderr: '', status: 0, signal: null, deadlineKilled: false, pid: 1 };
      captured.push({ args: a.args, deadlineMs: a.deadlineMs });
      a.onPid?.(222);
      return mergeOut;
    };
    return { spawn, captured };
  }

  it('spawns --auto (not --admin) on mergeStrategy:auto and uses the armTimeoutMs deadline', async () => {
    const { spawn, captured } = capturingSpawn({ stdout: 'safe-merge-result: {"result":"auto-merge-armed"}', stderr: '', status: 5, signal: null, deadlineKilled: false, pid: 222 });
    const r = new DefaultMergeRunner({ ...baseCfg(), mergeStrategy: 'auto', armTimeoutMs: 60_000 }, { spawn, confirmMerged: async () => true, prState: async () => 'OPEN' });
    await r.probeContract();
    await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(captured[0].args).toContain('--auto');
    expect(captured[0].args).not.toContain('--admin');
    // Auto-path deadline = armTimeoutMs + mergeKillGraceMs (60000 + 100), NOT mergeTimeoutMs.
    expect(captured[0].deadlineMs).toBe(60_000 + 100);
    // safe-merge runs with the SHORT deadline-ms (armTimeoutMs), not mergeTimeoutMs.
    const dIdx = captured[0].args.indexOf('--deadline-ms');
    expect(captured[0].args[dIdx + 1]).toBe('60000');
  });

  it('still spawns --admin on mergeStrategy:admin with the mergeTimeoutMs deadline', async () => {
    const { spawn, captured } = capturingSpawn({ stdout: 'safe-merge-result: {"result":"merged"}', stderr: '', status: 0, signal: null, deadlineKilled: false, pid: 222 });
    const r = new DefaultMergeRunner({ ...baseCfg(), mergeStrategy: 'admin' }, { spawn, confirmMerged: async () => true, prState: async () => 'OPEN' });
    await r.probeContract();
    await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(captured[0].args).toContain('--admin');
    expect(captured[0].args).not.toContain('--auto');
    expect(captured[0].deadlineMs).toBe(1000 + 100); // mergeTimeoutMs(1000) + grace(100)
  });

  it('defaults to --auto when mergeStrategy is omitted', async () => {
    const { spawn, captured } = capturingSpawn({ stdout: 'safe-merge-result: {"result":"auto-merge-armed"}', stderr: '', status: 5, signal: null, deadlineKilled: false, pid: 222 });
    const r = new DefaultMergeRunner(baseCfg(), { spawn, confirmMerged: async () => true, prState: async () => 'OPEN' });
    await r.probeContract();
    await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(captured[0].args).toContain('--auto');
  });

  it('maps auto-merge-armed (exit 5) → armed, confirmedMerged:false, carries armedHead — NOT downgraded to error', async () => {
    const { spawn } = capturingSpawn({ stdout: 'safe-merge-result: {"result":"auto-merge-armed","head":"sha"}', stderr: '', status: 5, signal: null, deadlineKilled: false, pid: 222 });
    const r = new DefaultMergeRunner({ ...baseCfg(), mergeStrategy: 'auto' }, { spawn, confirmMerged: async () => { throw new Error('confirmMerged must NOT be called for armed'); }, prState: async () => 'OPEN' });
    await r.probeContract();
    const result = await r.run({ pr: 5, headRefOid: 'sha100', repo: 'JKHeadley/instar' });
    expect(result.outcome).toBe('armed');
    expect(result.confirmedMerged).toBe(false);
    expect(result.armedHead).toBe('sha100');
  });

  it('immediate-green (merged exit 0) keeps the synchronous B10 confirm on the auto path', async () => {
    let confirmCalls = 0;
    const { spawn } = capturingSpawn({ stdout: 'safe-merge-result: {"result":"merged"}', stderr: '', status: 0, signal: null, deadlineKilled: false, pid: 222 });
    const r = new DefaultMergeRunner({ ...baseCfg(), mergeStrategy: 'auto' }, { spawn, confirmMerged: async () => { confirmCalls++; return true; }, prState: async () => 'OPEN' });
    await r.probeContract();
    const result = await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(result.outcome).toBe('merged');
    expect(result.confirmedMerged).toBe(true);
    expect(confirmCalls).toBe(1);
    expect(result.armedHead).toBeUndefined();
  });

  it('passes error:auto-arm-unconfirmed / error:auto-confirm-unreadable through unchanged (the non-ladder classes)', async () => {
    for (const slug of ['error:auto-arm-unconfirmed', 'error:auto-confirm-unreadable']) {
      const { spawn } = capturingSpawn({ stdout: `safe-merge-result: {"result":"${slug}"}`, stderr: '', status: 2, signal: null, deadlineKilled: false, pid: 222 });
      const r = new DefaultMergeRunner({ ...baseCfg(), mergeStrategy: 'auto' }, { spawn, confirmMerged: async () => false, prState: async () => 'OPEN' });
      await r.probeContract();
      const result = await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
      expect(result.outcome).toBe(slug);
      expect(result.confirmedMerged).toBe(false);
      expect(result.armedHead).toBeUndefined();
    }
  });

  it('passes refused:auto-arm-unavailable through unchanged', async () => {
    const { spawn } = capturingSpawn({ stdout: 'safe-merge-result: {"result":"refused:auto-arm-unavailable"}', stderr: '', status: 1, signal: null, deadlineKilled: false, pid: 222 });
    const r = new DefaultMergeRunner({ ...baseCfg(), mergeStrategy: 'auto' }, { spawn, confirmMerged: async () => false, prState: async () => 'OPEN' });
    await r.probeContract();
    const result = await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(result.outcome).toBe('refused:auto-arm-unavailable');
  });
});

describe('DefaultMergeRunner — orphan reap', () => {
  function seedInFlight(rec: Partial<InFlightRecord>) {
    const full: InFlightRecord = { pr: 7, headRefOid: 'h', repo: 'JKHeadley/instar', attemptToken: 'tok', startedAt: 1, pid: null, pgid: null, ...rec };
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'green-pr-automerge-inflight.json'), JSON.stringify(full));
  }

  it('no record → nothing to reap', async () => {
    const r = new DefaultMergeRunner(baseCfg(), { spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN' });
    expect(await r.reapOrphan()).toEqual({ reaped: false });
  });

  it('a pid-less record is re-verified (unknown outcome) and cleared', async () => {
    seedInFlight({ pid: null });
    const r = new DefaultMergeRunner(baseCfg(), { spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'MERGED' });
    const res = await r.reapOrphan();
    expect(res.reaped).toBe(true);
    expect(res.outcome).toBe('merged-by-other');
    expect(fs.existsSync(path.join(dir, 'state', 'green-pr-automerge-inflight.json'))).toBe(false);
  });

  it('a live orphan whose identity is confirmed is group-killed and cleared', async () => {
    seedInFlight({ pid: 999, pgid: 999 });
    let killed = -1;
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN',
      isAlive: () => true,
      killGroup: (pgid) => { killed = pgid; },
    });
    // identity check reads /proc which won't match in tests → not killed, but
    // still reaped (orphan-reap-incomplete path) and cleared.
    const res = await r.reapOrphan();
    expect(res.reaped).toBe(true);
    expect(fs.existsSync(path.join(dir, 'state', 'green-pr-automerge-inflight.json'))).toBe(false);
  });

  it('a dead orphan is simply re-verified and cleared', async () => {
    seedInFlight({ pid: 999, pgid: 999 });
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'CLOSED',
      isAlive: () => false,
    });
    const res = await r.reapOrphan();
    expect(res.outcome).toBe('closed-by-other');
  });
});
