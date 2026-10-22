// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 "the feature is alive" E2E for the test-runner progress extension.
 *
 * The unit tests prove the bounds and the tracker in isolation; the
 * integration tests prove the watchdog pipeline with synthetic process rows.
 * Neither proves the thing that actually failed on 2026-10-20: that a REAL
 * test run, seen through the REAL process table, is recognised as still
 * working and spared.
 *
 * So this spawns a genuine `npm test` subtree (npm → shell → node, burning
 * real CPU), lets the watchdog enumerate it with its own production snapshot,
 * and drives `checkSession` as the poll loop does. Everything here is real
 * except the one thing a test cannot wait for: the clock. Each row's
 * `elapsedMs` is aged past the one-hour floor so the extension path is the one
 * under test — the commands, the pids, the parent links and the CPU readings
 * all come from the live process table.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_TEST_RUNNER_PROTECTION_MS,
  SessionWatchdog,
} from '../../src/monitoring/SessionWatchdog.js';
import { formatWatchdogUserMessage } from '../../src/monitoring/watchdog-notifications.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AGED_MS = MAX_TEST_RUNNER_PROTECTION_MS + 60_000; // 61 minutes
/** The fixture must outlive every poll in this file, with margin. */
const BURN_MS = 150_000;
/**
 * Real polls, a real sample gap. The tracker compares samples at least
 * MIN_PROGRESS_SAMPLE_GAP_MS (20s) apart — the watchdog's own poll interval.
 * Shortening that here would prove only the one-poll grace, not the
 * measurement, which is the whole point of this tier.
 */
const POLL_GAP_MS = 21_000;

interface Row { pid: number; parentPid: number; command: string; elapsedMs: number; cpuMs?: number }

describe('E2E: a real test run past the floor is spared while it is still working', () => {
  let dir: string;
  let child: ReturnType<typeof spawn>;
  let closed = false;
  let joined: Promise<void>;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-real-suite-'));
    // A real package whose `npm test` burns CPU — a genuine test-runner argv
    // with a genuine subtree below it, not a process pretending to be one.
    //
    // The burner is a local `vitest` bin, so the subtree carries a recognisable
    // runner below npm. On Linux npm's title is cut back to its first value,
    // `npm` (entry.js sets that before the full `npm test`, and the kernel-side
    // title cannot grow past it), so the npm row alone does not classify. A
    // real suite is spared there through its vitest descendant, and this
    // fixture now has one too.
    const bin = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'vitest'),
      `#!/usr/bin/env node\nconst end=Date.now()+${BURN_MS}; while(Date.now()<end) Math.sqrt(Math.random());\n`,
      { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'watchdog-e2e-fixture',
      version: '0.0.0',
      private: true,
      scripts: { test: 'vitest' },
    }));
    child = spawn('npm', ['test', '--silent'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    joined = new Promise<void>((resolve) => child.once('close', () => { closed = true; resolve(); }));
  });

  afterAll(async () => {
    if (!closed && child.pid !== undefined) {
      try { process.kill(child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await Promise.race([joined, delay(5_000)]);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/watchdog-test-runner-progress-alive.test.ts' });
  });

  function watchdog() {
    const sm = {
      listRunningSessions: vi.fn(() => [{ tmuxSession: 'echo-real-suite', framework: 'claude-code' }]),
      captureOutput: vi.fn(() => 'RUN  v2.1.9\n ✓ tests/unit/a.test.ts (12 tests)'),
      sendKey: vi.fn(),
      sendInput: vi.fn(),
      isSessionAlive: vi.fn(() => true),
    };
    const wd = new SessionWatchdog({
      stateDir: path.join(dir, 'state'),
      sessions: { tmuxPath: 'tmux' },
      // The same shape server.ts passes, including the 30-minute ceiling that
      // makes every fail-closed path vote to interrupt past the floor.
      monitoring: { watchdog: { enabled: true, stuckCommandSec: 180, hardCeilingSec: 1800 } },
    } as any, sm as any, {} as any);
    const judge = vi.fn(async () => 'stuck');
    const signal = vi.fn(async () => true);
    wd.intelligence = { evaluate: judge } as any;
    (wd as any).signalIfIdentityMatches = signal;
    (wd as any).getClaudePid = vi.fn(async () => process.pid);
    (wd as any).hasActivePipelineSibling = vi.fn(async () => false);
    (wd as any).persistAudit = vi.fn();
    (wd as any).persistEvent = vi.fn();
    const realSnapshot = ((wd as any).getChildProcesses as (pid: number) => Promise<Row[]>).bind(wd);
    return { wd, sm, judge, signal, realSnapshot };
  }

  /**
   * The production snapshot with only the clock aged. `realSnapshot` is the
   * watchdog's own `getChildProcesses`, captured before the instance method is
   * replaced, so the rows are genuinely enumerated by the shipped code.
   */
  function agedSnapshot(realSnapshot: (pid: number) => Promise<Row[]>, freeze?: Map<number, number>) {
    return async (): Promise<Row[]> => {
      const all = await realSnapshot(process.pid);
      // Only the fixture's own subtree. The test runner that hosts THIS file
      // has its own descendants (its pool workers, its esbuild service), and
      // ageing those to 61 minutes would invent stuck commands the scenario is
      // not about. The fixture's rows are untouched apart from the clock.
      const subtree = new Set<number>([child.pid as number]);
      for (let changed = true; changed;) {
        changed = false;
        for (const r of all) {
          if (subtree.has(r.parentPid) && !subtree.has(r.pid)) { subtree.add(r.pid); changed = true; }
        }
      }
      const rows = all.filter((r) => subtree.has(r.pid));
      return rows.map((r) => {
        if (!freeze || r.cpuMs === undefined) return { ...r, elapsedMs: AGED_MS };
        const pinned = freeze.get(r.pid);
        if (pinned === undefined) freeze.set(r.pid, r.cpuMs);
        return { ...r, elapsedMs: AGED_MS, cpuMs: pinned ?? r.cpuMs };
      });
    };
  }

  async function waitForSuite(snapshot: () => Promise<Row[]>): Promise<Row[]> {
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      const rows = await snapshot();
      if (rows.some((r) => /(?:^|\/)vitest\b/.test(r.command))) return rows;
      await delay(100);
    }
    return [];
  }

  it('sees the real npm-test subtree and reads CPU time for it', async () => {
    const { realSnapshot } = watchdog();
    const rows = await waitForSuite(agedSnapshot(realSnapshot));
    expect(rows.length, 'the real process table must show the spawned suite').toBeGreaterThan(0);
    const npmRow = rows.find((r) => /(?:^|\/)npm\b/.test(r.command));
    expect(npmRow, 'npm test must be visible as a descendant').toBeDefined();
    expect(npmRow!.cpuMs, 'the production snapshot must carry a CPU reading').toBeTypeOf('number');
  }, 40_000);

  it('does not judge or interrupt it, and says why, while its CPU time is climbing', async () => {
    const { wd, judge, signal, realSnapshot } = watchdog();
    const snapshot = agedSnapshot(realSnapshot);
    await waitForSuite(snapshot);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    try {
      (wd as any).getChildProcesses = vi.fn(snapshot);
      // Two polls a real interval apart: a process at full tilt accrues far
      // more than the 1s of CPU the bound asks for.
      await (wd as any).checkSession('echo-real-suite');
      await delay(POLL_GAP_MS);
      await (wd as any).checkSession('echo-real-suite');
    } finally {
      spy.mockRestore();
    }
    expect(judge, 'a working test run must never reach the stuck judge').not.toHaveBeenCalled();
    expect(signal, 'a working test run must never be signalled').not.toHaveBeenCalled();
    // Proof the sparing came from the MEASUREMENT, not merely from the floor:
    // the floor is expired at 61 minutes, so this line can only appear when a
    // real CPU delta was observed.
    expect(logs.join('\n')).toMatch(/protected wait \(test-runner(?:-ancestor)?, still working\)/);
  }, 90_000);

  it('still interrupts — and now announces — a run whose CPU time has stopped moving', async () => {
    const { wd, judge, signal, realSnapshot } = watchdog();
    await waitForSuite(agedSnapshot(realSnapshot));
    // Everything stays real except that each pid's CPU reading is pinned to
    // its first value: the shape of a run that is alive but doing nothing,
    // which a test cannot produce from a real suite on demand.
    const frozen = new Map<number, number>();
    (wd as any).getChildProcesses = vi.fn(agedSnapshot(realSnapshot, frozen));
    const seen: any[] = [];
    wd.on('intervention', (e) => seen.push(e));
    await (wd as any).checkSession('echo-real-suite');
    await delay(POLL_GAP_MS);
    await (wd as any).checkSession('echo-real-suite');
    expect(judge, 'an idle run past the floor is still handed to the judge').toHaveBeenCalled();
    expect(signal).toHaveBeenCalled();
    expect(seen.length, 'the interruption must be recorded once').toBeGreaterThan(0);
    const testRunEvent = seen.find((e) => e.stuckCommandKind);
    expect(testRunEvent, 'the event must name this as a test run — the notice depends on it').toBeDefined();
    const msg = formatWatchdogUserMessage(testRunEvent);
    expect(msg, 'an interrupted test run must produce a user-facing line').not.toBeNull();
    expect(msg).toMatch(/61 minutes/);
    expect(msg).toMatch(/run again/i);
  }, 90_000);
});
