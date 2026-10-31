import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopAssertionReplayStore } from '../../src/core/DesktopAssertionReplayStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('DesktopAssertionReplayStore', () => {
  it('refuses reuse after a target process restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-replay-'));
    try {
      const file = path.join(dir, 'state.json');
      const jti = 'A'.repeat(32);
      new DesktopAssertionReplayStore(file, () => 100).record(jti, 30_100);
      const restarted = new DesktopAssertionReplayStore(file, () => 200);
      expect(restarted.seen(jti)).toBe(true);
      expect(() => restarted.record(jti, 30_100)).toThrow('desktop-operator-replayed');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-assertion-replay-store-test-cleanup' }); }
  });

  it('denies admission if replay state is unreadable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-replay-'));
    try {
      const file = path.join(dir, 'state.json');
      fs.writeFileSync(file, '{invalid');
      const store = new DesktopAssertionReplayStore(file, () => 100);
      expect(() => store.seen('B'.repeat(32))).toThrow();
      expect(() => store.record('B'.repeat(32), 30_100)).toThrow();
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-assertion-replay-store-test-cleanup' }); }
  });

  it('refuses an oversized replay ledger before parsing it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-replay-'));
    try {
      const file = path.join(dir, 'state.json');
      fs.writeFileSync(file, ' '.repeat(100_001));
      expect(() => new DesktopAssertionReplayStore(file).seen('C'.repeat(32)))
        .toThrow('desktop-replay-ledger-over-capacity');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-assertion-replay-store-test-cleanup' }); }
  });
});
