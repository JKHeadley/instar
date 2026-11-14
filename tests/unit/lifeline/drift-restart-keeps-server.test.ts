/**
 * A lifeline-only restart leaves the server running (2026-10-26).
 *
 * The drift auto-promoter restarts the LIFELINE when it is ≥ 20 patches behind the
 * server. Its quiesce used to stop the server too (supervisor.stop → Ctrl-C), which
 * killed in-flight server work — a local verify of PR 2350 was 23 minutes in when
 * the 06:23Z drift restart took it down, and the verify restart hold was never asked.
 * The server is already on the current code, so the restart now only DETACHES the
 * supervisor; the next lifeline's start() adopts the healthy server.
 *
 * TelegramLifeline is not cleanly unit-instantiable (see standby-no-poll-wiring), so
 * the lifeline half is pinned against source; ServerSupervisor.detach() runs for real.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ServerSupervisor } from '../../../src/lifeline/ServerSupervisor.js';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const lifelineSrc = fs.readFileSync(path.join(repoRoot, 'src', 'lifeline', 'TelegramLifeline.ts'), 'utf-8');

function makeSupervisor(): any {
  const s: any = new ServerSupervisor({ projectDir: '/tmp/drift-keep-server', projectName: 'drift-keep', port: 59998 });
  s.tmuxPath = 'tmux';
  s.startHealthChecks = vi.fn(); // never arm real intervals in these tests
  return s;
}

describe('ServerSupervisor.detach()', () => {
  it('stops watching without touching the server session (no send-keys, no kill-session)', () => {
    const s = makeSupervisor();
    const stopHealthChecks = vi.spyOn(s, 'stopHealthChecks');
    const alive = vi.spyOn(s, 'isServerSessionAlive');
    s.isRunning = true;
    s.detach();
    expect(stopHealthChecks).toHaveBeenCalledTimes(1);
    expect(alive).not.toHaveBeenCalled(); // never even looks at the session: nothing to stop
    expect(s.isRunning).toBe(false);
  });

  it('after detach, a late restart/probe callback cannot touch the server (stop, spawnServer, handleUnhealthy are inert)', async () => {
    const s = makeSupervisor();
    const alive = vi.spyOn(s, 'isServerSessionAlive').mockReturnValue(true);
    s.detach();
    await s.stop();
    expect(s.spawnServer()).toBe(false);
    s.handleUnhealthy();
    expect(alive).not.toHaveBeenCalled(); // none of them even looked at the session
  });

  it('a health probe in flight at detach cannot act afterwards (the 2026-10-26 window between detach and exit)', async () => {
    const s = makeSupervisor();
    for (const k of ['sleptMarkerPresent']) s[k] = () => false;
    for (const k of ['checkRestartRequest', 'checkSleepRequest', 'checkWakeRequest']) s[k] = vi.fn();
    const evaluate = vi.spyOn(s, 'evaluateUnhealthyServer');
    const unhealthy = vi.spyOn(s, 'handleUnhealthy');
    const spawn = vi.spyOn(s, 'spawnServer');
    let answer!: (ok: boolean) => void;
    s.checkHealth = () => new Promise<boolean>((r) => { answer = r; });
    s.isRunning = true;
    s.isServerSessionAlive = () => true; // the server is there; only the probe is slow
    const tick = s.runHealthTick();
    s.detach(); // the lifeline lets go while the probe is pending
    answer(false); // the probe then says "unhealthy"
    await tick;
    expect(evaluate).not.toHaveBeenCalled();
    expect(unhealthy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a stop() already waiting when detach happens does not force-kill afterwards; evenIfDetached still does', async () => {
    vi.useFakeTimers();
    try {
      for (const evenIfDetached of [false, true]) {
        const s = makeSupervisor();
        s.tmuxPath = '/usr/bin/true'; // send-keys / kill-session become no-ops we can count through isServerSessionAlive
        const alive = vi.spyOn(s, 'isServerSessionAlive').mockReturnValue(true);
        const p = s.stop({ evenIfDetached });
        await vi.advanceTimersByTimeAsync(10);
        s.detach(); // the lifeline lets go during the 3 s graceful wait
        await vi.advanceTimersByTimeAsync(3000);
        await p;
        // 1 call = the entry check only (no post-wait kill); 2 = it went on to the force-kill branch.
        expect(alive).toHaveBeenCalledTimes(evenIfDetached ? 2 : 1);
      }
    } finally { vi.useRealTimers(); }
  });

  it('a graceful restart already waiting when detach happens neither kills nor respawns', async () => {
    vi.useFakeTimers();
    try {
      const s = makeSupervisor();
      s.tmuxPath = '/usr/bin/true';
      s.captureCrashOutput = vi.fn(); s.cleanupChildProcesses = vi.fn();
      const alive = vi.spyOn(s, 'isServerSessionAlive').mockReturnValue(true);
      const spawn = vi.spyOn(s, 'spawnServer');
      const p = s.performGracefulRestart('update');
      await vi.advanceTimersByTimeAsync(10);
      s.detach();
      await vi.advanceTimersByTimeAsync(6000);
      expect(await p).toBe(false);
      expect(alive).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('a start() probing when detach happens does not re-arm supervision or clear the fence', async () => {
    const s = makeSupervisor();
    s.isServerSessionAlive = () => true;
    let answer!: (ok: boolean) => void;
    s.verifyServerResponding = () => new Promise<boolean>((r) => { answer = r; });
    const p = s.start();
    s.detach();
    answer(true);
    expect(await p).toBe(true);
    expect(s.startHealthChecks).not.toHaveBeenCalled();
    expect(s.detached).toBe(true);
  });

  it('stop({ evenIfDetached: true }) stops the server after a detach (a competing stop request won)', async () => {
    const s = makeSupervisor();
    const alive = vi.spyOn(s, 'isServerSessionAlive').mockReturnValue(false);
    s.detach();
    await s.stop({ evenIfDetached: true });
    expect(alive).toHaveBeenCalled();
  });

  it('stop() still stops the server (the other restart paths are unchanged)', async () => {
    const s = makeSupervisor();
    const alive = vi.spyOn(s, 'isServerSessionAlive').mockReturnValue(false);
    await s.stop();
    expect(alive).toHaveBeenCalled();
  });
});

describe('TelegramLifeline wiring — drift auto-promote keeps the server', () => {
  const drift = lifelineSrc.slice(lifelineSrc.indexOf('new LifelineDriftPromoter('), lifelineSrc.indexOf('recordPendingNotice: (info) =>'));
  const quiesce = lifelineSrc.slice(lifelineSrc.indexOf('private async quiesceEverything('), lifelineSrc.indexOf('private installOrchestratorAndWatchdog('));

  it('the drift restart request carries keepServer: true', () => {
    expect(drift).toContain("source: 'drift-auto-promote'");
    expect(drift).toMatch(/keepServer:\s*true/);
  });

  it('the orchestrator hands the request to quiesce', () => {
    expect(lifelineSrc).toMatch(/quiesce:\s*\(req\)\s*=>\s*this\.quiesceEverything\(\{\s*keepServer:\s*req\?\.keepServer === true\s*\}\)/);
  });

  it('quiesce detaches BEFORE its first await when keepServer is set (the orchestrator bounds quiesce), and stops otherwise', () => {
    const keep = quiesce.indexOf('opts.keepServer === true');
    const detach = quiesce.indexOf('this.supervisor.detach()');
    const firstAwait = quiesce.indexOf('await this.'); // the first awaited call (not the word in a comment)
    const stop = quiesce.indexOf('await this.supervisor.stop()');
    expect(keep).toBeGreaterThan(-1);
    expect(detach).toBeGreaterThan(keep);
    expect(detach).toBeLessThan(firstAwait); // settled synchronously
    expect(stop).toBeGreaterThan(detach); // the default path still stops the server
    expect(quiesce.slice(0, stop)).toContain('if (!keepServer)');
  });

  it('only the drift path sets the flag explicitly (version-skew and planned-upgrade get it from the orchestrator bucket default; watchdog never)', () => {
    expect(lifelineSrc.match(/keepServer:\s*true/g)).toHaveLength(1);
  });
});
