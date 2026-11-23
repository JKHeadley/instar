// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * identity-security-piece1c: the PIN guess counter store never fails open, never grows without
 * bound, and never pauses sign-in on a failed write.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GLOBAL_PIN_KEY, PIN_ATTEMPT_MAX_ROWS, PinAttemptStore } from '../../src/core/PinAttemptStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir = '';
const fresh = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-store-')); fs.mkdirSync(path.join(dir, 'state')); return dir; };
const file = () => path.join(dir, 'state', 'pin-attempts.json');
afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/pin-attempt-store-hardening.test.ts:cleanup' }); });

describe('PinAttemptStore load', () => {
  it('a missing file starts fresh, not paused', () => {
    const s = new PinAttemptStore({ stateDir: fresh() });
    expect(s.pausedAfterCorruptLoad).toBe(false);
    expect(s.blocked(GLOBAL_PIN_KEY, 20)).toBe(false);
  });

  for (const [name, body] of [['empty', ''], ['corrupt', '{not json'], ['negative count', JSON.stringify({ a: { count: -3, resetAt: Date.now() + 60_000 } })], ['non-integer count', JSON.stringify({ a: { count: 1.5, resetAt: Date.now() + 60_000 } })], ['array', '[]']] as const) {
    it(`a ${name} file is set aside and the global budget is held for one window, then resumes`, () => {
      fresh();
      fs.writeFileSync(file(), body);
      let now = 1_000_000;
      const s = new PinAttemptStore({ stateDir: dir, now: () => now });
      expect(s.pausedAfterCorruptLoad).toBe(true);
      expect(s.blocked(GLOBAL_PIN_KEY, 20)).toBe(true);
      expect(fs.readdirSync(path.join(dir, 'state')).some((f) => f.startsWith('pin-attempts.corrupt-'))).toBe(true);
      // a restart during the pause stays paused (the pause was written back as a valid file)
      const restarted = new PinAttemptStore({ stateDir: dir, now: () => now });
      expect(restarted.blocked(GLOBAL_PIN_KEY, 20)).toBe(true);
      expect(restarted.pausedAfterCorruptLoad).toBe(false);
      now += 5 * 60 * 1000 + 1;
      expect(s.blocked(GLOBAL_PIN_KEY, 20)).toBe(false);
    });
  }

  it('a valid file is kept across a restart (the aggregate survives)', () => {
    fresh();
    const a = new PinAttemptStore({ stateDir: dir });
    for (let i = 0; i < 20; i++) a.recordFailure(GLOBAL_PIN_KEY, 20);
    const b = new PinAttemptStore({ stateDir: dir });
    expect(b.blocked(GLOBAL_PIN_KEY, 20)).toBe(true);
    expect(b.pausedAfterCorruptLoad).toBe(false);
  });
});

describe('PinAttemptStore growth', () => {
  it('prunes expired rows and caps the row count without evicting a locked row', () => {
    fresh();
    let now = 1_000_000;
    const s = new PinAttemptStore({ stateDir: dir, now: () => now });
    for (let i = 0; i < 5; i++) s.recordFailure('locked-source');
    for (let i = 0; i < PIN_ATTEMPT_MAX_ROWS + 50; i++) s.recordFailure(`src-${i}`);
    const rows = Object.keys(JSON.parse(fs.readFileSync(file(), 'utf-8')));
    expect(rows.length).toBeLessThanOrEqual(PIN_ATTEMPT_MAX_ROWS);
    expect(s.blocked('locked-source')).toBe(true);
    now += 5 * 60 * 1000 + 1;
    s.recordFailure('later');
    expect(Object.keys(JSON.parse(fs.readFileSync(file(), 'utf-8')))).toEqual(['later']);
  });
});

describe('PinAttemptStore write failure', () => {
  it('keeps enforcing in memory when the file cannot be written', () => {
    fresh();
    const s = new PinAttemptStore({ stateDir: dir });
    fs.chmodSync(path.join(dir, 'state'), 0o500);
    try {
      for (let i = 0; i < 5; i++) s.recordFailure('x');
      expect(s.blocked('x')).toBe(true);
    } finally {
      fs.chmodSync(path.join(dir, 'state'), 0o700);
    }
  });
});
