// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration (Tier 2) + wiring-integrity test for the 2026-09-22 fix:
 * QuotaCollector's fallback estimate (used while the OAuth usage endpoint is
 * failing / rate-limited) must read the REAL TokenLedger built inside
 * AgentServer — never re-read transcript files itself (the synchronous rescan
 * that froze the server for 30-80s per poll).
 *
 * Boots a real AgentServer with a real QuotaManager + QuotaCollector, ingests
 * a token event into the server's real ledger, and drives a real refresh with
 * the OAuth endpoint answering 429. The estimate must come from the ledger.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import { QuotaCollector } from '../../src/monitoring/QuotaCollector.js';
import { QuotaManager } from '../../src/monitoring/QuotaManager.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-quota-ledger-wiring';

describe('QuotaCollector ⇄ TokenLedger wiring (real AgentServer)', () => {
  let tmpDir: string;
  let server: AgentServer;
  let collector: QuotaCollector;
  let tracker: QuotaTracker;
  let manager: QuotaManager;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let projectsDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-it-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'it' }));

    const credDir = path.join(tmpDir, 'claude-config');
    fs.mkdirSync(credDir, { recursive: true });
    const provider = new ClaudeConfigCredentialProvider(credDir);
    await provider.writeCredentials({ accessToken: 'tok', expiresAt: Date.now() + 3600000 });

    // A transcript dir the collector COULD scan — with a wildly different total —
    // so a passing test proves the ledger (not a file scan) produced the estimate.
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(path.join(projectsDir, '-Users-it'), { recursive: true });
    fs.writeFileSync(
      path.join(projectsDir, '-Users-it', 'decoy.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', usage: { input_tokens: 7_000_000_000 } },
      }) + '\n',
    );

    fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: new Map([['retry-after', '900']]),
      json: async () => ({}),
    } as unknown as Response));

    tracker = new QuotaTracker({
      quotaFile: path.join(stateDir, 'quota-state.json'),
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
    collector = new QuotaCollector(provider, tracker, {
      fetchFn: fetchSpy as unknown as typeof fetch,
      jsonlFallback: { enabled: true, claudeProjectsDir: projectsDir },
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 30_000, jitterFactor: 0 },
    });
    manager = new QuotaManager({ stateDir, adaptivePolling: false }, { tracker, collector });

    const config = {
      projectName: 'it', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    // Constructed but NOT started: start() launches the ledger poller, which
    // scans the real ~/.claude/projects — irrelevant to wiring and not hermetic.
    server = new AgentServer({
      config,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] } as never,
      state: new StateManager(stateDir),
      quotaTracker: tracker,
      quotaManager: manager,
    });
  });

  afterAll(async () => {
    manager?.stop();
    await server?.stop().catch(() => { /* never started */ });
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/quota-collector-token-ledger-wiring.test.ts' });
  });

  it('AgentServer wires the collector to its real TokenLedger (not null, not a no-op)', () => {
    const ledger = (server as unknown as { tokenLedger: { ingestLine(l: string): { inserted: boolean } } | null }).tokenLedger;
    expect(ledger).not.toBeNull();
    expect(collector.hasUsageTotalsSource()).toBe(true);
  });

  it('a 429 refresh estimates from the ledger total, sends ONE OAuth request, and reads no transcripts', async () => {
    const ledger = (server as unknown as { tokenLedger: { ingestLine(l: string): { inserted: boolean } } }).tokenLedger;
    const ingested = ledger.ingestLine(JSON.stringify({
      type: 'assistant',
      requestId: 'req-it-1',
      sessionId: 'sess-it',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      message: { id: 'msg-it-1', model: 'claude-opus', usage: { input_tokens: 2_250_000_000, output_tokens: 0 } },
    }));
    expect(ingested.inserted).toBe(true);

    const readSpy = vi.spyOn(fs.promises, 'open');
    const result = await manager.refresh();
    readSpy.mockRestore();

    expect(result?.dataSource).toBe('jsonl-fallback');
    expect(result?.state?.usagePercent).toBe(30); // 2.25B / 7.5B from the LEDGER, not the 7B decoy
    expect(tracker.getState()?.source).toBe('claude-jsonl');
    expect(readSpy).not.toHaveBeenCalled();
    // retry-after 900s > maxDelay 30s → no in-poll retries, backoff opened.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(collector.getBudgetStatus().oauthCircuitBreaker.open).toBe(true);

    // Next refresh stays inside the backoff window: no OAuth traffic at all.
    await manager.refresh();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
