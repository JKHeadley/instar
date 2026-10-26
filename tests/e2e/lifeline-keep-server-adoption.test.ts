/**
 * Tier-3 lifecycle: a lifeline-only restart leaves the server PROCESS running and the
 * next lifeline adopts it (spec docs/specs/local-verify-survives-restart.md §A).
 *
 * Real tmux session (a stand-in server process on the default tmux socket under a
 * unique name) + a real loopback /health listener; the REAL ServerSupervisor methods
 * run against them. The assertion is the one the incident needed: the server's pane
 * pid is the SAME before detach and after the successor's start(), and start() never
 * kills a session that is alive but not answering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

function tmuxPath(): string | null {
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
    try { execFileSync(p, ['-V'], { stdio: 'ignore' }); return p; } catch { /* next */ }
  }
  return null;
}
const TMUX = tmuxPath();

async function freePort(): Promise<number> {
  return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
}

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) { try { f(); } catch { /* best-effort */ } } });

function sessionPanePid(name: string): number {
  return Number(execFileSync(TMUX!, ['list-panes', '-t', `=${name}:`, '-F', '#{pane_pid}'], { encoding: 'utf-8' }).trim());
}

function supervisor(projectName: string, port: number): ServerSupervisor {
  const s = new ServerSupervisor({ projectDir: '/tmp/keep-server-adoption', projectName, port });
  (s as unknown as { tmuxPath: string | null }).tmuxPath = TMUX;
  // Real health checks would arm intervals + a SleepWakeDetector; the test asserts the decision, not the loop.
  (s as unknown as { startHealthChecks: () => void }).startHealthChecks = vi.fn();
  return s;
}

describe.skipIf(!TMUX)('lifeline-only restart: the server survives and the successor adopts it', () => {
  it('same pane pid across detach + a fresh supervisor start(); the busy (non-answering) case adopts too; a gone session spawns', async () => {
    const name = `keepsrv-${process.pid}-${Date.now().toString(36)}`;
    const port = await freePort();
    // The stand-in server: a process in a tmux session, like the real `echo-server` session.
    execFileSync(TMUX!, ['new-session', '-d', '-s', name, 'sleep', '600'], { stdio: 'ignore' });
    cleanup.push(() => execFileSync(TMUX!, ['kill-session', '-t', `=${name}`], { stdio: 'ignore' }));
    const pidBefore = sessionPanePid(name);
    expect(pidBefore).toBeGreaterThan(0);

    // A loopback /health that answers for it.
    let healthy = true;
    const srv = http.createServer((_req, res) => { res.statusCode = healthy ? 200 : 503; res.end(healthy ? 'ok' : 'busy'); });
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
    cleanup.push(() => srv.close());

    // Lifeline 1 supervises it, then restarts itself for drift: detach, not stop.
    const a = supervisor(name.replace(/-server$/, ''), port);
    (a as unknown as { serverSessionName: string }).serverSessionName = name;
    const spawnA = vi.spyOn(a as unknown as { spawnServer: () => boolean }, 'spawnServer');
    expect(await a.start()).toBe(true);
    expect(spawnA).not.toHaveBeenCalled();
    a.detach();
    expect(sessionPanePid(name)).toBe(pidBefore); // untouched

    // Lifeline 2 boots and adopts the running server.
    const b = supervisor(name, port);
    (b as unknown as { serverSessionName: string }).serverSessionName = name;
    const spawnB = vi.spyOn(b as unknown as { spawnServer: () => boolean }, 'spawnServer');
    expect(await b.start()).toBe(true);
    expect(spawnB).not.toHaveBeenCalled();
    expect(sessionPanePid(name)).toBe(pidBefore); // the SAME server process, mid-work and all
    b.detach();

    // A successor that finds the server alive but NOT answering (busy) adopts it as well.
    healthy = false;
    const c = supervisor(name, port);
    (c as unknown as { serverSessionName: string }).serverSessionName = name;
    (c as unknown as { verifyServerResponding: (n?: number, d?: number) => Promise<boolean> }).verifyServerResponding =
      async () => false; // the real probes take ~27 s; the verdict is what matters here
    const spawnC = vi.spyOn(c as unknown as { spawnServer: () => boolean }, 'spawnServer');
    expect(await c.start()).toBe(true);
    expect(spawnC).not.toHaveBeenCalled();
    expect(sessionPanePid(name)).toBe(pidBefore);
    c.detach();

    // And once the session is genuinely gone, start() spawns (the P1 behaviour, unchanged).
    execFileSync(TMUX!, ['kill-session', '-t', `=${name}`], { stdio: 'ignore' });
    cleanup.pop();
    const d = supervisor(name, port);
    (d as unknown as { serverSessionName: string }).serverSessionName = name;
    const spawnD = vi.spyOn(d as unknown as { spawnServer: () => boolean }, 'spawnServer').mockReturnValue(true);
    expect(await d.start()).toBe(true);
    expect(spawnD).toHaveBeenCalledTimes(1);
  }, 60_000);
});
