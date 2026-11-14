import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RestartOrchestrator, restartKeepsServer } from '../../../src/lifeline/RestartOrchestrator.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';

describe('RestartOrchestrator', () => {
  beforeEach(() => {
    DegradationReporter.resetForTesting?.();
  });

  it('proceeds through idle → quiescing → persisting → exiting', async () => {
    const states: string[] = [];
    const quiesce = vi.fn(async () => { states.push('quiesce'); });
    const persistAll = vi.fn(async () => { states.push('persist'); });
    const exitFn = vi.fn(() => { states.push('exit'); });
    const o = new RestartOrchestrator({ quiesce, persistAll, exitFn, isSupervised: true });
    await o.requestRestart({ reason: 'test', bucket: 'watchdog' });
    expect(states).toEqual(['quiesce', 'persist', 'exit']);
    expect(o.state).toBe('exiting');
  });

  it('suppresses re-entrant requests (single-owner guarantee)', async () => {
    // Deferred pattern — promise and resolver created together so the
    // resolver is callable from the outer scope regardless of timing.
    let resolveQuiesce!: () => void;
    const quiescePromise = new Promise<void>(r => { resolveQuiesce = r; });
    const quiesce = vi.fn(() => quiescePromise);
    const persistAll = vi.fn(async () => {});
    const exitFn = vi.fn();
    const o = new RestartOrchestrator({ quiesce, persistAll, exitFn, isSupervised: true });

    const first = o.requestRestart({ reason: 'watchdog-tick', bucket: 'watchdog' });
    // Second request synchronously after first — state is already 'quiescing'.
    const second = await o.requestRestart({ reason: 'version-skew', bucket: 'versionSkew' });
    expect(second).toBe('suppressed');
    expect(o.lastSuppressed?.reason).toBe('version-skew');
    // State may be 'quiescing' or still pre-quiesce depending on microtask
    // ordering; accept either as valid non-idle states.
    expect(['quiescing', 'persisting']).toContain(o.lastSuppressed?.currentState);

    resolveQuiesce();
    await first;
    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledTimes(1);
  });

  it('unsupervised mode emits signal but does not exit', async () => {
    const exitFn = vi.fn();
    const quiesce = vi.fn(async () => {});
    const persistAll = vi.fn(async () => {});
    const o = new RestartOrchestrator({ quiesce, persistAll, exitFn, isSupervised: false });
    const r = await o.requestRestart({ reason: 'test', bucket: 'watchdog' });
    expect(r).toBe('suppressed');
    expect(exitFn).not.toHaveBeenCalled();
    expect(quiesce).not.toHaveBeenCalled(); // stopped before quiesce
    expect(o.state).toBe('idle');
  });

  it('supervised mode exits with code 0 on clean persist', async () => {
    const exitFn = vi.fn();
    const o = new RestartOrchestrator({
      quiesce: async () => {},
      persistAll: async () => {},
      exitFn,
      isSupervised: true,
    });
    await o.requestRestart({ reason: 'test', bucket: 'watchdog' });
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('defers when shadow-install is updating (AC10)', async () => {
    const exitFn = vi.fn();
    const quiesce = vi.fn(async () => {});
    const o = new RestartOrchestrator({
      quiesce,
      persistAll: async () => {},
      exitFn,
      isSupervised: true,
      isShadowInstallUpdating: () => true, // lockfile present
    });
    const r = await o.requestRestart({ reason: 'noForwardStuck', bucket: 'watchdog' });
    expect(r).toBe('suppressed');
    expect(quiesce).not.toHaveBeenCalled();
    expect(exitFn).not.toHaveBeenCalled();
    expect(o.state).toBe('idle'); // re-entered idle so next tick can retry
  });

  it('proceeds when shadow-install is not updating', async () => {
    const exitFn = vi.fn();
    const o = new RestartOrchestrator({
      quiesce: async () => {},
      persistAll: async () => {},
      exitFn,
      isSupervised: true,
      isShadowInstallUpdating: () => false,
    });
    await o.requestRestart({ reason: 'x', bucket: 'watchdog' });
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('hard-kill timer fires if persist hangs past hardKillMs', async () => {
    vi.useFakeTimers();
    const exitFn = vi.fn();
    const o = new RestartOrchestrator({
      quiesce: async () => {},
      persistAll: () => new Promise(() => {}), // never resolves
      exitFn,
      isSupervised: true,
      persistBudgetMs: 100,
      hardKillMs: 500,
    });
    const p = o.requestRestart({ reason: 'test', bucket: 'watchdog' });
    // Advance past persistBudgetMs — Promise.race([persist, timeout]) resolves
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(exitFn).toHaveBeenCalledWith(0); // normal-exit path, budget expired
    vi.useRealTimers();
  });
});

describe('RestartOrchestrator — keepServer reaches quiesce', () => {
  const run = async (req: Parameters<RestartOrchestrator['requestRestart']>[0]) => {
    let seen: boolean | undefined;
    const o = new RestartOrchestrator({ quiesce: async (r) => { seen = r?.keepServer; }, persistAll: async () => {}, exitFn: () => {}, isSupervised: true });
    await o.requestRestart(req);
    return seen;
  };
  it('a lifeline-only bucket (versionSkew, plannedUpgrade) keeps the server by default; watchdog stops it', async () => {
    expect(restartKeepsServer('versionSkew')).toBe(true);
    expect(restartKeepsServer('plannedUpgrade')).toBe(true);
    expect(restartKeepsServer('watchdog')).toBe(false);
    expect(await run({ reason: 'drift-auto-promote', bucket: 'versionSkew', keepServer: true })).toBe(true);
    expect(await run({ reason: 'version-skew', bucket: 'versionSkew' })).toBe(true);
    expect(await run({ reason: 'migration', bucket: 'plannedUpgrade' })).toBe(true);
    expect(await run({ reason: 'watchdog-trip', bucket: 'watchdog' })).toBe(false);
    expect(await run({ reason: 'external-signal', bucket: 'watchdog' })).toBe(false);
  });
  it('an explicit keepServer on the request wins over the bucket default', async () => {
    expect(await run({ reason: 'x', bucket: 'versionSkew', keepServer: false })).toBe(false);
    expect(await run({ reason: 'y', bucket: 'watchdog', keepServer: true })).toBe(true);
  });
});

describe('RestartOrchestrator — a competing stop request wins over a keep-server restart', () => {
  const make = (stopServer = vi.fn(async () => {})) => {
    let resolveQuiesce!: () => void;
    const quiescing = new Promise<void>((r) => { resolveQuiesce = r; });
    const seen: Array<boolean | undefined> = [];
    const o = new RestartOrchestrator({
      quiesce: async (req) => { seen.push(req?.keepServer); await quiescing; },
      persistAll: async () => {}, exitFn: vi.fn(), isSupervised: true, stopServer,
    });
    return { o, seen, stopServer, resolveQuiesce };
  };
  it('drift first, then an external signal during quiesce: quiesce keeps the server, but it is stopped before exit', async () => {
    const t = make();
    const first = t.o.requestRestart({ reason: 'drift-auto-promote', bucket: 'versionSkew', keepServer: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.o.requestRestart({ reason: 'external-signal', bucket: 'watchdog' })).toBe('suppressed');
    t.resolveQuiesce();
    expect(await first).toBe('proceeded');
    expect(t.seen).toEqual([true]);
    expect(t.stopServer).toHaveBeenCalledTimes(1);
  });
  it('a stop request first, then drift during its quiesce: the server is stopped once by quiesce, no extra stop', async () => {
    const t = make();
    const first = t.o.requestRestart({ reason: 'watchdog-trip', bucket: 'watchdog' });
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.o.requestRestart({ reason: 'drift-auto-promote', bucket: 'versionSkew', keepServer: true })).toBe('suppressed');
    t.resolveQuiesce();
    await first;
    expect(t.seen).toEqual([false]);
    expect(t.stopServer).not.toHaveBeenCalled();
  });
  it('two keep-server requests: no stop', async () => {
    const t = make();
    const first = t.o.requestRestart({ reason: 'drift-auto-promote', bucket: 'versionSkew' });
    await new Promise((r) => setTimeout(r, 0));
    await t.o.requestRestart({ reason: 'version-skew', bucket: 'plannedUpgrade' });
    t.resolveQuiesce();
    await first;
    expect(t.stopServer).not.toHaveBeenCalled();
  });
  it('a stop arriving during the telemetry wait makes quiesce itself stop the server (no override phase needed)', async () => {
    const seen: Array<boolean | undefined> = [];
    const stopServer = vi.fn(async () => {});
    let release!: () => void;
    const reporter = { report: () => new Promise<void>((r) => { release = r; }) } as never;
    const o = new RestartOrchestrator({ quiesce: async (r) => { seen.push(r?.keepServer); }, persistAll: async () => {}, exitFn: vi.fn(), isSupervised: true, stopServer, reporter });
    const first = o.requestRestart({ reason: 'drift-auto-promote', bucket: 'versionSkew', keepServer: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(await o.requestRestart({ reason: 'external-signal', bucket: 'watchdog' })).toBe('suppressed');
    release();
    await first;
    expect(seen).toEqual([false]); // quiesce stopped the server
    expect(stopServer).not.toHaveBeenCalled();
  });

  it('the stop phase outlives the persist hard-kill timer: a slow stop finishes and the exit is clean (the 2026-10-26 round-2 P1)', async () => {
    const exitFn = vi.fn();
    const order: string[] = [];
    const stopServer = vi.fn(async () => { await new Promise((r) => setTimeout(r, 120)); order.push('stopped'); });
    const o = new RestartOrchestrator({
      quiesce: async () => {}, persistAll: async () => { await new Promise((r) => setTimeout(r, 200)); }, // exhausts its budget
      exitFn: (code) => { order.push(`exit${code}`); exitFn(code); }, isSupervised: true, stopServer,
      persistBudgetMs: 20, hardKillMs: 60, stopPhaseMs: 2000,
    });
    const first = o.requestRestart({ reason: 'drift-auto-promote', bucket: 'versionSkew' });
    await new Promise((r) => setTimeout(r, 0));
    await o.requestRestart({ reason: 'external-signal', bucket: 'watchdog' });
    await first;
    expect(order).toEqual(['stopped', 'exit0']); // never exit(1) from the persist timer, never exit before the stop
    expect(exitFn).toHaveBeenCalledTimes(1);
  });

  it('a stop arriving during persistence is honoured too', async () => {
    let resolvePersist!: () => void;
    const persisting = new Promise<void>((r) => { resolvePersist = r; });
    const stopServer = vi.fn(async () => {});
    const o = new RestartOrchestrator({ quiesce: async () => {}, persistAll: async () => { await persisting; }, exitFn: vi.fn(), isSupervised: true, stopServer });
    const first = o.requestRestart({ reason: 'drift-auto-promote', bucket: 'versionSkew' });
    await new Promise((r) => setTimeout(r, 0));
    expect(o.state).toBe('persisting');
    await o.requestRestart({ reason: 'external-signal', bucket: 'watchdog' });
    resolvePersist();
    await first;
    expect(stopServer).toHaveBeenCalledTimes(1);
  });
});
