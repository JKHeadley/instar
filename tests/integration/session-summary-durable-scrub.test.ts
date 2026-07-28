/**
 * Integration: SessionSummarySentinel × DurableOutputScrubber wiring
 * (Durable-Output Hygiene Standard §2 — the demonstrated Layer-B chokepoint).
 *
 * Proves the FULL write path, not the pure function:
 *   - WIRING INTEGRITY — when a scrubber is injected, the sentinel's persistence
 *     chokepoint actually calls it (the scrubber is not a no-op); when NO scrubber
 *     is injected the summary persists byte-for-byte as today.
 *   - ENFORCING — a live (dryRun:false) scrubber redacts a credential that the LLM
 *     summary reproduced, and the saved summary.json carries the mandatory
 *     redactionNote provenance marker.
 *   - DRY-RUN CANARY — an engaged-but-dryRun scrubber stores the ORIGINAL text
 *     (no durable mutation) while still recording the would-redact metric.
 *   - DISABLED — a disabled scrubber is a strict no-op.
 *
 * The incident this closes: the digest/summary writer reproduced a live access
 * token VERBATIM into stored memory (INSTAR-Bench v2). Placeholder token below.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionSummarySentinel } from '../../src/messaging/SessionSummarySentinel.js';
import { DurableOutputScrubber } from '../../src/monitoring/DurableOutputScrubber.js';
import type { Session, IntelligenceProvider } from '../../src/core/types.js';

const PLACEHOLDER_SECRET = 'sk-ant-api03-EXAMPLE' + '0'.repeat(40);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dscrub-int-'));
}

function fakeSession(): Session {
  return {
    id: 'sess-1',
    name: 'sess-1',
    status: 'running',
    tmuxSession: 'tmux-sess-1',
    startedAt: new Date().toISOString(),
    prompt: 'work on the thing',
  } as Session;
}

/** An intelligence provider that returns a summary whose `task` field contains a
 *  live-looking credential — the exact incident shape. */
function leakyIntelligence(): IntelligenceProvider {
  return {
    evaluate: async () =>
      JSON.stringify({
        task: `deploying with token ${PLACEHOLDER_SECRET}`,
        phase: 'deploying',
        files: ['src/deploy.ts'],
        topics: ['deployment'],
        blockers: null,
      }),
  } as unknown as IntelligenceProvider;
}

function readSummary(stateDir: string, sessionId: string): { task: string; redactionNote?: string } {
  const p = path.join(stateDir, 'sessions', sessionId, 'summary.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('SessionSummarySentinel × DurableOutputScrubber', () => {
  it('ENFORCING: redacts the leaked credential + writes the provenance marker', async () => {
    const stateDir = tmpDir();
    const calls: Array<[string, string]> = [];
    const scrubber = new DurableOutputScrubber({
      enabled: true,
      dryRun: false,
      metrics: { recordEvent: (f, o) => calls.push([f, o]) },
    });
    const sentinel = new SessionSummarySentinel({
      stateDir,
      scrubber,
      intelligence: leakyIntelligence(),
      getActiveSessions: () => [fakeSession()],
      captureOutput: () => 'some tmux output that changed',
    });
    await sentinel.scan();

    const saved = readSummary(stateDir, 'sess-1');
    expect(saved.task).toContain('[REDACTED:anthropic-key]');
    expect(saved.task).not.toContain(PLACEHOLDER_SECRET);
    expect(saved.redactionNote, 'altered summary must carry a provenance marker').toContain('redacted');
    // Wiring integrity: the scrubber was actually invoked at the chokepoint.
    expect(calls).toContainEqual(['durable-output-scrub', 'fired']);
  });

  it('DRY-RUN: stores the ORIGINAL text (no mutation) but records the would-redact metric', async () => {
    const stateDir = tmpDir();
    const calls: Array<[string, string]> = [];
    const scrubber = new DurableOutputScrubber({
      enabled: true,
      dryRun: true,
      metrics: { recordEvent: (f, o) => calls.push([f, o]) },
    });
    const sentinel = new SessionSummarySentinel({
      stateDir,
      scrubber,
      intelligence: leakyIntelligence(),
      getActiveSessions: () => [fakeSession()],
      captureOutput: () => 'some tmux output that changed',
    });
    await sentinel.scan();

    const saved = readSummary(stateDir, 'sess-1');
    // Canary: the original persists (no durable mutation while dryRun holds)…
    expect(saved.task).toContain(PLACEHOLDER_SECRET);
    // …but the would-redact metric IS recorded (soak telemetry).
    expect(calls).toContainEqual(['durable-output-scrub', 'fired']);
  });

  it('DISABLED: strict no-op — the summary persists byte-for-byte (today\'s behavior)', async () => {
    const stateDir = tmpDir();
    const calls: Array<[string, string]> = [];
    const scrubber = new DurableOutputScrubber({
      enabled: false,
      metrics: { recordEvent: (f, o) => calls.push([f, o]) },
    });
    const sentinel = new SessionSummarySentinel({
      stateDir,
      scrubber,
      intelligence: leakyIntelligence(),
      getActiveSessions: () => [fakeSession()],
      captureOutput: () => 'some tmux output that changed',
    });
    await sentinel.scan();

    const saved = readSummary(stateDir, 'sess-1');
    expect(saved.task).toContain(PLACEHOLDER_SECRET);
    expect(saved.redactionNote).toBeUndefined();
    expect(calls).toEqual([]); // no scrubber work at all
  });

  it('NO scrubber injected: byte-for-byte today\'s behavior (backward compatible)', async () => {
    const stateDir = tmpDir();
    const sentinel = new SessionSummarySentinel({
      stateDir,
      intelligence: leakyIntelligence(),
      getActiveSessions: () => [fakeSession()],
      captureOutput: () => 'some tmux output that changed',
    });
    await sentinel.scan();
    const saved = readSummary(stateDir, 'sess-1');
    expect(saved.task).toContain(PLACEHOLDER_SECRET);
    expect(saved.redactionNote).toBeUndefined();
  });
});
