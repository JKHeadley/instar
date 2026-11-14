// safe-fs-allow: test file — writes only to its own tmp dir.
/**
 * E2E lifecycle — CMT-1008 (interactive session stuck at an expired Claude login).
 *
 *  1. WIRED source check: the fix only matters if server.ts hands BOTH SessionManager sinks to
 *     the real authorities — the rerouted (job) sink and the new interactive sink reach
 *     QuotaPoller.observeCliLoginExpired, and the interactive recovery swaps through the shared
 *     QuotaAwareScheduler.onQuotaPressure (the funnel POST /subscription-pool/swap uses).
 *  2. Alive: the production component set (real pool on disk, real poller, real scheduler, real
 *     recovery) driven by the exact signal SessionManager emits: the session moves, the dead
 *     login persists as needs-reauth on disk, and a later poll does not revert it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaPoller } from '../../src/core/QuotaPoller.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import { InteractiveLoginExpiredRecovery } from '../../src/core/InteractiveLoginExpiredRecovery.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SERVER = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');

describe('interactive expired-login recovery — production wiring', () => {
  it('server.ts wires the rerouted sink and the interactive sink to the real authorities', () => {
    expect(SERVER).toMatch(/setLoginExpiredSink\(\(input\) => \{[\s\S]{0,200}if \(!input\.messageLed\) \{ quotaPoller\.noteCliLoginExpired\(input\); return; \}\s*void quotaPoller\.observeCliLoginExpired\(input\)/);
    expect(SERVER).toMatch(/new InteractiveLoginExpiredRecovery\(\{\s*observe: \(input\) => quotaPoller\.observeCliLoginExpired\(input\)/);
    expect(SERVER).toMatch(/return _quotaAwareScheduler\.onQuotaPressure\(args\)/);
    expect(SERVER).toMatch(/sessionManager\.setInteractiveLoginExpiredSink\(\(signal\) => interactiveLoginExpiredRecovery\.handle\(signal\)\)/);
    expect(SERVER).toContain("'subscriptionPool.loginExpiredSwap.enabled'");
  });

  it('alive: signal → swap + durable needs-reauth that a successful poll does not revert', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ile-e2e-'));
    try {
      const pool = new SubscriptionPool({ stateDir: dir });
      pool.addFixture({ id: 'sagemind-justin', nickname: 'sj', email: 'sj@example.test', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-sj' });
      pool.addFixture({ id: 'gearfinity', nickname: 'gf', email: 'gf@example.test', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-gf' });
      const poller = new QuotaPoller({
        pool, tokenResolver: () => 'sk-ant-oat01-same',
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 3, resets_at: '2026-10-25T20:00:00Z' } }) }),
      });
      const moved: string[] = [];
      const scheduler = new QuotaAwareScheduler({ listAccounts: () => pool.list(), refreshFn: async (o) => { moved.push(`${o.sessionName}→${o.accountId}`); return { ok: true }; } });
      const recovery = new InteractiveLoginExpiredRecovery({
        observe: (input) => poller.observeCliLoginExpired(input),
        swap: (args) => scheduler.onQuotaPressure(args),
      });
      const out = await recovery.handle({ session: 'luna-topic-7', sessionName: 'topic 7', configHome: '/h/.claude-sj',
        accountId: 'sagemind-justin', matchedLine: 'Not logged in · Run /login', protected: false });
      expect(out.outcome).toBe('swapped');
      expect(moved).toEqual(['luna-topic-7→gearfinity']);
      await poller.pollAll();
      const onDisk = new SubscriptionPool({ stateDir: dir }); // a fresh reader sees the persisted state
      expect(onDisk.get('sagemind-justin')!.status).toBe('needs-reauth');
      expect(onDisk.get('gearfinity')!.status).toBe('active');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/interactive-login-expired-lifecycle.test.ts:cleanup' });
    }
  });
});
