/**
 * Regression test for the DegradationReporter event-loop WEDGE (2026-06-21).
 *
 * Bug: reporting a degradation runs `gateHealthAlert`, which calls
 * `toneGate.review` — an LLM routed through the IntelligenceRouter. When the
 * configured framework is unavailable the router itself DEGRADES, re-entering
 * `report → reportEvent → gateHealthAlert` in the same synchronous stack. That
 * recursion is unbounded; each level pushes another event, and a `JSON.stringify`
 * of the growing `events` array eventually hangs the single event-loop thread for
 * MINUTES (observed live on Echo: /health HTTP 000, watchdog SIGKILL/respawn loop).
 *
 * Fixes:
 *   1. A reentrancy guard in `gateHealthAlert` — it refuses to gate-within-a-gate,
 *      returning the safe template instead of recursing.
 *   2. A hard cap on the in-memory `events` array.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('DegradationReporter — event-loop wedge fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'degrad-wedge-'));
    const r = DegradationReporter.getInstance() as unknown as Record<string, unknown>;
    r.events = [];
    r._gatingHealthAlert = false;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/degradation-reporter-reentrancy-wedge.test.ts' });
    vi.restoreAllMocks();
  });

  it('reentrancy guard: gateHealthAlert does NOT run the tone gate while already gating', async () => {
    const reporter = DegradationReporter.getInstance();
    const review = vi.fn(async () => ({ pass: true, rule: '', issue: '', suggestion: '', latencyMs: 1 }));
    reporter.configure({
      stateDir: tmpDir, agentName: 't', instarVersion: '0',
      toneGate: { review } as never,
    });

    // Simulate being mid-gate (the state the live recursion is in when it re-enters).
    (reporter as unknown as Record<string, unknown>)._gatingHealthAlert = true;

    const out = await (reporter as unknown as {
      gateHealthAlert: (c: string, h: unknown) => Promise<string>;
    }).gateHealthAlert('a health-alert candidate', { attempted: false, succeeded: null, attempts: 0 });

    // The guard short-circuits: the (recursive) tone-gate call is NOT made, and a
    // string (the safe template) is returned instead of recursing/hanging.
    expect(review).not.toHaveBeenCalled();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('reentrancy guard: a tone gate that itself re-reports does not hang and stays bounded', async () => {
    const reporter = DegradationReporter.getInstance();
    let reviewCalls = 0;
    const reentrantGate = {
      review: vi.fn(async () => {
        reviewCalls++;
        // The live failure mode: the router degrades DURING the gate, re-entering report().
        reporter.report({ feature: `during-gate-${reviewCalls}`, primary: 'pi-cli', fallback: 'claude', reason: 'router degraded', impact: 'i' });
        return { pass: false, rule: '', issue: '', suggestion: '', latencyMs: 1 };
      }),
    };
    reporter.configure({
      stateDir: tmpDir, agentName: 't', instarVersion: '0',
      telegramSender: vi.fn(async () => undefined) as never,
      alertTopicId: 1234,
      toneGate: reentrantGate as never,
    });

    // Must terminate (vitest would time out on an unbounded recursion).
    reporter.report({ feature: 'root', primary: 'pi-cli', fallback: 'claude', reason: 'r', impact: 'i' });
    await new Promise((r) => setTimeout(r, 150));

    // Bounded — the guard prevents the gate from being re-driven for re-entrant reports.
    expect(reviewCalls).toBeLessThan(5);
  });

  it('bounds the in-memory events array', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 't', instarVersion: '0' });
    for (let i = 0; i < 700; i++) {
      reporter.report({ feature: `f${i}`, primary: 'p', fallback: 'f', reason: 'r', impact: 'i' });
    }
    expect(reporter.getEvents().length).toBeLessThanOrEqual(500);
  });
});
