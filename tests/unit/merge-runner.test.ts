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
  localImportClosure,
  ORPHAN_FOREIGN_MARGIN_MS,
  relativeImports,
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
  resolveGitHubEnv: () => ({
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    GH_TOKEN: 'agent-token',
    GITHUB_TOKEN: 'agent-token',
  }),
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
  it('fails closed before spawning when explicit GitHub identity is unavailable', async () => {
    let spawned = false;
    const r = new DefaultMergeRunner(
      { ...baseCfg(), resolveGitHubEnv: () => null },
      {
        spawn: async (args) => {
          spawned = true;
          return fakeSpawn({})(args);
        },
        confirmMerged: async () => true,
        prState: async () => 'OPEN',
      },
    );
    expect(await r.probeContract()).toEqual({ ok: false });
    expect(spawned).toBe(false);
  });

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

describe('DefaultMergeRunner — the hash pin covers safe-merge\'s local imports', () => {
  const setup = () => {
    fs.writeFileSync(scriptPath, "import { a } from './floor.mjs';\nimport fs from 'node:fs';\n// import { x } from './commented-out.mjs';\n");
    fs.writeFileSync(path.join(dir, 'floor.mjs'), "export { b } from './nested/b.mjs';\nexport const a = 1;\n");
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'b.mjs'), 'export const b = 2;\n');
  };

  it('the closure is the script plus every relative import, transitively, in a fixed order', () => {
    setup();
    expect(localImportClosure(scriptPath).map((f) => path.relative(dir, f))).toEqual(['floor.mjs', path.join('nested', 'b.mjs'), 'safe-merge.mjs']);
    expect(relativeImports("import x from './a.mjs'; export * from '../b.mjs'; await import('./c.mjs'); import 'node:fs';")).toEqual(['./a.mjs', '../b.mjs', './c.mjs']);
  });

  it('a change to a directly imported module between probe and exec refuses', async () => {
    setup();
    const r = new DefaultMergeRunner(baseCfg(), { spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN' });
    expect((await r.probeContract()).ok).toBe(true);
    fs.writeFileSync(path.join(dir, 'floor.mjs'), "export { b } from './nested/b.mjs';\nexport const a = 999;\n");
    expect((await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' })).outcome).toBe('skipped:safe-merge-contract');
  });

  it('a change to a transitively imported module refuses', async () => {
    setup();
    const r = new DefaultMergeRunner(baseCfg(), { spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN' });
    await r.probeContract();
    fs.writeFileSync(path.join(dir, 'nested', 'b.mjs'), 'export const b = 3;\n');
    expect((await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' })).outcome).toBe('skipped:safe-merge-contract');
  });

  it('a removed imported module fails the probe (unhashable ⇒ refuse)', async () => {
    setup();
    SafeFsExecutor.safeUnlinkSync(path.join(dir, 'nested', 'b.mjs'), { operation: 'test-remove-import' });
    const r = new DefaultMergeRunner(baseCfg(), { spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN' });
    expect((await r.probeContract()).ok).toBe(false);
  });

  it('unchanged files run normally', async () => {
    setup();
    const r = new DefaultMergeRunner(baseCfg(), { spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN' });
    await r.probeContract();
    expect((await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' })).outcome).toBe('merged');
  });

  it('the real safe-merge closure includes the floor module and the body checkers', () => {
    const real = path.join(process.cwd(), 'scripts', 'safe-merge.mjs');
    const names = localImportClosure(real).map((f) => path.basename(f));
    for (const n of ['safe-merge.mjs', 'local-verify-floor.mjs', 'eli16-pr-description-check.mjs', 'decision-audit-presence-check.mjs', 'check-release-fragment.mjs', 'release-relevant-paths.mjs']) {
      expect(names).toContain(n);
    }
  });
});

describe('DefaultMergeRunner — run', () => {
  it('threads the same explicit identity into capabilities and safe-merge', async () => {
    const environments: NodeJS.ProcessEnv[] = [];
    const spawn = async (a: SpawnArgs): Promise<SpawnOutcome> => {
      environments.push(a.env);
      return fakeSpawn({})(a);
    };
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn,
      confirmMerged: async () => true,
      prState: async () => 'OPEN',
    });
    await r.probeContract();
    await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(environments).toHaveLength(2);
    for (const env of environments) {
      expect(env.GH_TOKEN).toBe('agent-token');
      expect(env.GITHUB_TOKEN).toBe('agent-token');
      expect(env.PATH?.split(path.delimiter)[0]).toBe('/opt/homebrew/bin');
    }
    expect(environments[1].GREEN_PR_ATTEMPT_TOKEN).toBeTruthy();
  });

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

  const inflightPath = () => path.join(dir, 'state', 'green-pr-automerge-inflight.json');

  it('macOS-style: the token on the live pid\'s argv (ps -o args=) confirms identity → group killed, record cleared', async () => {
    seedInFlight({ pid: 999, pgid: 999, attemptToken: 'abcd1234abcd1234' });
    let killed = -1;
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN',
      isAlive: () => true,
      killGroup: (pgid) => { killed = pgid; },
      readProcessArgs: () => `/usr/local/bin/node ${scriptPath} 7 --repo JKHeadley/instar --squash --attempt-token abcd1234abcd1234`,
      readProcessEnviron: () => null, // no /proc on macOS
    });
    const res = await r.reapOrphan();
    expect(killed).toBe(999);
    expect(res).toEqual({ reaped: true, outcome: 'reaped-open' });
    expect(fs.existsSync(inflightPath())).toBe(false);
  });

  it('Linux fallback: the token in /proc environ confirms identity when argv lacks it', async () => {
    seedInFlight({ pid: 999, pgid: 999, attemptToken: 'abcd1234abcd1234' });
    let killed = -1;
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN',
      isAlive: () => true,
      killGroup: (pgid) => { killed = pgid; },
      readProcessArgs: () => 'node safe-merge.mjs 7',
      readProcessEnviron: () => 'PATH=/bin\0GREEN_PR_ATTEMPT_TOKEN=abcd1234abcd1234\0',
    });
    expect((await r.reapOrphan()).reaped).toBe(true);
    expect(killed).toBe(999);
  });

  it('a different token on argv (pid reuse) is NOT a match', async () => {
    seedInFlight({ pid: 999, pgid: 999, attemptToken: 'abcd1234abcd1234', startedAt: Date.now() });
    let killed = -1;
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN',
      isAlive: () => true,
      killGroup: (pgid) => { killed = pgid; },
      readProcessArgs: () => `node ${scriptPath} 7 --attempt-token ffff0000ffff0000 abcd1234abcd1234`,
      readProcessEnviron: () => null,
    });
    const res = await r.reapOrphan();
    expect(killed).toBe(-1);
    expect(res).toEqual({ reaped: false, outcome: 'orphan-reap-incomplete' });
  });

  it('unconfirmed + alive → nothing signalled, record KEPT (marked), and run() refuses new attempts', async () => {
    seedInFlight({ pid: 999, pgid: 999, startedAt: Date.now() });
    let killed = -1;
    let prStateCalls = 0;
    let merges = 0;
    const spawn = fakeSpawn({});
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: async (a) => { if (!a.args.includes('--capabilities')) merges++; return spawn(a); },
      confirmMerged: async () => true,
      prState: async () => { prStateCalls++; return 'OPEN'; },
      isAlive: () => true,
      killGroup: (pgid) => { killed = pgid; },
      readProcessArgs: () => 'some unrelated process',
      readProcessEnviron: () => null,
    });
    const res = await r.reapOrphan();
    expect(res).toEqual({ reaped: false, outcome: 'orphan-reap-incomplete' });
    expect(killed).toBe(-1);
    expect(prStateCalls).toBe(0);
    const kept = JSON.parse(fs.readFileSync(inflightPath(), 'utf-8')) as InFlightRecord;
    expect(kept.pid).toBe(999);
    expect(kept.attemptToken).toBe('tok');
    expect(typeof kept.reapIncompleteAt).toBe('number');

    await r.probeContract();
    const run = await r.run({ pr: 8, headRefOid: 'abc1234', repo: 'JKHeadley/instar' });
    expect(run).toEqual({ outcome: 'skipped:orphan-unresolved', confirmedMerged: false, priorRecord: 'orphan-reap-incomplete' });
    expect(merges).toBe(0);
    expect(JSON.parse(fs.readFileSync(inflightPath(), 'utf-8')).pr).toBe(7); // the old handle survives
  });

  it('unconfirmed record, pid now gone → run() re-verifies PR state, clears it, and proceeds', async () => {
    seedInFlight({ pid: 999, pgid: 999, reapIncompleteAt: 5 });
    let prStateCalls = 0;
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({}), confirmMerged: async () => true,
      prState: async (n) => { prStateCalls++; expect(n).toBe(7); return 'MERGED'; },
      isAlive: () => false,
      readProcessArgs: () => null,
      readProcessEnviron: () => null,
    });
    await r.probeContract();
    const run = await r.run({ pr: 8, headRefOid: 'abc1234', repo: 'JKHeadley/instar' });
    expect(prStateCalls).toBe(1);
    expect(run.outcome).toBe('merged');
    expect(fs.existsSync(inflightPath())).toBe(false);
  });

  it('the attempt token rides argv as --attempt-token only when the probed script advertises it', async () => {
    const captured: string[][] = [];
    const mk = (features: string[] | undefined) => new DefaultMergeRunner(baseCfg(), {
      spawn: async (a) => {
        if (a.args.includes('--capabilities')) return { stdout: JSON.stringify({ contract: 2, ...(features ? { features } : {}) }), stderr: '', status: 0, signal: null, deadlineKilled: false, pid: 1 };
        captured.push(a.args);
        a.onPid?.(222);
        expect(a.env.GREEN_PR_ATTEMPT_TOKEN).toBeTruthy();
        return { stdout: 'safe-merge-result: {"result":"refused:red-checks"}', stderr: '', status: 1, signal: null, deadlineKilled: false, pid: 222 };
      },
      confirmMerged: async () => true, prState: async () => 'OPEN',
    });
    const withFlag = mk(['attempt-token']);
    await withFlag.probeContract();
    await withFlag.run({ pr: 8, headRefOid: 'abc1234', repo: 'JKHeadley/instar' });
    const without = mk(undefined);
    await without.probeContract();
    await without.run({ pr: 8, headRefOid: 'abc1234', repo: 'JKHeadley/instar' });
    const i = captured[0].indexOf('--attempt-token');
    expect(i).toBeGreaterThan(0);
    expect(captured[0][i + 1]).toMatch(/^[0-9a-f]{16}$/);
    expect(captured[1]).not.toContain('--attempt-token');
  });

  it('real ps read: a live child carrying --attempt-token on argv is identified on this OS (macOS has no /proc)', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)', '--', scriptPath, '--attempt-token', 'abcd1234abcd1234'], { stdio: 'ignore' });
    try {
      await new Promise((res) => setTimeout(res, 200));
      seedInFlight({ pid: child.pid!, pgid: child.pid!, attemptToken: 'abcd1234abcd1234' });
      let killed = -1;
      const r = new DefaultMergeRunner(baseCfg(), {
        spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN',
        killGroup: (pgid) => { killed = pgid; }, // real isAlive + real ps argv read
      });
      const res = await r.reapOrphan();
      expect(killed).toBe(child.pid);
      expect(res.reaped).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('the token pair without the pinned safe-merge path on argv is NOT a match', async () => {
    seedInFlight({ pid: 999, pgid: 999, attemptToken: 'abcd1234abcd1234', startedAt: Date.now() });
    let killed = -1;
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN',
      isAlive: () => true,
      killGroup: (pgid) => { killed = pgid; },
      readProcessArgs: () => 'node /some/other/tool.mjs --attempt-token abcd1234abcd1234',
      readProcessEnviron: () => null,
    });
    expect(await r.reapOrphan()).toEqual({ reaped: false, outcome: 'orphan-reap-incomplete' });
    expect(killed).toBe(-1);
  });

  it('pid-reuse time bound: alive + unconfirmed + FOREIGN argv past startedAt + deadline + grace + margin → cleared WITHOUT a kill, presumed foreign', async () => {
    const t0 = 10_000_000;
    seedInFlight({ pid: 999, pgid: 999, startedAt: t0, deadlineMs: 60_000 });
    let killed = -1;
    let now = t0 + 60_000 + 100 + ORPHAN_FOREIGN_MARGIN_MS; // exactly at the bound: still kept
    let prStateCalls = 0;
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({}), confirmMerged: async () => true,
      prState: async () => { prStateCalls++; return 'OPEN'; },
      isAlive: () => true,
      killGroup: (pgid) => { killed = pgid; },
      readProcessArgs: () => 'some unrelated process',
      readProcessEnviron: () => null,
      now: () => now,
    });
    expect((await r.reapOrphan()).outcome).toBe('orphan-reap-incomplete');
    expect(fs.existsSync(inflightPath())).toBe(true);
    now += 1;
    expect(await r.reapOrphan()).toEqual({ reaped: true, outcome: 'orphan-presumed-foreign' });
    expect(killed).toBe(-1);
    expect(prStateCalls).toBe(1);
    expect(fs.existsSync(inflightPath())).toBe(false);
  });

  describe('past the bound, a clear needs positive evidence the pid is not a safe-merge', () => {
    const t0 = 10_000_000;
    const pastBound = t0 + 60_000 + 100 + ORPHAN_FOREIGN_MARGIN_MS + 1;
    const mk = (readProcessArgs: () => string | null) => {
      let killed = -1;
      let prStateCalls = 0;
      const r = new DefaultMergeRunner(baseCfg(), {
        spawn: fakeSpawn({}), confirmMerged: async () => true,
        prState: async () => { prStateCalls++; return 'OPEN'; },
        isAlive: () => true,
        killGroup: (pgid) => { killed = pgid; },
        readProcessArgs, readProcessEnviron: () => null,
        now: () => pastBound,
      });
      return { r, killed: () => killed, prStateCalls: () => prStateCalls };
    };

    it('ps read fails → record kept (orphan-reap-incomplete), no kill', async () => {
      seedInFlight({ pid: 999, pgid: 999, startedAt: t0, deadlineMs: 60_000 });
      const h = mk(() => null);
      expect(await h.r.reapOrphan()).toEqual({ reaped: false, outcome: 'orphan-reap-incomplete' });
      expect(h.killed()).toBe(-1);
      expect(fs.existsSync(inflightPath())).toBe(true);
    });

    it('argv shows the pinned safe-merge path without our token (e.g. an older attempt) → record kept, no kill', async () => {
      seedInFlight({ pid: 999, pgid: 999, startedAt: t0, deadlineMs: 60_000 });
      const h = mk(() => `node ${scriptPath} 7 --repo JKHeadley/instar --auto --deadline-ms 60000`);
      expect(await h.r.reapOrphan()).toEqual({ reaped: false, outcome: 'orphan-reap-incomplete' });
      expect(h.killed()).toBe(-1);
      expect(fs.existsSync(inflightPath())).toBe(true);
    });

    it('argv reads and is foreign → cleared without a kill after re-verifying the PR', async () => {
      seedInFlight({ pid: 999, pgid: 999, startedAt: t0, deadlineMs: 60_000 });
      const h = mk(() => '/Applications/Some.app/Contents/MacOS/Some --flag');
      expect(await h.r.reapOrphan()).toEqual({ reaped: true, outcome: 'orphan-presumed-foreign' });
      expect(h.killed()).toBe(-1);
      expect(h.prStateCalls()).toBe(1);
      expect(fs.existsSync(inflightPath())).toBe(false);
    });
  });

  it('a legacy record without deadlineMs is bounded by mergeTimeoutMs', async () => {
    const t0 = 10_000_000;
    seedInFlight({ pid: 999, pgid: 999, startedAt: t0 });
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN',
      isAlive: () => true, killGroup: () => { throw new Error('must not kill'); },
      readProcessArgs: () => '/usr/sbin/unrelated-daemon', readProcessEnviron: () => null,
      now: () => t0 + 1000 /* mergeTimeoutMs */ + 100 + ORPHAN_FOREIGN_MARGIN_MS + 1,
    });
    expect((await r.reapOrphan()).outcome).toBe('orphan-presumed-foreign');
  });

  it('run() records the attempt deadline in the in-flight record', async () => {
    let recorded: InFlightRecord | null = null;
    const base = fakeSpawn({});
    const r = new DefaultMergeRunner({ ...baseCfg(), armTimeoutMs: 42_000 }, {
      spawn: async (a) => {
        const out = await base(a);
        if (!a.args.includes('--capabilities')) recorded = JSON.parse(fs.readFileSync(inflightPath(), 'utf-8'));
        return out;
      },
      confirmMerged: async () => true, prState: async () => 'OPEN',
    });
    await r.probeContract();
    await r.run({ pr: 8, headRefOid: 'abc1234', repo: 'JKHeadley/instar' });
    expect(recorded!.deadlineMs).toBe(42_000);
  });

  it('run() kills a CONFIRMED live orphan at the start of the attempt (not only at warm-up) and reports it', async () => {
    seedInFlight({ pid: 999, pgid: 999, attemptToken: 'abcd1234abcd1234', startedAt: Date.now() });
    let killed = -1;
    const r = new DefaultMergeRunner(baseCfg(), {
      spawn: fakeSpawn({}), confirmMerged: async () => true, prState: async () => 'OPEN',
      isAlive: (pid) => pid === 999 && killed === -1,
      killGroup: (pgid) => { killed = pgid; },
      readProcessArgs: () => `node ${scriptPath} 7 --attempt-token abcd1234abcd1234`,
      readProcessEnviron: () => null,
    });
    await r.probeContract();
    const res = await r.run({ pr: 8, headRefOid: 'abc1234', repo: 'JKHeadley/instar' });
    expect(killed).toBe(999);
    expect(res.outcome).toBe('merged');
    expect(res.priorRecord).toBe('reaped-open');
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

describe('DefaultMergeRunner — sync strategy (local-verify-merge-authority §2 "Merge deadline and flags")', () => {
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
  const merged: SpawnOutcome = { stdout: 'safe-merge-result: {"result":"merged"}', stderr: '', status: 0, signal: null, deadlineKilled: false, pid: 222 };

  it('mergeStrategy:sync passes NEITHER --auto NOR --admin and uses the mergeTimeoutMs deadline', async () => {
    const { spawn, captured } = capturingSpawn(merged);
    const r = new DefaultMergeRunner({ ...baseCfg(), mergeStrategy: 'sync', armTimeoutMs: 60_000 }, { spawn, confirmMerged: async () => true, prState: async () => 'OPEN' });
    expect(r.resolvedStrategy).toBe('sync');
    await r.probeContract();
    const res = await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(captured[0].args).not.toContain('--auto');
    expect(captured[0].args).not.toContain('--admin');
    expect(captured[0].args).toContain('--match-head-commit');
    expect(captured[0].deadlineMs).toBe(1000 + 100);
    expect(captured[0].args[captured[0].args.indexOf('--deadline-ms') + 1]).toBe('1000');
    expect(res).toMatchObject({ outcome: 'merged', confirmedMerged: true });
  });

  it('a per-attempt strategy:sync overrides mergeStrategy:auto (the local floor)', async () => {
    const { spawn, captured } = capturingSpawn(merged);
    const r = new DefaultMergeRunner({ ...baseCfg(), mergeStrategy: 'auto', armTimeoutMs: 60_000 }, { spawn, confirmMerged: async () => true, prState: async () => 'OPEN' });
    await r.probeContract();
    await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar', strategy: 'sync' });
    expect(captured[0].args).not.toContain('--auto');
    expect(captured[0].args).not.toContain('--admin');
    expect(captured[0].deadlineMs).toBe(1000 + 100);
  });

  it('a per-attempt strategy:sync overrides mergeStrategy:admin', async () => {
    const { spawn, captured } = capturingSpawn(merged);
    const r = new DefaultMergeRunner({ ...baseCfg(), mergeStrategy: 'admin' }, { spawn, confirmMerged: async () => true, prState: async () => 'OPEN' });
    await r.probeContract();
    await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar', strategy: 'sync' });
    expect(captured[0].args).not.toContain('--admin');
    expect(captured[0].args).not.toContain('--auto');
  });

  it('a sync merged outcome is still independently confirmed (B10)', async () => {
    const { spawn } = capturingSpawn(merged);
    const r = new DefaultMergeRunner({ ...baseCfg(), mergeStrategy: 'sync' }, { spawn, confirmMerged: async () => false, prState: async () => 'OPEN' });
    await r.probeContract();
    const res = await r.run({ pr: 5, headRefOid: 'sha', repo: 'JKHeadley/instar' });
    expect(res.confirmedMerged).toBe(false);
  });
});

describe('withoutMergeFloorOverride', () => {
  it('drops INSTAR_MERGE_FLOOR so the server env never forces a floor on the watcher', async () => {
    const { withoutMergeFloorOverride } = await import('../../src/monitoring/MergeRunner.js');
    const out = withoutMergeFloorOverride({ PATH: '/bin', INSTAR_MERGE_FLOOR: 'actions', GH_TOKEN: 'x' });
    expect(out).toEqual({ PATH: '/bin', GH_TOKEN: 'x' });
  });
});
