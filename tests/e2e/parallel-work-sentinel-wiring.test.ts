// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Wiring-integrity test for the ParallelWorkSentinel (Parallel-Work Awareness Phase B).
 * Per the Testing Integrity Standard, a dependency-injected component must be proven to be
 * (a) NOT constructed when its flag is off (ships dark), and (b) constructed + non-null when
 * the flag is on — and that it actually ticks over the live index.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function mockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function makeConfig(stateDir: string, tmpDir: string, pwsEnabled: boolean): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: 'x',
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    monitoring: pwsEnabled ? { parallelWorkSentinel: { enabled: true } } : {},
    updates: {},
  } as InstarConfig;
}

let servers: AgentServer[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const s of servers) { try { await s.stop(); } catch { /* ignore */ } }
  servers = [];
  for (const d of dirs) { try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/parallel-work-sentinel-wiring.test.ts' }); } catch { /* ignore */ } }
  dirs = [];
});

function boot(pwsEnabled: boolean): AgentServer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pws-wiring-'));
  dirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'topic-intent'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e' }));
  const server = new AgentServer({ config: makeConfig(stateDir, tmpDir, pwsEnabled), sessionManager: mockSessionManager() as any, state: new StateManager(stateDir) });
  servers.push(server);
  return server;
}

describe('ParallelWorkSentinel wiring integrity', () => {
  it('ships DARK: NOT constructed when monitoring.parallelWorkSentinel is off (default)', () => {
    const server = boot(false);
    expect(server.getParallelWorkSentinel()).toBeNull();
  });

  it('constructed + non-null when monitoring.parallelWorkSentinel.enabled is true', () => {
    const server = boot(true);
    const sentinel = server.getParallelWorkSentinel();
    expect(sentinel).not.toBeNull();
    // and it actually ticks over the (empty) live index without throwing
    expect(sentinel!.tick(Date.now())).toEqual([]);
  });
});
