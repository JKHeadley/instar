import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  writeServeProgress,
  readServeProgress,
  serveProgressFresh,
} from '../../src/core/serveProgress.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serveprog-')); });
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/serveProgress.test.ts' }); } catch { /* best-effort */ } });

describe('serveProgress — G1 third liveness watermark', () => {
  it('write → read roundtrip', () => {
    writeServeProgress(dir, { bootId: 'boot-A', serverPid: 100, monoMs: 5000 });
    const rec = readServeProgress(dir);
    expect(rec?.serveProgressedMonoMs).toBe(5000);
    expect(rec?.bootId).toBe('boot-A');
    expect(rec?.serverPid).toBe(100);
  });

  it('missing file → null / not fresh', () => {
    expect(readServeProgress(dir)).toBeNull();
    expect(serveProgressFresh(dir, 'boot-A', 9999, 30_000)).toBe(false);
  });

  it('monotonic-MAX: a lower (or equal) monoMs in the SAME incarnation never regresses', () => {
    writeServeProgress(dir, { bootId: 'boot-A', serverPid: 100, monoMs: 5000 });
    writeServeProgress(dir, { bootId: 'boot-A', serverPid: 100, monoMs: 4000 }); // older — dropped
    writeServeProgress(dir, { bootId: 'boot-A', serverPid: 100, monoMs: 5000 }); // equal — dropped
    expect(readServeProgress(dir)?.serveProgressedMonoMs).toBe(5000);
    writeServeProgress(dir, { bootId: 'boot-A', serverPid: 100, monoMs: 6000 }); // newer — advances
    expect(readServeProgress(dir)?.serveProgressedMonoMs).toBe(6000);
  });

  it('a NEW incarnation (different bootId) always overwrites (own clock domain)', () => {
    writeServeProgress(dir, { bootId: 'boot-A', serverPid: 100, monoMs: 9000 });
    // boot-B's monotonic clock restarts low; it must overwrite, not be blocked by A's high stamp.
    writeServeProgress(dir, { bootId: 'boot-B', serverPid: 200, monoMs: 10 });
    const rec = readServeProgress(dir);
    expect(rec?.bootId).toBe('boot-B');
    expect(rec?.serveProgressedMonoMs).toBe(10);
  });

  it('freshness: within threshold (same incarnation) → fresh; past it → stale', () => {
    writeServeProgress(dir, { bootId: 'boot-A', serverPid: 100, monoMs: 1000 });
    expect(serveProgressFresh(dir, 'boot-A', 1000 + 10_000, 30_000)).toBe(true);  // 10s < 30s
    expect(serveProgressFresh(dir, 'boot-A', 1000 + 40_000, 30_000)).toBe(false); // 40s > 30s
  });

  it('BOOT-EPOCH FENCE: a prior-incarnation stamp reads NOT fresh, even if recent (the zombie-mask guard)', () => {
    // A crashed process left a fresh-looking stamp under boot-A; the new process is boot-B.
    writeServeProgress(dir, { bootId: 'boot-A', serverPid: 100, monoMs: 1000 });
    // boot-B reads: even with currentMonoMs right next to the stamp, the bootId mismatch
    // forces NOT fresh — so a crash-stale stamp can never mask a non-serving new process.
    expect(serveProgressFresh(dir, 'boot-B', 1000 + 1, 30_000)).toBe(false);
  });
});
