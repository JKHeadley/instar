/**
 * Unit tests for DegradationReporter — the "loud fallback" standard.
 *
 * When a feature falls back to a secondary path, that's a bug. The reporter
 * ensures fallback activations are never silent: they log, file feedback,
 * alert via Telegram, and persist to disk.
 *
 * Born from the insight: "Fallbacks should only and always be associated
 * with a bug report back to Instar." — Justin, 2026-02-25
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DegradationReporter, type NormalizedDegradationEvent } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('DegradationReporter', () => {
  let tmpDir: string;

  beforeEach(() => {
    DegradationReporter.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'degradation-test-'));
  });

  afterEach(() => {
    DegradationReporter.resetForTesting();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/degradation-reporter.test.ts:29' });
  });

  it('is a singleton', () => {
    const a = DegradationReporter.getInstance();
    const b = DegradationReporter.getInstance();
    expect(a).toBe(b);
  });

  it('reports degradation events', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    reporter.report({
      feature: 'TestFeature',
      primary: 'Primary path description',
      fallback: 'Fallback path description',
      reason: 'Primary failed because of X',
      impact: 'User sees degraded experience',
    });

    expect(reporter.hasDegradations()).toBe(true);
    expect(reporter.getEvents()).toHaveLength(1);

    const event = reporter.getEvents()[0];
    expect(event.feature).toBe('TestFeature');
    expect(event.reason).toBe('Primary failed because of X');
    expect(event.timestamp).toBeDefined();
    expect(event.reported).toBe(false); // No downstream connected yet
    expect(event.alerted).toBe(false);
  });

  it('persists events to disk', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    reporter.report({
      feature: 'DiskTest',
      primary: 'Primary',
      fallback: 'Fallback',
      reason: 'Test persistence',
      impact: 'None',
    });

    const filePath = path.join(tmpDir, 'degradations.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].feature).toBe('DiskTest');
  });

  it('logs to console with [DEGRADATION] prefix', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    reporter.report({
      feature: 'ConsoleTest',
      primary: 'Primary',
      fallback: 'Fallback',
      reason: 'Test logging',
      impact: 'None',
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[DEGRADATION]');
    expect(warnSpy.mock.calls[0][0]).toContain('ConsoleTest');

    warnSpy.mockRestore();
  });

  it('drains queued events when downstream connects', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    // Suppress console output
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Report BEFORE downstream is connected
    reporter.report({
      feature: 'QueueTest',
      primary: 'Primary',
      fallback: 'Fallback',
      reason: 'Queued event',
      impact: 'Delayed reporting',
    });

    expect(reporter.getEvents()[0].reported).toBe(false);

    // Connect downstream
    const feedbackSubmitter = vi.fn().mockResolvedValue({});
    const telegramSender = vi.fn().mockResolvedValue({});

    reporter.connectDownstream({
      feedbackSubmitter,
      telegramSender,
      alertTopicId: 42,
    });

    // Wait for async drain — use vi.waitFor to handle CPU-loaded environments
    // where a fixed setTimeout may not be enough (the drain calls async reportEvent
    // which awaits feedbackSubmitter and telegramSender promises).
    await vi.waitFor(() => {
      expect(feedbackSubmitter).toHaveBeenCalledTimes(1);
      expect(telegramSender).toHaveBeenCalledTimes(1);
    }, { timeout: 2000, interval: 20 });

    // Verify the feedback submission
    const feedbackCall = feedbackSubmitter.mock.calls[0][0];
    expect(feedbackCall.type).toBe('bug');
    expect(feedbackCall.title).toContain('[DEGRADATION]');
    expect(feedbackCall.title).toContain('QueueTest');

    // Verify the Telegram alert
    expect(telegramSender.mock.calls[0][0]).toBe(42); // topicId
    expect(telegramSender.mock.calls[0][1]).toContain('Delayed reporting');

    // Event should now be marked as reported and alerted
    const event = reporter.getEvents()[0];
    expect(event.reported).toBe(true);
    expect(event.alerted).toBe(true);

    vi.restoreAllMocks();
  });

  it('tracks unreported events', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    reporter.report({
      feature: 'A', primary: 'P', fallback: 'F',
      reason: 'R', impact: 'I',
    });
    reporter.report({
      feature: 'B', primary: 'P', fallback: 'F',
      reason: 'R', impact: 'I',
    });

    expect(reporter.getUnreportedEvents()).toHaveLength(2);

    vi.restoreAllMocks();
  });

  it('handles feedback submission failure gracefully', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    reporter.report({
      feature: 'FailTest', primary: 'P', fallback: 'F',
      reason: 'R', impact: 'I',
    });

    const feedbackSubmitter = vi.fn().mockRejectedValue(new Error('webhook down'));
    reporter.connectDownstream({ feedbackSubmitter });

    // Wait for async drain — use vi.waitFor for robustness under CPU load
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    }, { timeout: 2000, interval: 20 });

    // Should not throw — failure is logged, not propagated
    // Event stays unreported
    expect(reporter.getEvents()[0].reported).toBe(false);

    vi.restoreAllMocks();
  });

  // ── F-3 (NormalizedDegradationEvent shim, §A33 / §A50) ───────────

  describe('F-3 normalization shim', () => {
    it('legacy .report() produces a normalized event with provenance: free-text', () => {
      const reporter = DegradationReporter.getInstance();
      reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // No remediator wired → legacy alert path runs unchanged (test 4
      // covers backward compat). Here we only assert the _normalize output.
      reporter.report({
        feature: 'PaymentSubsystem',
        primary: 'Real provider',
        fallback: 'Cache',
        reason: 'gateway timeout',
        impact: 'slow checkout',
      });

      const legacy = reporter.getEvents()[0];
      const normalized = reporter._normalize(legacy);

      expect(normalized.subsystem).toBe('PaymentSubsystem');
      expect(normalized.provenance).toBe('free-text');
      expect(normalized.errorCode).toBe('LEGACY_DEGRADATION');
      expect(normalized.reason.full).toBe('gateway timeout');
      expect(normalized.reason.redacted).toBeDefined();
      expect(typeof normalized.monotonicTs).toBe('number');
      expect(normalized.legacy).toBeDefined();
      expect(normalized.legacy?.feature).toBe('PaymentSubsystem');

      vi.restoreAllMocks();
    });

    it('reportStructured() preserves caller-provided provenance', async () => {
      const reporter = DegradationReporter.getInstance();
      reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const dispatched: NormalizedDegradationEvent[] = [];
      reporter.setRemediator({
        dispatch: async (e) => { dispatched.push(e); },
      });

      reporter.reportStructured({
        subsystem: 'lifeline',
        errorCode: 'SUPERVISOR_PROCESS_GONE',
        provenance: 'probe-id',
        reason: { redacted: 'pid 1234 missing', full: 'pid 1234 missing' },
        timestamp: '2026-05-13T00:00:00.000Z',
        monotonicTs: 12345,
      });

      await vi.waitFor(() => {
        expect(dispatched).toHaveLength(1);
      }, { timeout: 1000, interval: 10 });

      expect(dispatched[0].provenance).toBe('probe-id');
      expect(dispatched[0].errorCode).toBe('SUPERVISOR_PROCESS_GONE');
      expect(dispatched[0].subsystem).toBe('lifeline');

      vi.restoreAllMocks();
    });

    it('setRemediator(r) causes legacy events to flow to r.dispatch()', async () => {
      const reporter = DegradationReporter.getInstance();
      reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const feedbackSubmitter = vi.fn().mockResolvedValue({});
      const telegramSender = vi.fn().mockResolvedValue({});
      reporter.connectDownstream({ feedbackSubmitter, telegramSender, alertTopicId: 99 });

      const dispatched: NormalizedDegradationEvent[] = [];
      reporter.setRemediator({
        dispatch: async (e) => { dispatched.push(e); },
      });

      reporter.report({
        feature: 'TopicMemory',
        primary: 'SQLite',
        fallback: 'JSONL',
        reason: 'better-sqlite3 failed',
        impact: 'no summaries',
      });

      await vi.waitFor(() => {
        expect(dispatched).toHaveLength(1);
      }, { timeout: 1000, interval: 10 });

      // Legacy alert path MUST NOT have run.
      expect(feedbackSubmitter).not.toHaveBeenCalled();
      expect(telegramSender).not.toHaveBeenCalled();

      expect(dispatched[0].subsystem).toBe('TopicMemory');
      expect(dispatched[0].provenance).toBe('free-text');

      vi.restoreAllMocks();
    });

    it('with no remediator set, legacy alert path runs unchanged (backward compat)', async () => {
      const reporter = DegradationReporter.getInstance();
      reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // NO setRemediator() call — this is the backward-compat path.
      const feedbackSubmitter = vi.fn().mockResolvedValue({});
      const telegramSender = vi.fn().mockResolvedValue({});
      reporter.connectDownstream({ feedbackSubmitter, telegramSender, alertTopicId: 7 });

      reporter.report({
        feature: 'BackwardCompat',
        primary: 'P', fallback: 'F',
        reason: 'r', impact: 'i',
      });

      // Legacy alert path should fire.
      await vi.waitFor(() => {
        expect(feedbackSubmitter).toHaveBeenCalledTimes(1);
        expect(telegramSender).toHaveBeenCalledTimes(1);
      }, { timeout: 2000, interval: 20 });

      vi.restoreAllMocks();
    });

    it('_setRestartPending(true) queues events to a durable file', () => {
      const reporter = DegradationReporter.getInstance();
      reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      reporter.setRemediator({ dispatch: async () => {} });
      reporter._setRestartPending(true);

      reporter.report({
        feature: 'A', primary: 'P', fallback: 'F',
        reason: 'r1', impact: 'i',
      });
      reporter.report({
        feature: 'B', primary: 'P', fallback: 'F',
        reason: 'r2', impact: 'i',
      });

      const queuePath = path.join(tmpDir, 'remediation', 'degradations-queue.jsonl');
      expect(fs.existsSync(queuePath)).toBe(true);

      const queued = reporter._readRestartPendingQueue();
      expect(queued).toHaveLength(2);
      expect(queued[0].subsystem).toBe('A');
      expect(queued[1].subsystem).toBe('B');

      vi.restoreAllMocks();
    });

    it('_setRestartPending(false) replays queued events', async () => {
      const reporter = DegradationReporter.getInstance();
      reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const dispatched: NormalizedDegradationEvent[] = [];
      reporter.setRemediator({
        dispatch: async (e) => { dispatched.push(e); },
      });
      reporter._setRestartPending(true);

      reporter.report({
        feature: 'Queued1', primary: 'P', fallback: 'F',
        reason: 'r', impact: 'i',
      });
      reporter.report({
        feature: 'Queued2', primary: 'P', fallback: 'F',
        reason: 'r', impact: 'i',
      });

      expect(dispatched).toHaveLength(0); // No dispatch during RestartPending

      reporter._setRestartPending(false);

      await vi.waitFor(() => {
        expect(dispatched).toHaveLength(2);
      }, { timeout: 1000, interval: 10 });

      expect(dispatched[0].subsystem).toBe('Queued1');
      expect(dispatched[1].subsystem).toBe('Queued2');

      // Queue file is cleaned up after successful replay.
      const queuePath = path.join(tmpDir, 'remediation', 'degradations-queue.jsonl');
      expect(fs.existsSync(queuePath)).toBe(false);

      vi.restoreAllMocks();
    });

    it('queue cap (1000 entries) trips drop-and-counter', () => {
      const reporter = DegradationReporter.getInstance();
      reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      reporter.setRemediator({ dispatch: async () => {} });

      // Pre-seed the queue with 1000 entries to hit the cap without
      // hammering the test with 1001 .report() calls (which would also
      // trip console-warn rate limits).
      const queueDir = path.join(tmpDir, 'remediation');
      fs.mkdirSync(queueDir, { recursive: true });
      const queuePath = path.join(queueDir, 'degradations-queue.jsonl');
      const filler = JSON.stringify({
        subsystem: 'filler', errorCode: 'X', provenance: 'free-text',
        reason: { redacted: 'x', full: 'x' },
        timestamp: '2026-01-01T00:00:00.000Z', monotonicTs: 0,
      }) + '\n';
      fs.writeFileSync(queuePath, filler.repeat(1000));

      reporter._setRestartPending(true);

      const beforeDrops = reporter._getQueueDropCount();
      reporter.report({
        feature: 'OverflowEvent', primary: 'P', fallback: 'F',
        reason: 'should be dropped', impact: 'i',
      });

      expect(reporter._getQueueDropCount()).toBe(beforeDrops + 1);

      // Sidecar drop-count file is written for cross-process visibility.
      const dropsSidecar = queuePath + '.drops.json';
      expect(fs.existsSync(dropsSidecar)).toBe(true);
      const drops = JSON.parse(fs.readFileSync(dropsSidecar, 'utf-8'));
      expect(drops.dropped).toBeGreaterThan(0);

      vi.restoreAllMocks();
    });

    it('redaction in _normalize strips secrets from reason', () => {
      const reporter = DegradationReporter.getInstance();
      reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      reporter.report({
        feature: 'AuthSubsystem',
        primary: 'P', fallback: 'F',
        reason: 'failed with token Bearer abcdef1234567890abcdef1234567890abcdef at /Users/justin/.instar/config.json',
        impact: 'i',
      });

      const legacy = reporter.getEvents()[0];
      const normalized = reporter._normalize(legacy);

      // Original full text retained.
      expect(normalized.reason.full).toContain('Bearer abcdef');
      expect(normalized.reason.full).toContain('/Users/justin');
      // Redacted form has the secrets stripped.
      expect(normalized.reason.redacted).not.toContain('abcdef1234567890');
      expect(normalized.reason.redacted).toContain('<REDACTED>');
      expect(normalized.reason.redacted).toContain('<HOME>');

      vi.restoreAllMocks();
    });

    it('errorCode extraction from legacy feature/reason works', () => {
      const reporter = DegradationReporter.getInstance();
      reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // ABI-mismatch flavored reason text.
      reporter.report({
        feature: 'better-sqlite3-loader',
        primary: 'native',
        fallback: 'JSONL',
        reason: 'NODE_MODULE_VERSION 127 mismatch detected',
        impact: 'no summaries',
      });
      const abiNorm = reporter._normalize(reporter.getEvents()[0]);
      expect(abiNorm.errorCode).toBe('NATIVE_MODULE_ABI_MISMATCH');
      expect(abiNorm.provenance).toBe('free-text');

      // SQLite-error flavored reason text.
      reporter.report({
        feature: 'sqlite-writer',
        primary: 'SQLite',
        fallback: 'memory',
        reason: 'SQLITE_CORRUPT: database disk image is malformed',
        impact: 'data loss',
      });
      const sqliteNorm = reporter._normalize(reporter.getEvents()[1]);
      expect(sqliteNorm.errorCode).toBe('SQLITE_CORRUPT');

      // Unknown reason — falls back to LEGACY_DEGRADATION sentinel.
      reporter.report({
        feature: 'mystery',
        primary: 'P', fallback: 'F',
        reason: 'something happened that was not parseable',
        impact: 'i',
      });
      const mysteryNorm = reporter._normalize(reporter.getEvents()[2]);
      expect(mysteryNorm.errorCode).toBe('LEGACY_DEGRADATION');

      vi.restoreAllMocks();
    });
  });

  it('works without stateDir configured (no disk persistence)', () => {
    const reporter = DegradationReporter.getInstance();
    // Deliberately not calling configure()

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Should not throw
    reporter.report({
      feature: 'NoDisk', primary: 'P', fallback: 'F',
      reason: 'R', impact: 'I',
    });

    expect(reporter.hasDegradations()).toBe(true);
    const diskFile = path.join(tmpDir, 'degradations.json');
    expect(fs.existsSync(diskFile)).toBe(false); // No disk write without stateDir

    vi.restoreAllMocks();
  });
});
