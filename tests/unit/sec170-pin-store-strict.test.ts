// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * SEC-170 part 1 of 2 (docs/specs/pool-wide-pin-budget.md §3): with the pool-wide budget on, a wrong
 * guess on the shared unknown-browser key that cannot be written refuses further unknown browsers
 * until a write succeeds (fail toward stricter). With it off, today's behaviour is unchanged. The
 * email-code check reads the live share.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PinAttemptStore, GLOBAL_PIN_KEY } from '../../src/core/PinAttemptStore.js';
import { createMandatePinCheck } from '../../src/server/mandatePin.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import * as PinShareMod from '../../src/core/PinShare.js';

describe('SEC-170 — PinAttemptStore fails toward stricter when on', () => {
  let tmp: string;
  let t: number;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec170-store-'));
    t = 1_000_000;
    vi.spyOn(DegradationReporter, 'getInstance').mockReturnValue({ report: vi.fn() } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/sec170-pin-store-strict.test.ts' }); });

  it('on: a failed write of the shared key refuses until a write succeeds, retried at most once a second', () => {
    const store = new PinAttemptStore({ stateDir: tmp, now: () => t, strictGlobal: () => true });
    const spy = vi.spyOn(PinShareMod, 'writeDurable').mockImplementation(() => { throw new Error('disk full'); });
    store.recordFailure(GLOBAL_PIN_KEY, 4);
    expect(store.blocked(GLOBAL_PIN_KEY, 4)).toBe(true);
    spy.mockRestore();
    expect(store.blocked(GLOBAL_PIN_KEY, 4)).toBe(true); // within the same second: no retry yet
    t += 1000;
    expect(store.blocked(GLOBAL_PIN_KEY, 4)).toBe(false); // retried, written, cleared (1 of 4 used)
  });

  it('off: a failed write keeps today\'s in-memory enforcement and does not refuse', () => {
    const store = new PinAttemptStore({ stateDir: tmp, now: () => t, strictGlobal: () => false });
    const spy = vi.spyOn(PinShareMod, 'writeDurable').mockImplementation(() => { throw new Error('disk full'); });
    store.recordFailure(GLOBAL_PIN_KEY, 4);
    expect(store.blocked(GLOBAL_PIN_KEY, 4)).toBe(false);
    spy.mockRestore();
  });

  it('a cap of 0 refuses even the first attempt in a window (no free guess for a share-0 machine)', () => {
    const store = new PinAttemptStore({ stateDir: tmp, now: () => t, strictGlobal: () => true });
    expect(store.blocked(GLOBAL_PIN_KEY, 0)).toBe(true);
  });

  it('counts survive a restart (flushed write)', () => {
    const a = new PinAttemptStore({ stateDir: tmp, now: () => t, strictGlobal: () => true });
    for (let i = 0; i < 4; i++) a.recordFailure(GLOBAL_PIN_KEY, 4);
    const b = new PinAttemptStore({ stateDir: tmp, now: () => t, strictGlobal: () => true });
    expect(b.blocked(GLOBAL_PIN_KEY, 4)).toBe(true);
  });
});

describe('SEC-170 — the email-code check reads the live share', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec170-mandate-'));
    vi.spyOn(DegradationReporter, 'getInstance').mockReturnValue({ report: vi.fn() } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/sec170-pin-store-strict.test.ts' }); });

  const res = () => { const r: { statusCode: number; body?: unknown; status: (c: number) => typeof r; json: (b: unknown) => typeof r } = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; return r; };

  it('refuses after the share, not after 20', () => {
    const store = new PinAttemptStore({ stateDir: tmp });
    let share = 4;
    const check = createMandatePinCheck({ dashboardPin: () => '123456', pinAttemptStore: () => store, pinSource: () => GLOBAL_PIN_KEY, maxAttempts: 20, maxAttemptsLive: () => share, clearOnSuccess: false });
    for (let i = 0; i < 4; i++) { const r = res(); expect(check({ body: { pin: '000000' } } as never, r as never)).toBe(false); expect(r.statusCode).toBe(403); }
    const r = res();
    expect(check({ body: { pin: '123456' } } as never, r as never)).toBe(false);
    expect(r.statusCode).toBe(429);
    share = 0;
    const r0 = res();
    expect(check({ body: { pin: '123456' } } as never, r0 as never)).toBe(false);
    expect(r0.statusCode).toBe(429);
    share = 20;
    const r2 = res();
    expect(check({ body: { pin: '123456' } } as never, r2 as never)).toBe(true);
  });
});
