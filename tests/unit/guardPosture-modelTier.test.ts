/**
 * GuardPostureTripwire coverage for model-tier escalation flags
 * (spec: docs/specs/FABLE-MODEL-ESCALATION-SPEC.md §10 — "a cost-increasing
 * enable gets the same visibility as a guard-disable").
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  COST_INCREASING_ENABLE_KEYS,
  extractGuardPosture,
  runGuardPostureTripwire,
} from '../../src/monitoring/GuardPostureTripwire.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('extractGuardPosture — models.tierEscalation', () => {
  it('extracts enabled + dryRun when present', () => {
    const posture = extractGuardPosture({
      models: { tierEscalation: { enabled: true, dryRun: false } },
    });
    expect(posture['models.tierEscalation.enabled']).toBe(true);
    expect(posture['models.tierEscalation.dryRun']).toBe(false);
  });

  it('absent section ⇒ no keys (shape change, not a flip)', () => {
    const posture = extractGuardPosture({ monitoring: {} });
    expect(Object.keys(posture).some(k => k.startsWith('models.'))).toBe(false);
  });

  it('non-boolean values are ignored', () => {
    const posture = extractGuardPosture({
      models: { tierEscalation: { enabled: 'yes', dryRun: 1 } },
    });
    expect(Object.keys(posture).some(k => k.startsWith('models.'))).toBe(false);
  });

  it('models.tierEscalation.enabled is registered as cost-increasing', () => {
    expect(COST_INCREASING_ENABLE_KEYS.has('models.tierEscalation.enabled')).toBe(true);
  });
});

describe('runGuardPostureTripwire — escalation flips', () => {
  let dir: string;
  const emitted: Array<{ id: string; title: string; priority: string }> = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-gpt-mte-'));
    emitted.length = 0;
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/guardPosture-modelTier.test.ts:cleanup',
    });
  });

  const opts = (config: unknown) => ({
    config,
    stateDir: dir,
    logsDir: path.join(dir, 'logs'),
    log: () => {},
    emitAttention: async (item: { id: string; title: string; priority: string }) => {
      emitted.push(item);
    },
  });

  it('enabling escalation (false→true) raises a HIGH cost-enable Attention item', async () => {
    await runGuardPostureTripwire(opts({ models: { tierEscalation: { enabled: false, dryRun: true } } }));
    const r = await runGuardPostureTripwire(opts({ models: { tierEscalation: { enabled: true, dryRun: true } } }));
    expect(r.enabled).toContain('models.tierEscalation.enabled');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toContain('guard-posture-cost-enable');
    expect(emitted[0].priority).toBe('HIGH');
  });

  it('turning dryRun OFF (true→false) raises the existing guard-disabled Attention item', async () => {
    await runGuardPostureTripwire(opts({ models: { tierEscalation: { enabled: true, dryRun: true } } }));
    const r = await runGuardPostureTripwire(opts({ models: { tierEscalation: { enabled: true, dryRun: false } } }));
    expect(r.disabled).toContain('models.tierEscalation.dryRun');
    expect(emitted.some(e => e.id.includes('guard-posture-disabled'))).toBe(true);
  });

  it('no flip ⇒ nothing emitted', async () => {
    const cfg = { models: { tierEscalation: { enabled: true, dryRun: true } } };
    await runGuardPostureTripwire(opts(cfg));
    await runGuardPostureTripwire(opts(cfg));
    expect(emitted).toHaveLength(0);
  });
});
