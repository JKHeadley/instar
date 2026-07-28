import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PlaywrightSeatLease', () => {
  let dir: string;
  let filePath: string;
  let now: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-seat-'));
    filePath = path.join(dir, 'shared', 'seat.json');
    now = Date.parse('2026-07-16T22:00:00.000Z');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'PlaywrightSeatLease test cleanup' });
  });

  const lease = () => new PlaywrightSeatLease({ filePath, now: () => now, ttlMs: 1_000 });

  it('renews idempotently for one drive and preserves its acquisition time', () => {
    const first = lease().acquire('agent-a:topic-1', 'topic-1');
    expect(first.acquired).toBe(true);
    now += 500;
    const renewed = lease().acquire('agent-a:topic-1', 'topic-1');
    expect(renewed.acquired).toBe(true);
    if (!first.acquired || !renewed.acquired) throw new Error('expected acquired leases');
    expect(renewed.lease.acquiredAt).toBe(first.lease.acquiredAt);
    expect(Date.parse(renewed.lease.expiresAt)).toBe(now + 1_000);
  });

  it('blocks a different drive while the physical seat lease is live', () => {
    lease().acquire('agent-a:topic-1', 'topic-1');
    now += 250;
    const conflict = lease().acquire('agent-b:topic-2', 'topic-2');
    expect(conflict).toEqual({
      acquired: false,
      holderLabel: 'topic-1',
      retryAfterMs: 750,
      expiresAt: '2026-07-16T22:00:01.000Z',
    });
  });

  it('reclaims an expired lease after a crashed or quiet drive', () => {
    lease().acquire('agent-a:topic-1', 'topic-1');
    now += 1_001;
    const reclaimed = lease().acquire('agent-b:topic-2', 'topic-2');
    expect(reclaimed.acquired).toBe(true);
    if (!reclaimed.acquired) throw new Error('expected reclaimed lease');
    expect(reclaimed.lease.holderId).toBe('agent-b:topic-2');
  });

  it('replaces corrupt state under the exclusive lock', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{bad');
    const acquired = lease().acquire('agent-a:topic-1', 'topic-1');
    expect(acquired.acquired).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).holderId).toBe('agent-a:topic-1');
  });

  it('voluntarily releases only for the current holder', () => {
    lease().acquire('script-a', 'standalone A');
    expect(lease().release('script-b')).toMatchObject({ released: false, reason: 'ownership-mismatch' });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(lease().release('script-a')).toEqual({ released: true });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(lease().release('script-a')).toEqual({ released: false, reason: 'not-held' });
  });
});
