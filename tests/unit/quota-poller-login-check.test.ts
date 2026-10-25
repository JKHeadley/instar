/**
 * Pool health from the CLI's own login status (spec skill-driven-signin-repair).
 *
 * The failure this closes: three Codex accounts read `active` for days while signed out,
 * because a rollout-file snapshot (usage HISTORY) was taken as a clean poll. Now:
 *  - only a LIVE app-server read proves a Codex login; the rollout file never restores `active`;
 *  - a Codex account turns needs-reauth only when the CLI's own login check AND the live read
 *    both say signed out, on two consecutive polls; a transport failure never counts;
 *  - `loginCheck` is exposed next to the status so a gap is never silent;
 *  - Claude's login signal is the authenticated OAuth usage read (never `claude auth status`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaPoller, type FetchImpl } from '../../src/core/QuotaPoller.js';
import type { CodexLiveRead } from '../../src/providers/adapters/openai-codex/observability/codexLiveRateLimitReader.js';
import type { CliLoginVerdict } from '../../src/core/CliLoginStatus.js';

const NOW = Date.parse('2026-09-25T18:00:00Z');
const liveSnapshot = (used: number) => ({
  source: 'codex-app-server' as const, rolloutPath: '', threadId: null,
  capturedAt: '2026-09-25T18:00:00.000Z', model: null, planType: 'pro', rateLimitReachedType: null,
  primary: { usedPercent: used, remainingPercent: 100 - used, windowMinutes: 10080, resetsAt: 1790500000,
    resetsAtIso: '2026-09-27T18:13:20.000Z', resetsInSeconds: 1 },
  secondary: null,
});
const rolloutSnapshot = () => ({ ...liveSnapshot(40), source: 'codex-rollout' as const, rolloutPath: '/r.jsonl', threadId: 't' });
const CODEX = { nickname: 'codex', email: 'codex@example.test', provider: 'openai' as const,
  framework: 'codex-cli' as const, configHome: '/home/x/.codex-a' };

describe('QuotaPoller login check (spec skill-driven-signin-repair)', () => {
  let dir: string;
  let pool: SubscriptionPool;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-login-')); pool = new SubscriptionPool({ stateDir: dir }); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'quota-poller-login-check cleanup' }); });

  let clock = NOW;
  beforeEach(() => { clock = NOW; });
  const later = (ms = 15 * 60_000) => { clock += ms; };
  function poller(live: () => Promise<CodexLiveRead>, cli: () => Promise<CliLoginVerdict>, observed: unknown[] = []) {
    return new QuotaPoller({
      pool, now: () => clock,
      codexLiveUsageReaderDetailed: async () => live(),
      codexUsageReader: async () => rolloutSnapshot(),
      codexLoginStatus: async () => cli(),
      loginObservationSink: (input) => { observed.push(input.outcome); },
    });
  }

  it('moves a Codex account to needs-reauth only after TWO consecutive CLI-signed-out + auth-refused polls', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-a' });
    const observed: unknown[] = [];
    const p = poller(async () => ({ kind: 'auth-failed' }), async () => 'signed-out', observed);
    await p.pollAll();
    expect(pool.get('codex-a')!.status).toBe('active'); // one poll is not enough
    expect(p.loginCheck('codex-a')).toBe('signed-out');
    later(30_000);
    await p.pollAll(); // an on-demand poll seconds later does not count as the second one
    expect(pool.get('codex-a')!.status).toBe('active');
    later();
    await p.pollAll();
    expect(pool.get('codex-a')!.status).toBe('needs-reauth');
    expect(observed).toContainEqual({ kind: 'transition-to-needs-reauth',
      causeClass: 'cli-signed-out-auth-refused', corroboration: 'exchange-corroborated' });
  });

  it('a transport failure between two signed-out polls breaks the streak and changes nothing', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-b' });
    const reads: CodexLiveRead[] = [{ kind: 'auth-failed' }, { kind: 'unavailable' }, { kind: 'auth-failed' }];
    const p = poller(async () => reads.shift()!, async () => 'signed-out');
    await p.pollAll(); later();
    await p.pollAll(); later();
    expect(p.loginCheck('codex-b')).toBe('unavailable');
    await p.pollAll();
    expect(pool.get('codex-b')!.status).toBe('active');
  });

  it('a CLI that disagrees (says signed in) or cannot answer never flips the status', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-c' });
    const p = poller(async () => ({ kind: 'auth-failed' }), async () => 'signed-in');
    await p.pollAll(); later(); await p.pollAll(); later(); await p.pollAll();
    expect(pool.get('codex-c')!.status).toBe('active');
    expect(p.loginCheck('codex-c')).toBe('unavailable');
    pool.addFixture({ ...CODEX, id: 'codex-d', configHome: '/home/x/.codex-d' });
    const q = poller(async () => ({ kind: 'auth-failed' }), async () => 'unavailable');
    await q.pollAll(); later(); await q.pollAll();
    expect(pool.get('codex-d')!.status).toBe('active');
  });

  it('a rollout-file snapshot is usage history, never proof of login: it does not restore needs-reauth', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-e' });
    pool.update('codex-e', { status: 'needs-reauth' });
    const p = poller(async () => ({ kind: 'unavailable' }), async () => 'unavailable');
    await p.pollAll();
    expect(pool.get('codex-e')!.status).toBe('needs-reauth');
    expect(pool.get('codex-e')!.lastQuota?.source).toBe('codex-rollout'); // history still recorded
    expect(p.loginCheck('codex-e')).toBe('unavailable');
  });

  it('a live authenticated read restores needs-reauth → active and reads loginCheck ok (the other side)', async () => {
    pool.addFixture({ ...CODEX, id: 'codex-f' });
    pool.update('codex-f', { status: 'needs-reauth' });
    const p = poller(async () => ({ kind: 'ok', snapshot: liveSnapshot(30) }), async () => 'signed-in');
    await p.pollAll();
    expect(pool.get('codex-f')!.status).toBe('active');
    expect(p.loginCheck('codex-f')).toBe('ok');
  });

  it('Claude: the authenticated OAuth read is the login signal (ok / signed-out / unavailable)', async () => {
    const claude = { nickname: 'c', email: 'c@example.test', provider: 'anthropic' as const, framework: 'claude-code' as const };
    pool.addFixture({ ...claude, id: 'claude-ok', configHome: '/home/x/.claude-ok' });
    const ok: FetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 5, resets_at: 'x' } }) });
    const okPoller = new QuotaPoller({ pool, now: () => NOW, fetchImpl: ok, tokenResolver: () => 'tok' });
    await okPoller.pollAll();
    expect(okPoller.loginCheck('claude-ok')).toBe('ok');

    pool.addFixture({ ...claude, id: 'claude-dead', configHome: '/home/x/.claude-dead' });
    const denied: FetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const deadPoller = new QuotaPoller({ pool, now: () => NOW, fetchImpl: denied, tokenResolver: () => 'tok',
      refresher: async () => ({ ok: false, reason: 'no-refresh-token' }) as never });
    await deadPoller.pollAccount(pool.get('claude-dead')!);
    expect(deadPoller.loginCheck('claude-dead')).toBe('signed-out');

    // A later network failure on the SAME poller replaces a stale `ok` with `unavailable`.
    let up = true;
    const flaky: FetchImpl = async (...args) => { if (up) return ok(...args); throw new Error('network down'); };
    const flakyPoller = new QuotaPoller({ pool, now: () => NOW, fetchImpl: flaky, tokenResolver: () => 'tok' });
    await flakyPoller.pollAccount(pool.get('claude-ok')!);
    expect(flakyPoller.loginCheck('claude-ok')).toBe('ok');
    up = false;
    await flakyPoller.pollAccount(pool.get('claude-ok')!);
    expect(flakyPoller.loginCheck('claude-ok')).toBe('unavailable');
    const downPoller = new QuotaPoller({ pool, now: () => NOW, fetchImpl: flaky, tokenResolver: () => 'tok' });
    expect(downPoller.loginCheck('never-polled')).toBe('unavailable');
  });
});
