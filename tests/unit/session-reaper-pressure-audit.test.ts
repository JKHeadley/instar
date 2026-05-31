/**
 * RESPONSIBLE-RESOURCE-USAGE additions to the SessionReaper:
 *  1. computePressure — CPU-aware tier = WORST of memory (free %) and CPU
 *     (1-min load ÷ cores). Memory-only behavior preserved when cores unknown.
 *  2. Decision audit — a `decision` row is emitted on first sight and on every
 *     (verdict, keptBy) CHANGE, never every tick (auditability without spam).
 *  3. reaperAuditSink / readReaperAudit — dedicated, silent, never-throws trail.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SessionReaper,
  computePressure,
  reaperAuditSink,
  readReaperAudit,
  reaperAuditPath,
  type SessionReaperDeps,
} from '../../src/monitoring/SessionReaper.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { Session } from '../../src/core/types.js';

const CPU = { cpuModerateLoadPerCore: 1.0, cpuCriticalLoadPerCore: 1.5 };
const IDLE_FRAME = 'some output\n? for shortcuts\n> ';
const WORKING_FRAME = 'esc to interrupt\nWorking...';

describe('computePressure — CPU-aware tier', () => {
  it('memory-only when loadPerCore is null (pre-CPU behavior preserved)', () => {
    expect(computePressure({ freePct: 50, loadPerCore: null }, CPU).tier).toBe('normal');
    expect(computePressure({ freePct: 10, loadPerCore: null }, CPU).tier).toBe('moderate');
    expect(computePressure({ freePct: 3, loadPerCore: null }, CPU).tier).toBe('critical');
  });

  it('CPU raises the tier even when memory is fine', () => {
    expect(computePressure({ freePct: 80, loadPerCore: 0.5 }, CPU).tier).toBe('normal');
    expect(computePressure({ freePct: 80, loadPerCore: 1.0 }, CPU).tier).toBe('moderate');
    expect(computePressure({ freePct: 80, loadPerCore: 1.5 }, CPU).tier).toBe('critical');
  });

  it('overall tier is the WORST of memory and CPU', () => {
    // memory critical, cpu idle → critical
    expect(computePressure({ freePct: 2, loadPerCore: 0.1 }, CPU).tier).toBe('critical');
    // memory fine, cpu critical → critical
    expect(computePressure({ freePct: 90, loadPerCore: 3.0 }, CPU).tier).toBe('critical');
    // memory moderate, cpu normal → moderate
    expect(computePressure({ freePct: 10, loadPerCore: 0.2 }, CPU).tier).toBe('moderate');
  });

  it('exposes both inputs and per-source tiers for observability', () => {
    const r = computePressure({ freePct: 80, loadPerCore: 1.2 }, CPU);
    expect(r.inputs).toMatchObject({ freePct: 80, loadPerCore: 1.2, memTier: 'normal', cpuTier: 'moderate' });
  });

  it('honors custom thresholds', () => {
    const strict = { cpuModerateLoadPerCore: 0.5, cpuCriticalLoadPerCore: 0.8 };
    expect(computePressure({ freePct: 90, loadPerCore: 0.6 }, strict).tier).toBe('moderate');
    expect(computePressure({ freePct: 90, loadPerCore: 0.9 }, strict).tier).toBe('critical');
  });

  it('non-finite loadPerCore is ignored (memory-only)', () => {
    expect(computePressure({ freePct: 90, loadPerCore: NaN }, CPU).tier).toBe('normal');
    expect(computePressure({ freePct: 90, loadPerCore: Infinity }, CPU).tier).toBe('normal');
  });
});

describe('reaperAuditSink / readReaperAudit', () => {
  it('round-trips entries, bounds the tail, and returns [] when absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-audit-'));
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      // Absent file → [] (never throws).
      expect(readReaperAudit(stateDir, 10)).toEqual([]);

      const sink = reaperAuditSink(stateDir);
      for (let i = 0; i < 5; i++) sink({ event: 'decision', n: i });
      expect(fs.existsSync(reaperAuditPath(stateDir))).toBe(true);

      const all = readReaperAudit(stateDir, 100);
      expect(all).toHaveLength(5);
      expect(all[4]).toMatchObject({ event: 'decision', n: 4 });

      // Bounded tail returns the NEWEST `limit` rows.
      const tail = readReaperAudit(stateDir, 2);
      expect(tail.map(e => e.n)).toEqual([3, 4]);
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/session-reaper-pressure-audit.test.ts' });
    }
  });
});

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'sess', status: 'running', tmuxSession: 't1',
    startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'c1',
    ...over,
  } as Session;
}

/** Permissive deps with a mutable frame + an audit spy. pressure stays `normal`
 *  (threshold null ⇒ no reap machinery) so we isolate the decision audit. */
function auditTestDeps(frameRef: { frame: string }, events: Array<Record<string, unknown>>): SessionReaperDeps {
  return {
    listRunningSessions: () => [mkSession()],
    captureOutput: () => frameRef.frame,
    hasActiveProcesses: () => false,
    frameworkForSession: () => 'claude-code',
    probeTranscript: () => ({ resolved: true, path: '/t', size: 1, mtime: 1 }),
    isRecoveryActive: () => false,
    isRelayLeaseActive: () => false,
    hasPendingInjection: () => false,
    topicBinding: () => null,
    recentUserMessage: () => false,
    activeCommitmentForTopic: () => false,
    activeSubagentCount: () => 0,
    buildOrAutonomousActive: () => false,
    protectedSessions: () => [],
    pressure: () => ({ tier: 'normal', inputs: { freePct: 50, loadPerCore: 0.1, memTier: 'normal', cpuTier: 'normal' } }),
    terminate: async () => ({ terminated: true }),
    markReaping: () => {},
    clearReaping: () => {},
    audit: (e) => { events.push(e); },
  };
}

describe('SessionReaper decision audit (transition-only)', () => {
  it('logs a decision on first sight and on change, but not when unchanged', async () => {
    const frameRef = { frame: WORKING_FRAME };
    const events: Array<Record<string, unknown>> = [];
    const reaper = new SessionReaper(auditTestDeps(frameRef, events), { enabled: true, dryRun: true });

    const decisions = () => events.filter(e => e.event === 'decision');

    await reaper.tick();                       // first sight → 1 decision (keep)
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]).toMatchObject({ verdict: 'keep', kind: 'session-reaper', tier: 'normal' });

    await reaper.tick();                       // unchanged → still 1
    expect(decisions()).toHaveLength(1);

    frameRef.frame = IDLE_FRAME;               // verdict flips keep → reap-eligible
    await reaper.tick();
    expect(decisions()).toHaveLength(2);
    expect(decisions()[1]).toMatchObject({ verdict: 'reap-eligible', keptBy: 'all-clear' });

    await reaper.tick();                       // unchanged again → still 2
    expect(decisions()).toHaveLength(2);

    frameRef.frame = WORKING_FRAME;            // flips back → 3rd decision
    await reaper.tick();
    expect(decisions()).toHaveLength(3);
  });

  it('every decision row carries the pressure context (tier + inputs)', async () => {
    const frameRef = { frame: WORKING_FRAME };
    const events: Array<Record<string, unknown>> = [];
    const reaper = new SessionReaper(auditTestDeps(frameRef, events), { enabled: true, dryRun: true });
    await reaper.tick();
    const d = events.find(e => e.event === 'decision')!;
    expect(d).toMatchObject({ tier: 'normal' });
    expect(d.inputs).toMatchObject({ memTier: 'normal', cpuTier: 'normal' });
  });
});
