// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * AutonomousRunStore.recordDecisionCorrelation — LLM-Decision Quality Meter P8
 * (docs/specs/llm-decision-quality-meter.md §5.3: "The correlation id is
 * persisted in the autonomous run-state file").
 *
 * Pins: the id rides the DURABLE run record (a fresh store instance over the
 * same stateDir — a simulated server restart — reads it back); the two decision
 * kinds land in separate fields and never clobber each other; the write is
 * charset-jailed (ids arrive via callback plumbing); a missing record refuses
 * honestly; the injected clock stamps the At fields; pre-meter records (no
 * fields) still read. Also: the store structurally satisfies the evaluator's
 * CompletionCorrelationSink seam.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';
import type { CompletionCorrelationSink } from '../../src/core/CompletionEvaluator.js';

let tmp: string;
let store: AutonomousRunStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ars-corr-'));
  store = new AutonomousRunStore(tmp);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const T0 = Date.parse('2026-07-11T12:00:00.000Z');

function reg(topicId = '100') {
  const r = store.register({
    topicId,
    condition: 'ship the feature',
    workDir: tmp,
    startedAt: new Date(T0).toISOString(),
    scopeAccretion: { enabled: true, breakerK: 3 },
    baseRoots: [{ root: tmp, startSha: null, shared: false }],
    maxDurationMs: 48 * HOUR,
  });
  if (!r.ok) throw new Error('setup: register refused');
  return r.runId;
}

describe('recordDecisionCorrelation (§5.3 durable join key)', () => {
  it('persists the completion id + injected-clock timestamp onto the run record', () => {
    const runId = reg('200');
    const ok = store.recordDecisionCorrelation('200', runId, 'completion', 'd-abcd1234-uuid-1', T0 + 5_000);
    expect(ok).toBe(true);
    const rec = store.getByPair('200', runId)!;
    expect(rec.lastCompletionCorrelationId).toBe('d-abcd1234-uuid-1');
    expect(rec.lastCompletionCorrelationAt).toBe(new Date(T0 + 5_000).toISOString());
    expect(rec.lastStopRationaleCorrelationId).toBeUndefined();
  });

  it('SURVIVES A RESTART — a fresh store instance over the same stateDir reads the id back', () => {
    const runId = reg('201');
    expect(store.recordDecisionCorrelation('201', runId, 'completion', 'd-restart-1', T0)).toBe(true);
    expect(store.recordDecisionCorrelation('201', runId, 'stop-rationale', 'd-restart-2', T0 + 1_000)).toBe(true);
    // Simulated server restart: NEW instance, same on-disk state.
    const reborn = new AutonomousRunStore(tmp);
    const rec = reborn.getByPair('201', runId)!;
    expect(rec.lastCompletionCorrelationId).toBe('d-restart-1');
    expect(rec.lastStopRationaleCorrelationId).toBe('d-restart-2');
    expect(rec.lastStopRationaleCorrelationAt).toBe(new Date(T0 + 1_000).toISOString());
  });

  it('the two kinds are independent fields — a stop-rationale write never clobbers the completion id (and vice versa)', () => {
    const runId = reg('202');
    store.recordDecisionCorrelation('202', runId, 'completion', 'd-comp-1', T0);
    store.recordDecisionCorrelation('202', runId, 'stop-rationale', 'd-stop-1', T0 + 1);
    store.recordDecisionCorrelation('202', runId, 'completion', 'd-comp-2', T0 + 2);
    const rec = store.getByPair('202', runId)!;
    expect(rec.lastCompletionCorrelationId).toBe('d-comp-2'); // last completion wins its OWN slot
    expect(rec.lastStopRationaleCorrelationId).toBe('d-stop-1'); // untouched
  });

  it('still writes on a TERMINAL record (the met verdict marks terminal before the realcheck grades)', () => {
    const runId = reg('203');
    store.markTerminal('203', runId, 'met', 'met:true final verdict');
    expect(store.recordDecisionCorrelation('203', runId, 'completion', 'd-late-1', T0)).toBe(true);
    expect(store.getByPair('203', runId)!.lastCompletionCorrelationId).toBe('d-late-1');
  });

  it('charset-jails the id — refuses malformed values without touching the record', () => {
    const runId = reg('204');
    store.recordDecisionCorrelation('204', runId, 'completion', 'd-good-1', T0);
    for (const bad of ['../evil', 'd id with spaces', 'x'.repeat(129), '', 'd-uuid;rm -rf', 'd-uuid\n']) {
      expect(store.recordDecisionCorrelation('204', runId, 'completion', bad, T0 + 1)).toBe(false);
    }
    const rec = store.getByPair('204', runId)!;
    expect(rec.lastCompletionCorrelationId).toBe('d-good-1');
    expect(rec.lastCompletionCorrelationAt).toBe(new Date(T0).toISOString());
  });

  it('returns false for an unknown (topicId, runId) pair — nothing fabricated', () => {
    expect(store.recordDecisionCorrelation('999', 'run-nope', 'completion', 'd-x-1', T0)).toBe(false);
  });

  it('pre-meter records (no correlation fields on disk) still read — fields are simply absent', () => {
    const runId = reg('205');
    const file = path.join(tmp, 'state', 'autonomous-server', `205.${runId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect('lastCompletionCorrelationId' in raw).toBe(false);
    const rec = store.getByPair('205', runId)!;
    expect(rec.lastCompletionCorrelationId).toBeUndefined();
    expect(rec.lastStopRationaleCorrelationId).toBeUndefined();
  });

  it('structurally satisfies the evaluator CompletionCorrelationSink seam (wiring-integrity, type-level)', () => {
    const sink: CompletionCorrelationSink = store; // compile-time check
    const runId = reg('206');
    sink.recordDecisionCorrelation('206', runId, 'stop-rationale', 'd-seam-1');
    expect(store.getByPair('206', runId)!.lastStopRationaleCorrelationId).toBe('d-seam-1');
  });
});
