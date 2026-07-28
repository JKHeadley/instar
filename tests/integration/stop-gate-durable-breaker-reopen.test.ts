import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { StopGateDb } from '../../src/core/StopGateDb.js';
import { UnjustifiedStopGate, type EvaluateInput } from '../../src/core/UnjustifiedStopGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const INPUT: EvaluateInput = {
  evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: null },
  untrustedContent: { stopReason: 'done', recentTurns: [] },
};

describe('Stop-gate durable breaker — real SQLite reopen', () => {
  let dir = '';
  afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/stop-gate-durable-breaker-reopen.test.ts' }); });

  it('hydrates the open state from a newly opened database handle', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-breaker-'));
    const dbPath = path.join(dir, 'stop-gate.db');
    let calls = 0;
    const intelligence = { evaluate: async () => { calls += 1; throw new Error('slow provider'); } };

    const firstDb = new StopGateDb({ dbPath });
    const first = new UnjustifiedStopGate({
      intelligence,
      breakerThreshold: 2,
      breakerCooldownMs: 60_000,
      breakerStateStore: firstDb,
      breakerKey: 'stable-route',
    });
    await first.evaluate(INPUT);
    await first.evaluate(INPUT);
    firstDb.close();

    const reopenedDb = new StopGateDb({ dbPath });
    const afterRestart = new UnjustifiedStopGate({
      intelligence,
      breakerThreshold: 2,
      breakerCooldownMs: 60_000,
      breakerStateStore: reopenedDb,
      breakerKey: 'stable-route',
    });
    const result = await afterRestart.evaluate(INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('breakerOpen');
    expect(calls).toBe(2);

    // A real routing change gets a fresh key and may probe immediately.
    const changedRoute = new UnjustifiedStopGate({
      intelligence,
      breakerThreshold: 2,
      breakerCooldownMs: 60_000,
      breakerStateStore: reopenedDb,
      breakerKey: 'changed-route',
    });
    await changedRoute.evaluate(INPUT);
    expect(calls).toBe(3);
    reopenedDb.close();
  });

  it('bounds restart-adjacent write-lock contention and signals memory fallback', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-breaker-lock-'));
    const dbPath = path.join(dir, 'stop-gate.db');
    const store = new StopGateDb({ dbPath });
    const lock = new Database(dbPath);
    lock.pragma('journal_mode = WAL');
    lock.exec('BEGIN IMMEDIATE');
    let persistenceSignals = 0;
    const gate = new UnjustifiedStopGate({
      intelligence: { evaluate: async () => { throw new Error('provider down'); } },
      breakerThreshold: 2,
      breakerStateStore: store,
      breakerKey: 'locked-route',
      onBreakerPersistenceError: () => { persistenceSignals += 1; },
    });
    const started = performance.now();
    const result = await gate.evaluate(INPUT);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('llmUnavailable');
    expect(elapsed).toBeLessThan(250);
    expect(persistenceSignals).toBe(1);
    lock.exec('ROLLBACK');
    lock.close();
    store.close();
  });

  it('prunes breaker routes older than 30 days when the database reopens', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-breaker-retention-'));
    const dbPath = path.join(dir, 'stop-gate.db');
    const first = new StopGateDb({ dbPath });
    first.recordBreakerFailure({ breakerKey: 'stale', now: 1, threshold: 1, cooldownMs: 100 });
    first.recordBreakerFailure({ breakerKey: 'current', now: Date.now(), threshold: 1, cooldownMs: 100 });
    first.close();

    const reopened = new StopGateDb({ dbPath });
    expect(reopened.loadBreakerState('stale')).toBeNull();
    expect(reopened.loadBreakerState('current')).not.toBeNull();
    reopened.close();
  });
});
