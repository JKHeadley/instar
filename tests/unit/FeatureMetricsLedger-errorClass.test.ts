// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * CMT-2289 — error rows carry a fixed error class; reads expose it per feature
 * and on the reliability components; no message text is ever stored.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let ledger: FeatureMetricsLedger | null = null;
afterEach(() => { ledger?.close(); ledger = null; });

describe('FeatureMetricsLedger error classes (CMT-2289)', () => {
  it('records the class on error rows and breaks errors down per feature', () => {
    const l = (ledger = new FeatureMetricsLedger({ dbPath: ':memory:' }));
    for (let i = 0; i < 3; i++) l.record({ feature: 'UnjustifiedStopGate', outcome: 'error', errorClass: 'auth' });
    l.record({ feature: 'UnjustifiedStopGate', outcome: 'error', errorClass: 'timeout' });
    l.record({ feature: 'UnjustifiedStopGate', outcome: 'unclassified' });
    const f = l.byFeature().find((r) => r.feature === 'UnjustifiedStopGate')!;
    expect(f.llmErrors).toBe(4);
    expect(f.errorClasses).toEqual({ auth: 3, timeout: 1 });
  });

  it('ignores errorClass on non-error rows and clamps an unknown label to "other"', () => {
    const l = (ledger = new FeatureMetricsLedger({ dbPath: ':memory:' }));
    l.record({ feature: 'G', outcome: 'noop', errorClass: 'auth' });
    l.record({ feature: 'G', outcome: 'error', errorClass: 'Command failed: secret-ish text' });
    const f = l.byFeature().find((r) => r.feature === 'G')!;
    expect(f.errorClasses).toEqual({ other: 1 });
  });

  it('an error row without a class reads as "unrecorded"', () => {
    const l = (ledger = new FeatureMetricsLedger({ dbPath: ':memory:' }));
    l.record({ feature: 'G', outcome: 'error' });
    expect(l.byFeature().find((r) => r.feature === 'G')!.errorClasses).toEqual({ unrecorded: 1 });
  });

  it('a failing reliability component carries its error classes; counts are unchanged', () => {
    const l = (ledger = new FeatureMetricsLedger({ dbPath: ':memory:' }));
    for (let i = 0; i < 25; i++) l.record({ feature: 'PromptGate', outcome: 'error', errorClass: 'auth' });
    for (let i = 0; i < 5; i++) l.record({ feature: 'PromptGate', outcome: 'unclassified' });
    for (let i = 0; i < 30; i++) l.record({ feature: 'Healthy', outcome: 'unclassified' });
    const rel = l.reliability({ sinceHours: 24 });
    expect(rel.status).toBe('failing');
    expect(rel.components).toHaveLength(1);
    expect(rel.components[0]).toMatchObject({
      feature: 'PromptGate', errors: 25, realCalls: 30, status: 'failing', errorClasses: { auth: 25 },
    });
    expect(rel.components[0].errorRate).toBeCloseTo(25 / 30);
  });

  it('never stores message text: only the closed-set label reaches the DB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-errclass-'));
    const dbPath = path.join(dir, 'm.db');
    try {
      const l = new FeatureMetricsLedger({ dbPath });
      l.record({ feature: 'G', outcome: 'error', errorClass: 'TOKEN=abc123 Command failed' });
      l.record({ feature: 'G', outcome: 'error', errorClass: 'auth' });
      l.close();
      const raw = new Database(dbPath, { readonly: true });
      const vals = (raw.prepare(`SELECT error_class FROM feature_metrics`).all() as Array<{ error_class: string }>).map((r) => r.error_class);
      raw.close();
      expect(vals.sort()).toEqual(['auth', 'other']);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/FeatureMetricsLedger-errorClass.test.ts' });
    }
  });

  it('adds the error_class column to an existing DB idempotently, keeping old rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-errclass-old-'));
    const dbPath = path.join(dir, 'old.db');
    try {
      const seed = new Database(dbPath);
      seed.exec(`CREATE TABLE feature_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, feature TEXT NOT NULL,
        kind TEXT NOT NULL, outcome TEXT NOT NULL, tokens_in INTEGER, tokens_out INTEGER,
        latency_ms INTEGER, model TEXT, waited INTEGER NOT NULL DEFAULT 0, wait_ms INTEGER, verdict_id TEXT)`);
      seed.prepare(`INSERT INTO feature_metrics (ts, feature, kind, outcome) VALUES (?, 'Old', 'llm', 'error')`).run(Date.now());
      seed.close();
      for (let open = 0; open < 2; open++) {
        const l = new FeatureMetricsLedger({ dbPath });
        if (open === 0) l.record({ feature: 'Old', outcome: 'error', errorClass: 'timeout' });
        expect(l.byFeature().find((r) => r.feature === 'Old')!.errorClasses).toEqual({ unrecorded: 1, timeout: 1 });
        l.close();
      }
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/FeatureMetricsLedger-errorClass.test.ts' });
    }
  });
});
