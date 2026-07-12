// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * ACT-562 §3.3 — RealCheckOutcomeBinder unit tests.
 *
 * Proves the ONE wired annotateOutcome seam: an INDEPENDENT Real-Check
 * verification result (logs/autonomous-realcheck.jsonl) is bound as ground truth
 * to the continue-stop decision it verified, correlated by topic, idempotent,
 * and marked groundTruthIndependent (§3.5 — never derived from the LLM verdict).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RealCheckOutcomeBinder } from '../../src/core/RealCheckOutcomeBinder.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let stateDir: string;
let logFile: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realcheck-binder-'));
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  logFile = path.join(stateDir, 'logs', 'autonomous-realcheck.jsonl');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/RealCheckOutcomeBinder.test.ts:afterEach' });
});

function appendRow(row: Record<string, unknown>) {
  fs.appendFileSync(logFile, JSON.stringify(row) + '\n');
}

/** A recording sink capturing every annotateOutcome call. */
function makeSink() {
  const calls: Array<{ decisionId: string; component: string; outcome: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  return {
    calls,
    sink: {
      annotateOutcome(decisionId: string, component: string, outcome: Record<string, unknown>): boolean {
        // Mirror the real log's idempotency so the binder's own bound-set is
        // exercised realistically.
        if (seen.has(decisionId)) return false;
        seen.add(decisionId);
        calls.push({ decisionId, component, outcome });
        return true;
      },
    },
  };
}

describe('RealCheckOutcomeBinder — bind an independent verification outcome', () => {
  it('binds a Real-Check PASS to the registered continue-stop decision (marked independent ground truth)', () => {
    const { calls, sink } = makeSink();
    const binder = new RealCheckOutcomeBinder({ stateDir, sink });
    binder.registerDecision('jp-dec-1', { topicId: '8842' });
    appendRow({ topic: '8842', iteration: '3', outcome: 'pass', exitCode: 0, ts: '2026-07-12T10:00:00Z' });
    const bound = binder.bindNewOutcomes();
    expect(bound).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].decisionId).toBe('jp-dec-1');
    expect(calls[0].component).toBe('CompletionEvaluator');
    expect(calls[0].outcome.groundTruthIndependent).toBe(true);
    expect(calls[0].outcome.passed).toBe(true);
    expect(calls[0].outcome.source).toBe('real-check-verification');
  });

  it('binds a Real-Check FAIL as passed:false', () => {
    const { calls, sink } = makeSink();
    const binder = new RealCheckOutcomeBinder({ stateDir, sink });
    binder.registerDecision('jp-dec-2', { topicId: '8842' });
    appendRow({ topic: '8842', outcome: 'fail', exitCode: 1 });
    expect(binder.bindNewOutcomes()).toBe(1);
    expect(calls[0].outcome.passed).toBe(false);
  });

  it('is idempotent: a SECOND realcheck row for the same decision does not re-annotate', () => {
    const { calls, sink } = makeSink();
    const binder = new RealCheckOutcomeBinder({ stateDir, sink });
    binder.registerDecision('jp-dec-3', { topicId: '8842' });
    appendRow({ topic: '8842', outcome: 'pass', exitCode: 0 });
    expect(binder.bindNewOutcomes()).toBe(1);
    // Another realcheck row for the SAME topic (no new decision registered) is a no-op.
    appendRow({ topic: '8842', outcome: 'pass', exitCode: 0 });
    expect(binder.bindNewOutcomes()).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('a later attempt REPLACES the pending target so its own outcome binds to the later decision', () => {
    const { calls, sink } = makeSink();
    const binder = new RealCheckOutcomeBinder({ stateDir, sink });
    // Attempt 1 decision registered, its realcheck fails → bound to dec-A.
    binder.registerDecision('jp-dec-A', { topicId: '8842' });
    appendRow({ topic: '8842', outcome: 'fail', exitCode: 1 });
    expect(binder.bindNewOutcomes()).toBe(1);
    // Attempt 2 decision registered (replaces pending), its realcheck passes → bound to dec-B.
    binder.registerDecision('jp-dec-B', { topicId: '8842' });
    appendRow({ topic: '8842', outcome: 'pass', exitCode: 0 });
    expect(binder.bindNewOutcomes()).toBe(1);
    expect(calls.map((c) => c.decisionId)).toEqual(['jp-dec-A', 'jp-dec-B']);
    expect(calls[0].outcome.passed).toBe(false);
    expect(calls[1].outcome.passed).toBe(true);
  });

  it('a realcheck row for a topic with NO registered decision is ignored (no smeared outcome)', () => {
    const { calls, sink } = makeSink();
    const binder = new RealCheckOutcomeBinder({ stateDir, sink });
    appendRow({ topic: '9999', outcome: 'pass', exitCode: 0 });
    expect(binder.bindNewOutcomes()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('is TOTAL: a missing log file and a torn row never throw', () => {
    const { sink } = makeSink();
    const binder = new RealCheckOutcomeBinder({ stateDir, sink });
    // No file yet.
    expect(() => binder.bindNewOutcomes()).not.toThrow();
    binder.registerDecision('jp-dec-x', { topicId: '1' });
    fs.appendFileSync(logFile, '{ this is not json\n');
    appendRow({ topic: '1', outcome: 'pass', exitCode: 0 });
    expect(() => binder.bindNewOutcomes()).not.toThrow();
  });

  it('registerDecision ignores a null id or missing topic (sampled-out / write-failed decisions)', () => {
    const { calls, sink } = makeSink();
    const binder = new RealCheckOutcomeBinder({ stateDir, sink });
    binder.registerDecision(null, { topicId: '8842' });
    binder.registerDecision('jp-dec', {});
    appendRow({ topic: '8842', outcome: 'pass', exitCode: 0 });
    expect(binder.bindNewOutcomes()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
