// safe-fs-allow: test fixture writes only inside a private temporary directory.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaCollector } from '../../src/monitoring/QuotaCollector.js';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import type { CodexUsageSnapshot } from '../../src/providers/adapters/openai-codex/observability/codexRateLimitReader.js';

const thresholds = { normal: 50, elevated: 70, critical: 85, shutdown: 95 };

describe('Codex quota load-shed parity', () => {
  let dir: string;
  let quotaFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-load-shed-'));
    quotaFile = path.join(dir, 'quota-state.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/codex-quota-load-shed.test.ts:afterEach',
    });
  });

  function tracker(framework: 'claude-code' | 'codex-cli' = 'codex-cli'): QuotaTracker {
    return new QuotaTracker({ quotaFile, thresholds, framework });
  }

  function snapshot(weekly: number, fiveHour: number): CodexUsageSnapshot {
    const window = (usedPercent: number, windowMinutes: number) => ({
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowMinutes,
      resetsAt: 1_800_000_000,
      resetsAtIso: '2027-01-15T08:00:00.000Z',
      resetsInSeconds: 3600,
    });
    return {
      source: 'codex-rollout',
      rolloutPath: '/tmp/rollout.jsonl',
      threadId: null,
      capturedAt: new Date().toISOString(),
      model: 'gpt-5.6-sol',
      planType: 'pro',
      rateLimitReachedType: null,
      primary: window(fiveHour, 300),
      secondary: window(weekly, 10_080),
    };
  }

  it('maps a healthy authoritative rollout and allows work', async () => {
    const t = tracker();
    const collector = new QuotaCollector(null, t, {
      framework: 'codex-cli',
      codexUsageReader: async () => snapshot(20, 10),
    });

    const result = await collector.collect();
    expect(result).toMatchObject({
      success: true,
      dataSource: 'codex-rollout',
      dataConfidence: 'authoritative',
      state: { source: 'codex-rollout', usagePercent: 20, fiveHourPercent: 10 },
    });
    expect(t.canRunJob('low')).toBe(true);
  });

  it('maps an exhausted rollout and sheds every priority', async () => {
    const t = tracker();
    const exhausted = snapshot(100, 97);
    exhausted.rateLimitReachedType = 'secondary';
    const collector = new QuotaCollector(null, t, {
      framework: 'codex-cli',
      codexUsageReader: async () => exhausted,
    });

    await collector.collect();
    expect(t.canRunJob('low')).toBe(false);
    expect(t.shouldSpawnSession('critical').allowed).toBe(false);
  });

  it.each([
    ['missing', async () => null],
    ['unreadable', async () => { throw new Error('rollout unreadable'); }],
  ])('fails safe when the Codex reading is %s', async (_case, read) => {
    const t = tracker();
    const collector = new QuotaCollector(null, t, {
      framework: 'codex-cli',
      codexUsageReader: read,
    });

    const result = await collector.collect();
    expect(result.state).toMatchObject({ source: 'codex-rollout', quotaUnknown: true });
    expect(t.canRunJob('low')).toBe(false);
    expect(t.shouldSpawnSession('critical').allowed).toBe(false);
  });

  it('fails safe when a complete rollout has no trustworthy capture time', async () => {
    const t = tracker();
    const unknownAge = snapshot(10, 10);
    unknownAge.capturedAt = null;
    const collector = new QuotaCollector(null, t, {
      framework: 'codex-cli',
      codexUsageReader: async () => unknownAge,
    });

    const result = await collector.collect();
    expect(result.state).toMatchObject({ source: 'codex-rollout', quotaUnknown: true });
    expect(t.shouldSpawnSession('critical').allowed).toBe(false);
  });

  it('does not let cached healthy Codex headroom survive a corrupted state file', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T19:00:00Z'));
    const t = tracker();
    t.updateState({
      usagePercent: 10,
      fiveHourPercent: 10,
      source: 'codex-rollout',
      lastUpdated: new Date().toISOString(),
    });
    expect(t.canRunJob('low')).toBe(true);

    fs.writeFileSync(quotaFile, '{broken');
    vi.advanceTimersByTime(5_001);
    expect(t.shouldSpawnSession('critical')).toMatchObject({ allowed: false });
  });

  it('fails safe before the first Codex quota file exists', () => {
    const t = tracker();
    expect(t.shouldSpawnSession('medium')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('fail-safe'),
    });
  });

  it('preserves Claude authority and degraded-estimate semantics', () => {
    const t = tracker('claude-code');
    t.updateState({
      usagePercent: 100,
      source: 'anthropic-oauth',
      lastUpdated: new Date().toISOString(),
    });
    expect(t.shouldSpawnSession('critical').allowed).toBe(false);

    t.updateState({
      usagePercent: 100,
      source: 'claude-jsonl',
      lastUpdated: new Date().toISOString(),
    });
    expect(t.canRunJob('low')).toBe(false);
    expect(t.canRunJob('medium')).toBe(true);
  });

  it('treats Gemini provider-native capacity as authoritative at and beyond the wall', () => {
    const t = tracker('gemini-cli');
    t.updateState({
      usagePercent: 150,
      fiveHourPercent: 100,
      source: 'gemini-cli-capacity',
      lastUpdated: new Date().toISOString(),
    });

    expect(t.canRunJob('low')).toBe(false);
    expect(t.shouldSpawnSession('critical').allowed).toBe(false);
  });

  it('preserves Claude missing-data fail-open behavior', () => {
    expect(tracker('claude-code').canRunJob('low')).toBe(true);
  });
});
