/**
 * E2E lifecycle — test-agent leak guard (docs/specs/test-agent-leak-guard.md).
 *
 * Drives the real built CLI (`dist/cli.js server start --foreground`) against a
 * throwaway agent whose recorded expiry has passed: the production startup path
 * must tear down, write the expired marker and exit 0 before building anything
 * (no port is ever bound). Plus wiring integrity: server.ts hands the scheduler
 * a real guard and runs the startup decision first.
 *
 * VITEST is set for the child too, so its teardown never runs launchctl.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildThrowawayJobGuard, expiredMarkerPath, throwawayStartupDecision } from '../../src/core/ThrowawayAgentGuard.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tlg-e2e-'));
afterAll(() => {
  SafeFsExecutor.safeRmSync(base, { recursive: true, force: true, operation: 'tests/e2e/test-agent-leak-guard-lifecycle.test.ts' });
});

function makeAgent(name: string, cfg: Record<string, unknown>): string {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
  // loadConfig checks these binary paths before the expired-agent startup gate.
  // The gate exits before either binary can run, so a real executable path keeps
  // this lifecycle test independent of what CI has installed.
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({
    projectName: name, port: 5677, authToken: 't',
    sessions: { tmuxPath: process.execPath, claudePath: process.execPath },
    ...cfg,
  }, null, 2));
  return dir;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

describe('expired throwaway: production startup path', () => {
  it('server start exits 0, writes the marker, binds no port', async () => {
    const cli = path.join(process.cwd(), 'dist', 'cli.js');
    if (!fs.existsSync(cli)) return;
    const dir = makeAgent('tlg-expired', { throwawayAgent: { createdAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-02T00:00:00Z' } });
    const r = spawnSync(process.execPath, [cli, 'server', 'start', '--foreground', '--dir', dir], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, VITEST: 'true', INSTAR_SKIP_LAUNCHCTL_LOAD: '1' },
    });
    expect(r.error).toBeUndefined();
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('throwaway agent expired');
    expect(fs.existsSync(expiredMarkerPath(dir))).toBe(true);
    expect(await portFree(5677)).toBe(true);
    // A second start stops at the marker straight away.
    const r2 = spawnSync(process.execPath, [cli, 'server', 'start', '--foreground', '--dir', dir], {
      encoding: 'utf-8', timeout: 60_000, env: { ...process.env, VITEST: 'true', INSTAR_SKIP_LAUNCHCTL_LOAD: '1' },
    });
    expect(r2.status).toBe(0);
  }, 150_000);

  it('a live temp-folder agent is told to run, gets a backfilled expiry, and its job guard refuses', () => {
    const dir = makeAgent('tlg-live', {});
    const d = throwawayStartupDecision('tlg-live', dir);
    expect(d.decision).toBe('run');
    expect(d.backfilled?.expiresAt).toBeDefined();
    expect(buildThrowawayJobGuard({ projectDir: dir })().refuse).toBe(true);
  });
});

describe('wiring integrity (server.ts / TelegramLifeline.ts)', () => {
  const server = fs.readFileSync(path.join(process.cwd(), 'src', 'commands', 'server.ts'), 'utf-8');
  const lifeline = fs.readFileSync(path.join(process.cwd(), 'src', 'lifeline', 'TelegramLifeline.ts'), 'utf-8');

  it('the scheduler is given a real guard built from config', () => {
    expect(server).toMatch(/buildThrowawayJobGuard\(\{\s*projectDir: config\.projectDir,\s*allowOnThrowawayAgent: config\.scheduler\.allowOnThrowawayAgent/);
    expect(server).toContain('scheduler.setThrowawayJobGuard(throwawayJobGuard)');
  });

  it('the startup decision runs before any subsystem in startServer', () => {
    const start = server.indexOf('export async function startServer(');
    const decision = server.indexOf('throwawayStartupDecision(config.projectName, config.projectDir)', start);
    const firstSubsystem = server.indexOf('ensureStateDir(config.stateDir)', start);
    expect(decision).toBeGreaterThan(start);
    expect(decision).toBeLessThan(firstSubsystem);
  });

  it('the lifeline checks expiry before taking its lock', () => {
    const decision = lifeline.indexOf('throwawayStartupDecision(this.projectConfig.projectName');
    const lock = lifeline.indexOf('if (!acquireLockFile(this.lockPath))');
    expect(decision).toBeGreaterThan(0);
    expect(decision).toBeLessThan(lock);
  });
});
