// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * E2E lifecycle (Tier 3) for incident 2026-09-22: while the OAuth usage endpoint
 * is rate-limited, the quota fallback must NEVER freeze the server's event loop.
 *
 * Production path mirrored: QuotaManager.refresh() → QuotaCollector.collect()
 * → OAuth 429 (retry-after) → fallback estimate. Here no TokenLedger is wired,
 * so the built-in incremental index runs over a sizeable transcript fixture.
 *
 * The old code read + parsed every line synchronously, so no timer could fire
 * for the whole scan. The assertion is on the longest gap between timer ticks.
 * Retries are configured not to sleep, so a retry wait can never mask a block.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import { QuotaCollector } from '../../src/monitoring/QuotaCollector.js';
import { QuotaManager } from '../../src/monitoring/QuotaManager.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FILES = 60;
const LINES_PER_FILE = 4000; // ~60 files × ~1.2 MB ≈ 72 MB of transcripts
// On a dev laptop the OLD synchronous rescan blocked ~250ms on this fixture;
// the incremental index's longest gap is single-digit ms (one 1 MiB chunk).
const MAX_GAP_MS = 75;
const TOKENS_PER_LINE = 10_000;

function line(i: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(200) + i }],
      usage: { input_tokens: TOKENS_PER_LINE, output_tokens: 0 },
    },
  });
}

describe('Quota JSONL fallback — event loop stays responsive (production path)', () => {
  let tmpDir: string;
  let projectDir: string;
  let manager: QuotaManager;
  let collector: QuotaCollector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-nonblocking-e2e-'));
    const projectsDir = path.join(tmpDir, 'projects');
    projectDir = path.join(projectsDir, '-Users-e2e');
    fs.mkdirSync(projectDir, { recursive: true });
    const body = Array.from({ length: LINES_PER_FILE }, (_, i) => line(i)).join('\n') + '\n';
    for (let f = 0; f < FILES; f++) fs.writeFileSync(path.join(projectDir, `s${f}.jsonl`), body);

    const credDir = path.join(tmpDir, 'claude-config');
    fs.mkdirSync(credDir, { recursive: true });
    const provider = new ClaudeConfigCredentialProvider(credDir);
    await provider.writeCredentials({ accessToken: 'tok', expiresAt: Date.now() + 3600000 });

    fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: new Map([['retry-after', '1500']]),
      json: async () => ({}),
    } as unknown as Response));

    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const tracker = new QuotaTracker({
      quotaFile: path.join(stateDir, 'quota-state.json'),
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
    collector = new QuotaCollector(provider, tracker, {
      fetchFn: fetchSpy as unknown as typeof fetch,
      jsonlFallback: { enabled: true, claudeProjectsDir: projectsDir },
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });
    manager = new QuotaManager({ stateDir, adaptivePolling: false }, { tracker, collector });
  });

  afterAll(() => {
    manager?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/quota-jsonl-fallback-nonblocking.test.ts' });
  });

  it('Phase 1: a rate-limited poll estimates usage while timers keep firing', async () => {
    let ticks = 0;
    let last = performance.now();
    let maxGapMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
      ticks++;
    }, 2);

    const result = await manager.refresh();
    clearInterval(timer);

    expect(result?.success).toBe(true);
    expect(result?.dataSource).toBe('jsonl-fallback');
    const expectedPercent = Math.round(((FILES * LINES_PER_FILE * TOKENS_PER_LINE) / 7_500_000_000) * 1000) / 10;
    expect(result?.state?.usagePercent).toBe(expectedPercent);

    expect(ticks).toBeGreaterThan(10);
    expect(maxGapMs).toBeLessThan(MAX_GAP_MS);

    // One OAuth request (long retry-after short-circuits in-poll retries).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(collector.getBudgetStatus().oauthCircuitBreaker.open).toBe(true);
  });

  it('Phase 2: the next poll stays inside the backoff and only reads appended bytes', async () => {
    fs.appendFileSync(path.join(projectDir, 's0.jsonl'), line(99_999) + '\n');
    const openSpy = vi.spyOn(fs.promises, 'open');
    const readSyncSpy = vi.spyOn(fs, 'readFileSync');
    const result = await manager.refresh();
    const transcriptOpens = openSpy.mock.calls.filter(c => String(c[0]).startsWith(projectDir));
    const transcriptSyncReads = readSyncSpy.mock.calls.filter(c => String(c[0]).startsWith(projectDir));
    openSpy.mockRestore();
    readSyncSpy.mockRestore();

    expect(fetchSpy).toHaveBeenCalledTimes(1); // no OAuth traffic inside the window
    const expectedPercent =
      Math.round((((FILES * LINES_PER_FILE + 1) * TOKENS_PER_LINE) / 7_500_000_000) * 1000) / 10;
    expect(result?.state?.usagePercent).toBe(expectedPercent);
    // Incremental: only the one appended-to file is opened; nothing is re-read synchronously.
    expect(transcriptOpens.map(c => path.basename(String(c[0])))).toEqual(['s0.jsonl']);
    expect(transcriptSyncReads).toHaveLength(0);
  });
});
