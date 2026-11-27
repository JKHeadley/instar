/**
 * BootSlowCallbackAttributor: names the callback that holds the event loop during boot
 * (fb-756ec068-89d). Real async_hooks; each test blocks the loop on purpose.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { BootSlowCallbackAttributor, startBootSlowCallbackAttributor, trimStack } from '../../src/monitoring/BootSlowCallbackAttributor.js';

function busy(ms: number): void { const end = performance.now() + ms; while (performance.now() < end) { /* hold the loop */ } }

function scheduleSlowImmediate(ms: number): Promise<void> {
  return new Promise((resolve) => setImmediate(() => { busy(ms); resolve(); }));
}
function scheduleSlowTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => { busy(ms); resolve(); }, 1));
}

function startTimerChain(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 1)).then(() => busy(120));
}
function promiseInsideTimer(): Promise<void> {
  return new Promise<void>((done) => setTimeout(() => { void Promise.resolve().then(() => { busy(120); done(); }); }, 1));
}

let a: BootSlowCallbackAttributor | null = null;
afterEach(() => { a?.stop(); a = null; });

describe('BootSlowCallbackAttributor', () => {
  it('names a slow setImmediate with the code that scheduled it', async () => {
    const lines: string[] = [];
    a = new BootSlowCallbackAttributor({ thresholdMs: 80, log: (l) => lines.push(l) }).start();
    await scheduleSlowImmediate(120);
    const r = a.slow.find((x) => x.type === 'Immediate');
    expect(r).toBeDefined();
    expect(r!.ms).toBeGreaterThanOrEqual(100);
    expect(r!.scheduledAt).toContain('scheduleSlowImmediate');
    expect(lines.some((l) => l.startsWith('[boot-slow-callback] Immediate held the event loop'))).toBe(true);
  });

  it('names a slow timer', async () => {
    a = new BootSlowCallbackAttributor({ thresholdMs: 80, log: () => {} }).start();
    await scheduleSlowTimeout(120);
    const r = a.slow.find((x) => x.type === 'Timeout');
    expect(r?.scheduledAt).toContain('scheduleSlowTimeout');
  });

  it('a slow .then after a timer names the code that started the chain', async () => {
    a = new BootSlowCallbackAttributor({ thresholdMs: 80, log: () => {} }).start();
    await startTimerChain();
    const r = a.slow.find((x) => x.type === 'PROMISE');
    expect(r).toBeDefined();
    expect(r!.scheduledAt).toContain('startTimerChain');
    expect(r!.hops).toBe(1);
  });

  it('a slow promise started inside a timer callback names that timer\'s scheduler', async () => {
    a = new BootSlowCallbackAttributor({ thresholdMs: 80, log: () => {} }).start();
    await promiseInsideTimer();
    const r = a.slow.find((x) => x.type === 'PROMISE');
    expect(r).toBeDefined();
    expect(r!.scheduledAt).toContain('promiseInsideTimer');
  });

  it('callbacks under the threshold are not reported', async () => {
    a = new BootSlowCallbackAttributor({ thresholdMs: 500, log: () => {} }).start();
    await scheduleSlowImmediate(20);
    expect(a.slow).toHaveLength(0);
  });

  it('stops at the end of its window and reports nothing afterwards', async () => {
    const lines: string[] = [];
    a = new BootSlowCallbackAttributor({ thresholdMs: 50, windowMs: 1, log: (l) => lines.push(l) }).start();
    await new Promise((r) => setTimeout(r, 20));
    await scheduleSlowImmediate(80);
    expect(a.slow).toHaveLength(0);
    expect(lines.some((l) => l.includes('window closed'))).toBe(true);
  });

  it('keeps at most maxReports', async () => {
    a = new BootSlowCallbackAttributor({ thresholdMs: 30, maxReports: 2, log: () => {} }).start();
    for (let i = 0; i < 4; i++) await scheduleSlowImmediate(40);
    expect(a.slow).toHaveLength(2);
  });

  it('off when the gate is off', () => {
    expect(startBootSlowCallbackAttributor(false)).toBeNull();
    const on = startBootSlowCallbackAttributor(true, { log: () => {} });
    expect(on).not.toBeNull();
    on!.stop();
  });

  it('trimStack drops its own frames and node internals', () => {
    const raw = 'Error\n    at init (/x/BootSlowCallbackAttributor.ts:1:1)\n    at emitInit (node:internal/async_hooks:1:1)\n    at boot (/x/server.ts:10:5)';
    expect(trimStack(raw)).toBe('at boot (/x/server.ts:10:5)');
    expect(trimStack(undefined)).toBeNull();
  });
});
