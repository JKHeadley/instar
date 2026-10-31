import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { SubscriptionAccount, SubscriptionPool } from '../../../src/core/SubscriptionPool.js';
import type { CodexUsageSnapshot } from '../../../src/providers/adapters/openai-codex/observability/codexRateLimitReader.js';
import {
  FeedbackTriageAccountSelector, liveTriageUsedPercent, verifyTriageExecutionIdentity,
} from '../../../src/feedback-factory/triage/FeedbackTriageAccountSelector.js';

const NOW = Date.parse('2026-10-31T05:00:00Z');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => SafeFsExecutor.safeRmSync(dir, {
  recursive: true, force: true, operation: 'triage-account-selector.test.ts',
})));

function account(id: string, status: SubscriptionAccount['status'] = 'active'): SubscriptionAccount {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-codex-'));
  dirs.push(home);
  const email = `${id}@example.test`;
  const token = `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.x`;
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: token, account_id: id } }));
  return { id, nickname: id, email, provider: 'openai', framework: 'codex-cli',
    configHome: home, status, enrolledAt: new Date(NOW).toISOString(), version: 1 } as SubscriptionAccount;
}

function pool(accounts: SubscriptionAccount[]): SubscriptionPool {
  return { list: () => accounts } as unknown as SubscriptionPool;
}

function snapshot(used: number, options: { source?: CodexUsageSnapshot['source']; ageMs?: number; secondary?: number | null } = {}): CodexUsageSnapshot {
  const window = (percent: number) => ({ usedPercent: percent, remainingPercent: 100 - percent,
    windowMinutes: 300, resetsAt: 1795000000, resetsAtIso: null, resetsInSeconds: null });
  return {
    source: options.source ?? 'codex-app-server', rolloutPath: '', threadId: null,
    capturedAt: new Date(NOW - (options.ageMs ?? 0)).toISOString(), model: null,
    planType: 'pro', rateLimitReachedType: null,
    primary: window(used), secondary: options.secondary === undefined || options.secondary === null ? null : window(options.secondary),
  };
}

describe('feedback triage account quota selection', () => {
  it('detects a credential replaced after launch without treating quota age as identity drift', async () => {
    const entry = account('late-change');
    const roster = pool([entry]);
    const selector = new FeedbackTriageAccountSelector(roster, async () => snapshot(12), () => NOW);
    const selected = await selector.select(NOW + 30_000);
    expect(selected.state).toBe('eligible');
    if (selected.state !== 'eligible') return;
    expect(verifyTriageExecutionIdentity(roster, selected.account)).toBe(true);
    fs.appendFileSync(path.join(entry.configHome, 'auth.json'), ' ');
    expect(verifyTriageExecutionIdentity(roster, selected.account)).toBe(false);
  });

  it('requires live fresh codex-family usage and both reported windows below 75', () => {
    expect(liveTriageUsedPercent(snapshot(74, { secondary: 75 }), NOW)).toBe(75);
    expect(liveTriageUsedPercent(snapshot(10, { secondary: 100 }), NOW)).toBe(100);
    expect(liveTriageUsedPercent(snapshot(10, { source: 'codex-rollout' }), NOW)).toBeNull();
    expect(liveTriageUsedPercent(snapshot(10, { ageMs: 60_001 }), NOW)).toBeNull();
    expect(liveTriageUsedPercent(snapshot(10, { ageMs: 60_000 }), NOW)).toBe(10);
    expect(liveTriageUsedPercent(snapshot(10, { secondary: null }), NOW)).toBe(10);
    expect(liveTriageUsedPercent({ ...snapshot(10), secondary: undefined } as unknown as CodexUsageSnapshot, NOW)).toBe(10);
  });

  it('continues to a later wave when earlier accounts are saturated or unreadable', async () => {
    const accounts = ['a', 'b', 'c', 'd'].map((id) => account(id));
    const selector = new FeedbackTriageAccountSelector(pool(accounts), async ({ codexHome }) => {
      const id = accounts.find((a) => a.configHome === codexHome)!.id;
      return id === 'a' ? snapshot(88) : id === 'b' ? null : id === 'c' ? snapshot(20) : snapshot(3);
    }, () => NOW);
    const result = await selector.select(NOW + 30_000);
    expect(result).toMatchObject({ state: 'eligible', account: { accountId: 'd', usedPercent: 3, limitFamily: 'codex' } });
  });

  it('reaches a healthy fourth account after three timed-out or unreadable probes', async () => {
    const accounts = ['a', 'b', 'c', 'd'].map((id) => account(id));
    const probed: string[] = [];
    const selector = new FeedbackTriageAccountSelector(pool(accounts), async ({ codexHome, timeoutMs }) => {
      const id = accounts.find((entry) => entry.configHome === codexHome)!.id;
      probed.push(id);
      if (id === 'd') return snapshot(7);
      // The live reader has its own child-timeout tests. Here a timeout result must
      // release the selector's two-account wave so a later account can be tried.
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 10)));
      return null;
    }, () => NOW);
    expect(await selector.select(NOW + 30_000)).toMatchObject({ state: 'eligible', account: { accountId: 'd' } });
    expect(probed).toEqual(['a', 'b', 'c', 'd']);
  });

  it('accepts a completed eligible read without waiting for a silent sibling', async () => {
    const accounts = [account('fast'), account('silent')];
    let cancelled = false;
    const selector = new FeedbackTriageAccountSelector(pool(accounts), async ({ codexHome, signal }) => {
      if (codexHome === accounts[0].configHome) return snapshot(12);
      return new Promise<null>((resolve) => {
        signal.addEventListener('abort', () => { cancelled = true; resolve(null); }, { once: true });
      });
    }, () => NOW);
    expect(await selector.select(NOW + 30_000)).toMatchObject({ state: 'eligible', account: { accountId: 'fast' } });
    expect(cancelled).toBe(true);
  });

  it('refuses warming and identity-drifted accounts and a credential changed during the live read', async () => {
    const warming = account('warming', 'warming');
    const drifted = account('drifted');
    drifted.identityDrifted = true;
    const changed = account('changed');
    const selector = new FeedbackTriageAccountSelector(pool([warming, drifted, changed]), async () => {
      fs.appendFileSync(path.join(changed.configHome, 'auth.json'), ' ');
      return snapshot(1);
    }, () => NOW);
    expect(await selector.select(NOW + 30_000)).toEqual({ state: 'unreadable' });
  });

  it('reports a verified 75-percent boundary as saturated, without selecting it', async () => {
    const selector = new FeedbackTriageAccountSelector(pool([account('a')]), async () => snapshot(75), () => NOW);
    expect(await selector.select(NOW + 30_000)).toEqual({ state: 'saturated' });
  });

  it('rejects a local API-key credential or custom provider config before a quota probe', async () => {
    const keyed = account('keyed');
    const custom = account('custom');
    const authPath = path.join(keyed.configHome, 'auth.json');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
    auth.OPENAI_API_KEY = 'sk-test';
    fs.writeFileSync(authPath, JSON.stringify(auth));
    fs.writeFileSync(path.join(custom.configHome, 'config.toml'), 'model_provider = "custom"\n');
    let reads = 0;
    const selector = new FeedbackTriageAccountSelector(pool([keyed, custom]), async () => { reads++; return snapshot(1); }, () => NOW);
    expect(await selector.select(NOW + 30_000)).toEqual({ state: 'unreadable' });
    expect(reads).toBe(0);
  });
});
