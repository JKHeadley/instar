// safe-fs-allow: integration fixture writes only inside a private temp directory.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaCollector } from '../../src/monitoring/QuotaCollector.js';
import { QuotaManager } from '../../src/monitoring/QuotaManager.js';
import { QuotaNotifier } from '../../src/monitoring/QuotaNotifier.js';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import type { CodexUsageSnapshot } from '../../src/providers/adapters/openai-codex/observability/codexRateLimitReader.js';

describe('Codex collector → manager → load-shed integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-manager-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/codex-quota-load-shed.integration.test.ts:afterEach',
    });
  });

  function components(read: () => Promise<CodexUsageSnapshot | null>) {
    const quotaFile = path.join(dir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      framework: 'codex-cli',
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
    const collector = new QuotaCollector(null, tracker, {
      framework: 'codex-cli',
      codexUsageReader: read,
    });
    const manager = new QuotaManager(
      { stateDir: dir, autoMigrate: false },
      { tracker, collector, notifier: new QuotaNotifier(dir) },
    );
    return { quotaFile, tracker, manager };
  }

  it('persists authoritative Codex windows and the manager sheds at the wall', async () => {
    const window = (usedPercent: number, windowMinutes: number) => ({
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowMinutes,
      resetsAt: 1_800_000_000,
      resetsAtIso: '2027-01-15T08:00:00.000Z',
      resetsInSeconds: 3600,
    });
    const usage: CodexUsageSnapshot = {
      source: 'codex-rollout', rolloutPath: '/tmp/r.jsonl', threadId: null,
      capturedAt: new Date().toISOString(), model: 'gpt-5.6-sol', planType: 'pro',
      rateLimitReachedType: 'primary', primary: window(100, 300), secondary: window(40, 10_080),
    };
    const { quotaFile, tracker, manager } = components(async () => usage);

    await manager.refresh();

    expect(JSON.parse(fs.readFileSync(quotaFile, 'utf-8'))).toMatchObject({
      source: 'codex-rollout',
      fiveHourPercent: 100,
      usagePercent: 40,
    });
    expect(tracker.shouldSpawnSession('critical').allowed).toBe(false);
  });

  it('replaces prior healthy headroom with explicit fail-safe uncertainty when the reader disappears', async () => {
    let available = true;
    const healthy: CodexUsageSnapshot = {
      source: 'codex-rollout', rolloutPath: '/tmp/r.jsonl', threadId: null,
      capturedAt: new Date().toISOString(), model: null, planType: null,
      rateLimitReachedType: null,
      primary: { usedPercent: 10, remainingPercent: 90, windowMinutes: 300, resetsAt: 1_800_000_000, resetsAtIso: null, resetsInSeconds: null },
      secondary: { usedPercent: 20, remainingPercent: 80, windowMinutes: 10_080, resetsAt: 1_800_000_000, resetsAtIso: null, resetsInSeconds: null },
    };
    const { quotaFile, tracker, manager } = components(async () => available ? healthy : null);

    await manager.refresh();
    expect(tracker.canRunJob('low')).toBe(true);
    available = false;
    await manager.refresh();

    expect(JSON.parse(fs.readFileSync(quotaFile, 'utf-8'))).toMatchObject({ quotaUnknown: true });
    expect(tracker.shouldSpawnSession('critical').allowed).toBe(false);
  });
});
