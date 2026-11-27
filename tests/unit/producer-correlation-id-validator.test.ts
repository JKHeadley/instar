/**
 * CMT-1677 join fix: the Jev shadow row's producerCorrelationId must survive
 * the provenance validator for every id the router and breaker actually mint.
 * Real multi-machine ids carry the pool machine segment (`m_03b30f`), so the
 * old `[A-Za-z0-9-]` pattern dropped every one of them silently.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JudgmentProvenanceLog, validProducerCorrelationId } from '../../src/core/JudgmentProvenanceLog.js';
import {
  _resetDecisionQualityForTest,
  mintBreakerCorrelationId,
  mintRouterCorrelationId,
  setDecisionQualityMachineId,
} from '../../src/core/decisionQualityTypes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REAL_MACHINE_ID = 'm_03b30f5b32c6ef3eb0afd3ca7054e252';

afterEach(() => _resetDecisionQualityForTest());

describe('validProducerCorrelationId', () => {
  it('accepts router and breaker mints, single- and multi-machine', () => {
    expect(validProducerCorrelationId(mintRouterCorrelationId())).toBeDefined();
    expect(validProducerCorrelationId(mintBreakerCorrelationId())).toBeDefined();
    setDecisionQualityMachineId(REAL_MACHINE_ID);
    const d = mintRouterCorrelationId();
    const b = mintBreakerCorrelationId();
    expect(d).toMatch(/^d-m_03b30f-/);
    expect(validProducerCorrelationId(d)).toBe(d);
    expect(validProducerCorrelationId(b)).toBe(b);
  });

  it('still rejects ids that are not seam mints', () => {
    for (const bad of ['', 'x-abc', 'd-', 'd-has space', 'd-a/b', 'd-"q"', "d-a'b", 'd-a.b', `d-${'a'.repeat(101)}`, 42, null, undefined]) {
      expect(validProducerCorrelationId(bad)).toBeUndefined();
    }
  });

  it('a real multi-machine id survives recordDecision onto the persisted row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-corr-'));
    try {
      setDecisionQualityMachineId(REAL_MACHINE_ID);
      const id = mintRouterCorrelationId();
      const log = new JudgmentProvenanceLog({ dir });
      await log.recordDecisionFlushed({
        component: 'JevFirstDecision', decisionPoint: 'prompt-detect', context: { stage: 'shadow' },
        optionsPresented: ['yes', 'no'], decision: 'no', reason: 'shadow', producerCorrelationId: id,
      } as any);
      const rows = await log.readRedacted({ limit: 10 });
      expect(rows[0]?.producerCorrelationId).toBe(id);
      await log.close();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/producer-correlation-id-validator.test.ts' });
    }
  });
});
