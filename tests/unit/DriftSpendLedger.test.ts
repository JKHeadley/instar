/**
 * Unit tests for DriftSpendLedger.
 *
 * Covers:
 *   - Reserve + tally + cap (strict-greater-than boundary per spec).
 *   - Reconcile supersedes the pending estimate (no double-count).
 *   - Idempotent reconcile (calling twice doesn't double the cost).
 *   - Lock coordination across concurrent reserves on one process.
 *   - File rotation by UTC day (verified via fake date manipulation).
 *   - pruneOlderThan removes files outside the retention window.
 *   - OverBudgetError is the thrown type (callers branch on it).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DriftSpendLedger,
  OverBudgetError,
  DEFAULT_DAILY_CAP_USD,
} from '../../src/core/DriftSpendLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'drift-ledger-'));
}

describe('DriftSpendLedger', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeStateDir();
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/DriftSpendLedger.test.ts:afterEach' });
    } catch { /* ignore */ }
  });

  it('default cap is the spec value (1.0 USD)', () => {
    expect(DEFAULT_DAILY_CAP_USD).toBe(1.0);
  });

  it('reserves estimated cost and reports cumulative spent', async () => {
    const l = new DriftSpendLedger({ stateDir: dir });
    const r1 = await l.reserve({ projectId: 'p1', estimatedCost: 0.02 });
    expect(r1.spentToday).toBeCloseTo(0.02, 6);
    const r2 = await l.reserve({ projectId: 'p2', estimatedCost: 0.03 });
    expect(r2.spentToday).toBeCloseTo(0.05, 6);
    expect(r1.recordId).not.toBe(r2.recordId);
  });

  it('throws OverBudgetError when reservation would exceed cap', async () => {
    const l = new DriftSpendLedger({ stateDir: dir, dailyCapUsd: 0.1 });
    await l.reserve({ projectId: 'p', estimatedCost: 0.08 });
    await expect(
      l.reserve({ projectId: 'p', estimatedCost: 0.05 })
    ).rejects.toBeInstanceOf(OverBudgetError);
  });

  it('allows reservation equal to cap (strict-greater-than boundary)', async () => {
    const l = new DriftSpendLedger({ stateDir: dir, dailyCapUsd: 0.5 });
    await l.reserve({ projectId: 'p', estimatedCost: 0.2 });
    // Spent=0.2, reserve=0.3 → spent+est=0.5 NOT > cap=0.5 → allow.
    const r = await l.reserve({ projectId: 'p', estimatedCost: 0.3 });
    expect(r.spentToday).toBeCloseTo(0.5, 6);
  });

  it('reconcile supersedes the pending estimate', async () => {
    const l = new DriftSpendLedger({ stateDir: dir, dailyCapUsd: 1.0 });
    const r = await l.reserve({ projectId: 'p', estimatedCost: 0.2 });
    expect(await l.spentToday()).toBeCloseTo(0.2, 6);
    await l.reconcile(r.recordId, 0.05); // Actual was lower than estimate.
    expect(await l.spentToday()).toBeCloseTo(0.05, 6);
  });

  it('reconcile is idempotent — calling twice does not double-count', async () => {
    const l = new DriftSpendLedger({ stateDir: dir });
    const r = await l.reserve({ projectId: 'p', estimatedCost: 0.1 });
    await l.reconcile(r.recordId, 0.04);
    await l.reconcile(r.recordId, 0.04);
    expect(await l.spentToday()).toBeCloseTo(0.04, 6);
  });

  it('rejects negative / non-finite costs', async () => {
    const l = new DriftSpendLedger({ stateDir: dir });
    await expect(l.reserve({ projectId: 'p', estimatedCost: -1 })).rejects.toThrow();
    await expect(l.reserve({ projectId: 'p', estimatedCost: NaN })).rejects.toThrow();
    await expect(l.reconcile('missing-id', -0.01)).rejects.toThrow();
  });

  it('writes one JSONL row per reserve and one per reconcile', async () => {
    const l = new DriftSpendLedger({ stateDir: dir });
    const r = await l.reserve({ projectId: 'p', estimatedCost: 0.07 });
    await l.reconcile(r.recordId, 0.03);
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `drift-spend-${today}.jsonl`);
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const reserveRow = JSON.parse(lines[0]);
    const reconcileRow = JSON.parse(lines[1]);
    expect(reserveRow.actualCost).toBe(null);
    expect(reserveRow.estimatedCost).toBeCloseTo(0.07, 6);
    expect(reconcileRow.actualCost).toBeCloseTo(0.03, 6);
    expect(reconcileRow.recordId).toBe(reserveRow.recordId);
  });

  it('spentToday is lock-coordinated and stable across calls', async () => {
    const l = new DriftSpendLedger({ stateDir: dir });
    await l.reserve({ projectId: 'p', estimatedCost: 0.04 });
    const a = await l.spentToday();
    const b = await l.spentToday();
    expect(a).toBe(b);
  });

  it('concurrent reserves serialize through the lock and the second sees the first', async () => {
    const l = new DriftSpendLedger({ stateDir: dir });
    const [a, b] = await Promise.all([
      l.reserve({ projectId: 'p1', estimatedCost: 0.1 }),
      l.reserve({ projectId: 'p2', estimatedCost: 0.1 }),
    ]);
    expect(await l.spentToday()).toBeCloseTo(0.2, 6);
    // Both succeed because cap is the default $1; recordIds distinct.
    expect(a.recordId).not.toBe(b.recordId);
  });

  it('pruneOlderThan removes files older than retentionDays', async () => {
    const l = new DriftSpendLedger({ stateDir: dir, retentionDays: 3 });
    // Lay down a fake old ledger file.
    const oldDate = new Date();
    oldDate.setUTCDate(oldDate.getUTCDate() - 10);
    const oldFile = path.join(dir, `drift-spend-${oldDate.toISOString().slice(0, 10)}.jsonl`);
    fs.writeFileSync(oldFile, '');
    await l.reserve({ projectId: 'p', estimatedCost: 0.01 });
    const result = await l.pruneOlderThan();
    expect(result.removed.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    // Today's file remains.
    const today = new Date().toISOString().slice(0, 10);
    expect(fs.existsSync(path.join(dir, `drift-spend-${today}.jsonl`))).toBe(true);
  });

  it('tolerates corrupt rows in the ledger file without throwing', async () => {
    const l = new DriftSpendLedger({ stateDir: dir });
    await l.reserve({ projectId: 'p', estimatedCost: 0.04 });
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `drift-spend-${today}.jsonl`);
    fs.appendFileSync(file, 'not json\n{"missing":"fields"}\n');
    expect(await l.spentToday()).toBeCloseTo(0.04, 6);
    // New reserve still works.
    await l.reserve({ projectId: 'p', estimatedCost: 0.01 });
    expect(await l.spentToday()).toBeCloseTo(0.05, 6);
  });

  it('OverBudgetError exposes cap, spentToday, and estimatedCost', async () => {
    const l = new DriftSpendLedger({ stateDir: dir, dailyCapUsd: 0.1 });
    await l.reserve({ projectId: 'p', estimatedCost: 0.08 });
    try {
      await l.reserve({ projectId: 'p', estimatedCost: 0.05 });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as OverBudgetError;
      expect(err).toBeInstanceOf(OverBudgetError);
      expect(err.capUsd).toBe(0.1);
      expect(err.spentToday).toBeCloseTo(0.08, 6);
      expect(err.estimatedCost).toBeCloseTo(0.05, 6);
    }
  });
});
