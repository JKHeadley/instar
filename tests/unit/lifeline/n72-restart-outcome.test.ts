import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestartOrchestrator } from '../../../src/lifeline/RestartOrchestrator.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';
afterEach(() => { vi.useRealTimers(); DegradationReporter.resetForTesting?.(); });
const deps = () => ({ quiesce: vi.fn(async () => {}), persistAll: vi.fn(async () => {}), exitFn: vi.fn(), recordExit: vi.fn(), isSupervised: true });
describe('N72 observed restart outcome', () => {
  it('records a completed lifeline-only quiesce as kept', async () => {
    const d = deps(); await new RestartOrchestrator(d).requestRestart({ reason: 'conflict409Stuck', bucket: 'watchdog', keepServer: true });
    expect(d.recordExit).toHaveBeenCalledWith({ reason: 'conflict409Stuck', bucket: 'watchdog', serverOutcome: 'kept', overrideReason: null });
  });
  it.each([true, false, null])('stop observation %s is required independently of a resolved stop', async (seen) => {
    const d = { ...deps(), observeServerStopped: () => seen };
    await new RestartOrchestrator(d).requestRestart({ reason: 'consecutiveFailures', bucket: 'watchdog' });
    expect(d.recordExit.mock.calls[0][0].serverOutcome).toBe(seen === true ? 'stopped' : 'unknown');
  });
  it('late stop overrides kept and records failed stop as unknown', async () => {
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    const d = { ...deps(), persistAll: () => wait, stopServer: vi.fn(async () => { throw Error('tmux kill failed'); }), observeServerStopped: () => false };
    const o = new RestartOrchestrator(d);
    const first = o.requestRestart({ reason: 'conflict409Stuck', bucket: 'watchdog', keepServer: true });
    while (o.state !== 'persisting') await Promise.resolve();
    await o.requestRestart({ reason: 'external-signal', bucket: 'watchdog' });
    release(); await first;
    expect(d.stopServer).toHaveBeenCalledOnce();
    expect(d.recordExit.mock.calls[0][0]).toMatchObject({ serverOutcome: 'unknown', overrideReason: 'external-signal' });
  });
  it('a hard exit during persistence after a late stop override cannot record kept', async () => {
    vi.useFakeTimers();
    const d = { ...deps(), persistAll: () => new Promise<void>(() => {}) };
    const o = new RestartOrchestrator({ ...d, hardKillMs: 10, persistBudgetMs: 100 });
    const first = o.requestRestart({ reason: 'conflict409Stuck', bucket: 'watchdog', keepServer: true });
    while (o.state !== 'persisting') await Promise.resolve();
    await o.requestRestart({ reason: 'external-signal', bucket: 'watchdog' });
    await vi.advanceTimersByTimeAsync(11);
    expect(d.exitFn).toHaveBeenCalledWith(1);
    expect(d.recordExit).toHaveBeenCalledOnce();
    expect(d.recordExit.mock.calls[0][0]).toMatchObject({ serverOutcome: 'unknown', overrideReason: 'external-signal' });
    await vi.advanceTimersByTimeAsync(100); await first;
  });
  it('quiesce timeout remains unknown', async () => {
    vi.useFakeTimers();
    const d = { ...deps(), quiesce: () => new Promise<void>(() => {}) };
    const first = new RestartOrchestrator(d).requestRestart({ reason: 'conflict409Stuck', bucket: 'watchdog', keepServer: true });
    await vi.advanceTimersByTimeAsync(1100); await first;
    expect(d.recordExit.mock.calls[0][0].serverOutcome).toBe('unknown');
  });
});

describe('failed supervisor stop is not confirmed by a resolved promise', () => {
  it('a failed tmux command leaves independent observation unknown', async () => {
    const { ServerSupervisor } = await import('../../../src/lifeline/ServerSupervisor.js');
    const supervisor = new ServerSupervisor({ projectDir: '/tmp/n72-no-agent', projectName: 'n72-no-agent', port: 0 });
    (supervisor as any).tmuxPath = '/definitely-not-a-tmux-binary';
    vi.spyOn(supervisor as any, 'isServerSessionAlive').mockReturnValue(true);
    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(supervisor.observeServerStopped()).toBeNull();
  });
});
