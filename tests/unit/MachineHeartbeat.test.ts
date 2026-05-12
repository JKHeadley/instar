/**
 * Unit tests for MachineHeartbeat.
 *
 * Covers:
 *   - writeOnce produces a valid record on disk
 *   - read returns null when the file is missing or malformed
 *   - isStale returns true on missing / malformed / older-than-threshold
 *   - isStale returns false on a fresh heartbeat
 *   - listAll surfaces every known machine
 *   - machineId with weird characters is URL-encoded in the file name
 *   - start + stop manage the interval timer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineHeartbeat } from '../../src/core/MachineHeartbeat.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mh-'));
}

describe('MachineHeartbeat', () => {
  let dir: string;
  beforeEach(() => { dir = makeStateDir(); });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/MachineHeartbeat.test.ts:afterEach' }); } catch { /* ignore */ }
  });

  it('writeOnce produces a valid record', () => {
    const h = new MachineHeartbeat({ stateDir: dir, machineId: 'm-A', instarVersion: '0.0.1' });
    const r = h.writeOnce();
    expect(r.machineId).toBe('m-A');
    expect(r.hostname).toBe(os.hostname());
    expect(typeof r.lastHeartbeatAt).toBe('string');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'machine-health', 'm-A.json'), 'utf-8'));
    expect(onDisk.machineId).toBe('m-A');
    expect(onDisk.instarVersion).toBe('0.0.1');
  });

  it('read returns null for an unknown machine', () => {
    const h = new MachineHeartbeat({ stateDir: dir, machineId: 'm-A' });
    expect(h.read('does-not-exist')).toBe(null);
  });

  it('read returns null for a malformed heartbeat file', () => {
    const h = new MachineHeartbeat({ stateDir: dir, machineId: 'm-A' });
    fs.mkdirSync(path.join(dir, 'machine-health'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'machine-health', 'broken.json'), 'not json');
    expect(h.read('broken')).toBe(null);
  });

  it('isStale returns true when no heartbeat exists', () => {
    const h = new MachineHeartbeat({ stateDir: dir, machineId: 'm-A' });
    expect(h.isStale('m-B')).toBe(true);
  });

  it('isStale returns false on a fresh heartbeat within the threshold', () => {
    const h = new MachineHeartbeat({ stateDir: dir, machineId: 'm-A', staleThresholdMs: 100_000 });
    h.writeOnce();
    expect(h.isStale('m-A')).toBe(false);
  });

  it('isStale returns true when the heartbeat is older than the threshold', () => {
    const now = new Date('2026-05-12T00:00:00Z');
    const stale = new MachineHeartbeat({
      stateDir: dir,
      machineId: 'm-A',
      staleThresholdMs: 1_000,
      now: () => now,
    });
    stale.writeOnce();
    // Move the clock forward past the threshold.
    const future = new Date('2026-05-12T00:00:02Z');
    const checker = new MachineHeartbeat({
      stateDir: dir,
      machineId: 'm-B',
      staleThresholdMs: 1_000,
      now: () => future,
    });
    expect(checker.isStale('m-A')).toBe(true);
  });

  it('listAll returns every machine that has a valid heartbeat', () => {
    const a = new MachineHeartbeat({ stateDir: dir, machineId: 'm-A' });
    const b = new MachineHeartbeat({ stateDir: dir, machineId: 'm-B' });
    a.writeOnce();
    b.writeOnce();
    const list = a.listAll();
    const ids = list.map((r) => r.machineId).sort();
    expect(ids).toEqual(['m-A', 'm-B']);
  });

  it('start writes immediately and stop clears the timer', async () => {
    const h = new MachineHeartbeat({
      stateDir: dir,
      machineId: 'm-A',
      heartbeatIntervalMs: 1000,
    });
    h.start();
    expect(fs.existsSync(path.join(dir, 'machine-health', 'm-A.json'))).toBe(true);
    h.stop();
    // No throw on a second stop — idempotent.
    h.stop();
  });

  it('sanitizes weird characters in machineId for the file name', () => {
    const h = new MachineHeartbeat({ stateDir: dir, machineId: 'weird/id with spaces' });
    h.writeOnce();
    const files = fs.readdirSync(path.join(dir, 'machine-health'));
    // No slash or space allowed in the file name.
    expect(files.every((f) => !f.includes('/') && !f.includes(' '))).toBe(true);
    // And read() round-trips via the same encoding.
    expect(h.read('weird/id with spaces')?.machineId).toBe('weird/id with spaces');
  });

  it('exposes the configured machineId via the id getter', () => {
    const h = new MachineHeartbeat({ stateDir: dir, machineId: 'm-A' });
    expect(h.id).toBe('m-A');
  });
});
