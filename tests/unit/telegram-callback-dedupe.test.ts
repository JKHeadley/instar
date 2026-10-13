/**
 * TelegramCallbackDedupe: one button tap, one effect — across duplicate
 * deliveries and across a server restart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TelegramCallbackDedupe,
  CALLBACK_DEDUPE_MAX,
  CALLBACK_DEDUPE_TTL_MS,
} from '../../src/server/TelegramCallbackDedupe.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('TelegramCallbackDedupe', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-dedupe-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/telegram-callback-dedupe.test.ts' }));

  /** Claim and complete, the way the route does for a handled tap. */
  const handle = (d: TelegramCallbackDedupe, id: string | number) => { const c = d.claim(id); if (c === 'first') d.markDone(id); return c; };

  it('first delivery claims; a second delivery of a HANDLED tap is a duplicate', () => {
    const d = new TelegramCallbackDedupe(stateDir);
    expect(handle(d, 'cb-1')).toBe('first');
    expect(d.claim('cb-1')).toBe('duplicate');
    expect(d.duplicates).toBe(1);
  });

  it('a different tap is not a duplicate', () => {
    const d = new TelegramCallbackDedupe(stateDir);
    expect(handle(d, 'cb-1')).toBe('first');
    expect(handle(d, 'cb-2')).toBe('first');
  });

  it('numeric and string forms of one id are the same id', () => {
    const d = new TelegramCallbackDedupe(stateDir);
    expect(handle(d, 12345)).toBe('first');
    expect(d.claim('12345')).toBe('duplicate');
  });

  it('a claim survives a server restart', () => {
    expect(handle(new TelegramCallbackDedupe(stateDir), 'cb-1')).toBe('first');
    expect(new TelegramCallbackDedupe(stateDir).claim('cb-1')).toBe('duplicate');
  });

  describe('outcome is part of the record — a redelivery never reads as success unless the tap succeeded', () => {
    it('handler threw → duplicate-of-failed, also after a restart', () => {
      const d = new TelegramCallbackDedupe(stateDir);
      expect(d.claim('cb-x')).toBe('first');
      d.markFailed('cb-x');
      expect(d.claim('cb-x')).toBe('duplicate-of-failed');
      expect(new TelegramCallbackDedupe(stateDir).claim('cb-x')).toBe('duplicate-of-failed');
    });

    it('server stopped between claim and outcome → duplicate-of-unknown after the restart, and not re-applied', () => {
      const d = new TelegramCallbackDedupe(stateDir);
      expect(d.claim('cb-crash')).toBe('first'); // …process dies here: no markDone, no markFailed
      const restarted = new TelegramCallbackDedupe(stateDir);
      expect(restarted.claim('cb-crash')).toBe('duplicate-of-unknown');
    });

    it('a concurrent redelivery while the first is still running is also unknown, then done', () => {
      const d = new TelegramCallbackDedupe(stateDir);
      expect(d.claim('cb-slow')).toBe('first');
      expect(d.claim('cb-slow')).toBe('duplicate-of-unknown');
      d.markDone('cb-slow');
      expect(d.claim('cb-slow')).toBe('duplicate');
    });

    it('marking an id that was never claimed does nothing', () => {
      const d = new TelegramCallbackDedupe(stateDir);
      d.markFailed('never');
      d.markDone('never');
      expect(d.claim('never')).toBe('first');
    });
  });

  it('peek reports without claiming', () => {
    const d = new TelegramCallbackDedupe(null);
    expect(d.peek('cb-1')).toBe('none');
    expect(d.claim('cb-1')).toBe('first');
    expect(d.peek('cb-1')).toBe('duplicate-of-unknown');
    d.markDone('cb-1');
    expect(d.peek('cb-1')).toBe('duplicate');
  });

  describe('the guarantee is bounded by retention', () => {
    it('forgets a claim after the TTL, not before', () => {
      let now = 1_000_000;
      const d = new TelegramCallbackDedupe(stateDir, () => now);
      handle(d, 'old');
      now += CALLBACK_DEDUPE_TTL_MS - 1;
      expect(d.claim('old')).toBe('duplicate');
      now += 2;
      handle(d, 'newer'); // triggers pruning
      expect(d.claim('old')).toBe('first'); // past the bound it is no longer recognised
    });

    it('is bounded by count: the oldest is evicted, the newest kept', () => {
      let now = 1;
      const d = new TelegramCallbackDedupe(stateDir, () => now++);
      for (let i = 0; i < CALLBACK_DEDUPE_MAX + 50; i++) handle(d, `id-${i}`);
      expect(d.size).toBeLessThanOrEqual(CALLBACK_DEDUPE_MAX);
      expect(d.claim(`id-${CALLBACK_DEDUPE_MAX + 49}`)).toBe('duplicate');
      expect(d.claim('id-0')).toBe('first'); // evicted: no longer recognised
    });
  });

  it('an in-memory store (stateDir null) dedupes but writes nothing and survives no restart', () => {
    const d = new TelegramCallbackDedupe(null);
    expect(handle(d, 'cb-1')).toBe('first');
    expect(d.claim('cb-1')).toBe('duplicate');
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(new TelegramCallbackDedupe(null).claim('cb-1')).toBe('first');
  });

  it('a corrupt store starts empty and says so; an absent one is quiet', () => {
    expect(new TelegramCallbackDedupe(stateDir).corruptAtLoad).toBe(false);
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'telegram-callback-seen.json'), '{nope');
    const d = new TelegramCallbackDedupe(stateDir);
    expect(d.corruptAtLoad).toBe(true);
    expect(d.claim('cb-1')).toBe('first');
  });

  it('still dedupes in memory when the state file cannot be written', () => {
    fs.writeFileSync(path.join(stateDir, 'state'), 'a file where the directory should be');
    const d = new TelegramCallbackDedupe(stateDir);
    expect(handle(d, 'cb-1')).toBe('first');
    expect(d.claim('cb-1')).toBe('duplicate');
    expect(d.writeFailures).toBeGreaterThan(0);
  });
});
