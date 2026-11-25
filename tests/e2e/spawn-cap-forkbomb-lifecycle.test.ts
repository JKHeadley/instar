/**
 * E2E lifecycle test for fork-bomb prevention (the SIMPLE design).
 * Spec: docs/specs/forkbomb-prevention-simple.md §Tests (E2E).
 *
 * Tier-3 — proves the feature is ALIVE on the production init path (ON by
 * default, not dark) and that the two structural guards actually hold:
 *   - GET /spawn-limiter is alive (200, not 503/404) on a default-config server.
 *   - The cap defaults to 8 and is materialized by the SHARED config defaults
 *     (getInitDefaults + applyDefaults — the production init + migration path).
 *   - A SECOND SingleInstanceLock acquisition on the same state dir while a live
 *     holder exists is REFUSED — a supervisor kill+respawn race can't run two
 *     instances (the 3× fork-bomb multiplier).
 *   - After the holder releases (clean restart), a fresh acquisition SUCCEEDS
 *     (hands off — does NOT permanently wedge the agent out).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import {
  configureHostSpawnSemaphore,
  _resetHostSpawnSemaphoreForTest,
} from '../../src/core/hostSpawnSemaphore.js';
import { SingleInstanceLock } from '../../src/core/SingleInstanceLock.js';
import { getInitDefaults, applyDefaults } from '../../src/config/ConfigDefaults.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('Fork-bomb prevention — lifecycle (E2E over HTTP)', () => {
  let server: TestServer;

  beforeEach(async () => {
    _resetHostSpawnSemaphoreForTest();
    // Mirror the production boot wiring: server.ts injects the config-resolved
    // spawnCap. With no operator override, the default cap (8) holds.
    configureHostSpawnSemaphore({});
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { authToken: 'test', stateDir: '/tmp/.instar', port: 0 }, startTime: new Date() };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });

  afterEach(async () => {
    _resetHostSpawnSemaphoreForTest();
    await server?.close();
  });

  it('FEATURE IS ALIVE: GET /spawn-limiter returns 200 (not 503/404) with the default cap on', async () => {
    const res = await fetch(server.url + '/spawn-limiter');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cap).toBe(8); // default — ON, never dark
    expect(typeof body.liveHolders).toBe('number');
    expect(body.saturated).toBe(false);
    expect(typeof body.acquireMs).toBe('number');
  });

  it('the cap is a SAFETY FLOOR materialized by the production init + migration path', () => {
    // New-agent init path.
    const init = getInitDefaults('standalone') as any;
    expect(init.intelligence.spawnCap.maxConcurrent).toBe(8);
    expect(init.intelligence.spawnCap.acquireMs).toBe(5000);
    expect(init.intelligence.spawnCap.waitersMax).toBe(64);

    // Existing-agent migration path (add-missing-only): an agent with NO
    // intelligence block materializes the spawnCap knobs without clobbering
    // anything it already had.
    const existing: Record<string, unknown> = { someOther: true };
    const { patched, changes } = applyDefaults(existing, {
      intelligence: { spawnCap: { maxConcurrent: 8, acquireMs: 5000, waitersMax: 64 } },
    });
    expect(patched).toBe(true);
    expect(changes.some((c) => c.startsWith('intelligence'))).toBe(true);
    expect((existing as any).intelligence.spawnCap.maxConcurrent).toBe(8);

    // Idempotent + non-clobbering: an operator's hand-tuned cap survives migration.
    const tuned: Record<string, unknown> = { intelligence: { spawnCap: { maxConcurrent: 4 } } };
    applyDefaults(tuned, { intelligence: { spawnCap: { maxConcurrent: 8, acquireMs: 5000, waitersMax: 64 } } });
    expect((tuned as any).intelligence.spawnCap.maxConcurrent).toBe(4); // NOT overwritten
    expect((tuned as any).intelligence.spawnCap.acquireMs).toBe(5000); // missing sub-field backfilled
  });

  describe('single-instance lock — a supervisor kill+respawn race cannot run two instances', () => {
    let stateDir: string;
    beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-e2e-lock-')); });
    afterEach(() => { try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/e2e/spawn-cap-forkbomb-lifecycle.test.ts:afterEach' }); } catch { /* ignore */ } });

    it('a 2nd acquisition is REFUSED while a LIVE same-host holder exists', async () => {
      // Holder #1 — THIS process holds the lock (process.pid is genuinely alive).
      const first = new SingleInstanceLock({ stateDir, handoffGraceMs: 80, pollIntervalMs: 10 });
      const r1 = await first.acquire();
      expect(r1.acquired).toBe(true);

      // Holder #2 — a racing respawn on the SAME host, same state dir. The live
      // holder (this very pid) never releases during the grace → refused.
      const second = new SingleInstanceLock({ stateDir, handoffGraceMs: 80, pollIntervalMs: 10 });
      const r2 = await second.acquire();
      expect(r2.acquired).toBe(false);
      expect(r2.reason).toBe('duplicate-live-instance');

      first.release();
    });

    it('publishes exactly one owner when two processes start against an empty state directory', async () => {
      const code = await build({
        stdin: {
          contents: `
            import { SingleInstanceLock } from './src/core/SingleInstanceLock.ts';
            const lock = new SingleInstanceLock({ stateDir: process.argv[1], env: {}, handoffGraceMs: 0, log: () => {} });
            process.on('message', async (message) => {
              if (message !== 'acquire') return;
              const result = await lock.acquire();
              process.send({ pid: process.pid, acquired: result.acquired, owns: lock.revalidateForExclusiveWrite() });
            });
            process.on('disconnect', () => lock.release());
            process.send('ready');
          `,
          resolveDir: process.cwd(),
        },
        bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
      });
      const children = [0, 1].map(() => spawn(process.execPath,
        ['--input-type=module', '-e', code.outputFiles[0].text, stateDir],
        { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
      const exits = children.map((child) => once(child, 'exit'));
      const nextMessage = (child: typeof children[number]) => Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(5_000) }).then(([message]) => message),
        exits[children.indexOf(child)].then(([status]) => { throw new Error(`lock contender exited with ${status}`); }),
      ]);
      try {
        expect(await Promise.all(children.map(nextMessage))).toEqual(['ready', 'ready']);
        const results = children.map(nextMessage);
        for (const child of children) child.send('acquire');
        const outcomes = await Promise.all(results) as Array<{ pid: number; acquired: boolean; owns: boolean }>;
        const winners = outcomes.filter((result) => result.acquired);
        expect(winners).toHaveLength(1);
        expect(outcomes.filter((result) => result.owns)).toEqual(winners);
        const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'local', 'server-instance.lock'), 'utf8'));
        expect(saved.pid).toBe(winners[0].pid);
      } finally {
        const cleanupDeadline = setTimeout(() => {
          for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
        }, 2_000);
        try {
          for (const child of children) if (child.connected) child.disconnect();
          await Promise.all(exits);
        } finally { clearTimeout(cleanupDeadline); }
      }
    }, 15_000);

    it('after the holder releases (clean restart), a fresh acquisition SUCCEEDS (hands off, never wedges)', async () => {
      const first = new SingleInstanceLock({ stateDir, handoffGraceMs: 80, pollIntervalMs: 10 });
      expect((await first.acquire()).acquired).toBe(true);
      first.release(); // outgoing instance exits

      const second = new SingleInstanceLock({ stateDir, handoffGraceMs: 80, pollIntervalMs: 10 });
      const r2 = await second.acquire();
      expect(r2.acquired).toBe(true); // the agent is NOT permanently locked out
      second.release();
    });
  });
});
