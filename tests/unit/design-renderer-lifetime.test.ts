import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRendererLifetime, createOwnedCleanup } from '../design/harness/rendererLifetime.mjs';
let now: number;
beforeEach(() => { vi.useFakeTimers(); now = 0; });
afterEach(() => vi.useRealTimers());
const advance = async (ms: number) => { now += ms; await vi.advanceTimersByTimeAsync(ms); };
function lifetime() { return createRendererLifetime({ now: () => now, screenMs: 60_000, stepMs: 120_000 }); }
function held(life: ReturnType<typeof lifetime>, close?: () => Promise<void>) {
 const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null as string | null });
 let alive = true;
 const exit = (signal: string | null = null) => { alive = false; child.exitCode = signal ? null : 0; child.signalCode = signal; child.emit('exit', child.exitCode, signal); };
 const server = { process: () => child, close: vi.fn(close ?? (async () => { exit(); })), kill: vi.fn(async () => { exit('SIGKILL'); }) };
 const owner = createOwnedCleanup({ lifetime: life, verifyServer: () => ({ pid: 123, spawnfile: '/owned/shell', profileDir: '/owned/lv-tmp-run/profile' }), isAlive: () => alive });
 return { owner, server, child, exit };
}
it('cancels an absolute screen deadline and rejects late work without promotion', async () => {
 const life = lifetime(); let resolve!: (value: string) => void;
 const work = life.phase('body-drain', () => new Promise<string>(done => { resolve = done; }));
 const rejected = expect(work).rejects.toThrow(); await Promise.resolve(); await advance(60_000); await rejected;
 resolve('late success'); await Promise.resolve(); expect(life.snapshot().canceled).toBe(true); expect(() => life.check()).toThrow(); life.dispose();
});
it('records real elapsed overrun even before a delayed timer callback runs', () => {
 const life = lifetime(); now = 60_001; expect(() => life.check()).toThrow(); expect(life.snapshot().overrunMs).toBe(1); life.dispose();
});
it('shares one graceful cleanup and verifies actual child exit', async () => {
 const life = lifetime(), h = held(life); h.owner.registerLaunch(Promise.resolve(h.server));
 const first = h.owner.cleanup(), second = h.owner.cleanup(); expect(first).toBe(second);
 expect((await first).status).toBe('closed-gracefully'); expect(h.server.close).toHaveBeenCalledTimes(1); expect(h.server.kill).not.toHaveBeenCalled(); life.dispose();
});
it('immediately cleans a late launch after cancellation and never grants new work', async () => {
 const life = lifetime(), h = held(life); let resolve!: (server: typeof h.server) => void;
 h.owner.registerLaunch(new Promise(done => { resolve = done; })); life.cancel('parent-cancel');
 const closing = h.owner.cleanup(); resolve(h.server); expect((await closing).status).toBe('closed-gracefully');
 expect(() => life.check()).toThrow(); expect(h.server.close).toHaveBeenCalledTimes(1); life.dispose();
});
it('uses one verified held-server kill when graceful close stalls', async () => {
 const life = lifetime(), h = held(life, () => new Promise(() => {})); h.owner.registerLaunch(Promise.resolve(h.server));
 const closing = h.owner.cleanup(); await Promise.resolve(); await Promise.resolve(); await advance(30_000);
 expect((await closing).status).toBe('closed-forced'); expect(h.server.kill).toHaveBeenCalledTimes(1); expect(life.snapshot().canceled).toBe(true); life.dispose();
});
it('refuses fallback on an identity mismatch and retains unconfirmed ownership', async () => {
 const life = lifetime(), h = held(life, () => new Promise(() => {}));
 const owner = createOwnedCleanup({ lifetime: life, verifyServer: () => { throw new Error('wrong owned profile'); }, isAlive: () => true });
 owner.registerLaunch(Promise.resolve(h.server)); const closing = owner.cleanup(); await Promise.resolve(); await advance(30_000);
 expect((await closing).status).toBe('cleanup-unconfirmed'); expect(h.server.kill).not.toHaveBeenCalled(); life.dispose();
});
it('does not claim exit when a kill resolves but the actual child stays alive', async () => {
 const life = lifetime(), h = held(life, () => new Promise(() => {})); h.server.kill.mockImplementation(async () => {});
 h.owner.registerLaunch(Promise.resolve(h.server)); const closing = h.owner.cleanup(); await Promise.resolve(); await advance(30_000); await advance(90_000);
 expect((await closing).status).toBe('cleanup-unconfirmed'); expect(h.server.kill).toHaveBeenCalledTimes(1); life.dispose();
});

it('does not begin launch after an already received parent cancellation', async () => {
 const life = lifetime(), launch = vi.fn(); life.cancel('parent-cancel');
 await expect(life.phase('launch', launch)).rejects.toThrow(); expect(launch).not.toHaveBeenCalled(); life.dispose();
});
it('shortens graceful closure to the actual remaining screen allowance', async () => {
 const life = lifetime(), h = held(life, () => new Promise(() => {})); now = 50_000;
 h.owner.registerLaunch(Promise.resolve(h.server)); const closing = h.owner.cleanup(); await Promise.resolve(); await Promise.resolve();
 await advance(10_000); expect((await closing).status).toBe('closed-forced'); expect(life.snapshot().canceled).toBe(true);
 expect(life.snapshot().events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'cleanup-start', name: 'official-close', allowanceMs: 10_000 })])); life.dispose();
});
it('retains a missing launch handle at the step deadline and cleans the same late server when it arrives', async () => {
 const life = lifetime(), h = held(life); let resolve!: (value: typeof h.server) => void;
 h.owner.registerLaunch(new Promise(done => { resolve = done; })); const closing = h.owner.cleanup();
 await advance(120_000); expect(await closing).toMatchObject({ status: 'cleanup-unconfirmed', missingHandle: true });
 resolve(h.server); for (let i = 0; i < 10; i++) await Promise.resolve();
 expect(h.server.close).toHaveBeenCalledTimes(1); expect(life.snapshot().canceled).toBe(true); life.dispose();
});

it('checks cancellation again at the actual queued work admission boundary', async () => {
 const life = lifetime(), launch = vi.fn(); const work = life.phase('launch', launch); life.cancel('parent-cancel');
 await expect(work).rejects.toThrow(); expect(launch).not.toHaveBeenCalled(); life.dispose();
});
