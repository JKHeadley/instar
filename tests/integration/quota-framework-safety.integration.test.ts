import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('quota scheduler framework safety integration', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'quota-framework-safety.integration.test.ts' });
    }
  });

  it('a persisted Codex session swaps only to another Codex account, never the emptier Claude account', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-fw-int-'));
    dirs.push(dir);
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'codex-hot', nickname: 'Codex hot', provider: 'openai', framework: 'codex-cli', configHome: '/h/codex-hot' });
    pool.add({ id: 'codex-safe', nickname: 'Codex safe', provider: 'openai', framework: 'codex-cli', configHome: '/h/codex-safe' });
    pool.add({ id: 'claude-empty', nickname: 'Claude empty', provider: 'anthropic', framework: 'claude-code', configHome: '/h/claude-empty' });
    pool.update('codex-hot', { lastQuota: { sevenDay: { utilizationPct: 99, resetsAt: '2026-07-12T00:00:00Z' }, source: 'codex-rollout' } });
    pool.update('codex-safe', { lastQuota: { sevenDay: { utilizationPct: 45, resetsAt: '2026-07-12T00:00:00Z' }, source: 'codex-rollout' } });
    pool.update('claude-empty', { lastQuota: { sevenDay: { utilizationPct: 0, resetsAt: '2026-07-11T00:00:00Z' }, source: 'oauth-usage-endpoint-fallback' } });

    const refreshes: Array<{ accountId: string; configHome: string }> = [];
    const scheduler = new QuotaAwareScheduler({
      listAccounts: () => pool.list(),
      refreshFn: async ({ accountId, configHome }) => { refreshes.push({ accountId, configHome }); return true; },
    });
    const result = await scheduler.onQuotaPressure({
      sessionName: 'codex-session', exhaustedAccountId: 'codex-hot', framework: 'codex-cli', nowMs: Date.parse('2026-07-10T20:00:00Z'),
    });
    expect(result).toMatchObject({ swapped: true, toAccountId: 'codex-safe' });
    expect(refreshes).toEqual([{ accountId: 'codex-safe', configHome: '/h/codex-safe' }]);
  });
});
