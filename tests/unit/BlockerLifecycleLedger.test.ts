import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlockerLifecycleLedger, percentile } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('BlockerLifecycleLedger', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach(dir => SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true, operation: 'tests/unit/BlockerLifecycleLedger.test.ts',
  })));

  it('is idempotent by origin, factor, and source event', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-ledger-')); dirs.push(dir);
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(dir, 'ledger.db') });
    const row = { origin: 'machine-a', factor: 'clear-latency' as const, sourceEventId: 'clear-1',
      observedAtMs: 10_000, latencyMs: 25, outcome: 'observed' as const };
    expect(ledger.record(row, true)).toBe(true);
    expect(ledger.record(row, true)).toBe(true);
    expect(ledger.values('clear-latency', 0)).toEqual([{ observedAtMs: 10_000, latencyMs: 25, outcome: 'observed' }]);
    expect(ledger.counters()).toMatchObject({ inserted: 1, deduped: 1, reconciled: 1 });
    ledger.close();
  });

  it('uses nearest-rank percentiles', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([9, 1, 5, 3], 0.5)).toBe(3);
    expect(percentile([9, 1, 5, 3], 0.95)).toBe(9);
  });
});
