/**
 * Account-swap continuity must be VERIFIED, not assumed (topic 54028 incident,
 * 2026-11-11): a proactive swap whose transcript could not be placed in the
 * target login (outcome 'one-shot') still killed the worker, respawned it
 * without its conversation or its spawn brief, and logged "conversation
 * preserved via --resume".
 *
 * Contract:
 *  - proactive swap + transcript not placeable → refused BEFORE the kill
 *    (the original session keeps running on its current account);
 *  - a swap that must proceed anyway (reactive) re-delivers the original
 *    spawn brief and reports conversationPreserved:false;
 *  - the scheduler never logs "conversation preserved" for such a swap.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/claudeResumeTranscript.js', () => ({
  placeResumeTranscript: vi.fn(async () => 'one-shot'),
}));

import { SessionRefresh } from '../../src/core/SessionRefresh.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';

const BRIEF = 'BRIEF: build the iMessage verification-code relay for the studio phone number.';

function makeRefresh() {
  const killSession = vi.fn(() => true);
  const respawner = vi.fn(async (_n: string, _t: number, _p: string | undefined) => 'sagemind-workspace-phone-number');
  const refresh = new SessionRefresh({
    sessionManager: { killSession, isSessionAlive: vi.fn(() => true) } as unknown as SessionManager,
    state: {
      listSessions: vi.fn(() => [{
        id: 'state-1',
        tmuxSession: 'sagemind-studio-imessage-codes',
        status: 'running',
        claudeSessionId: '98b9e703-0000-4000-8000-000000000000',
        prompt: BRIEF,
      }]),
    } as unknown as StateManager,
    telegram: { getTopicForSession: vi.fn(() => 54028) } as unknown as TelegramAdapter,
    topicResumeMap: { findUuidForSession: vi.fn(), save: vi.fn(), remove: vi.fn() } as unknown as TopicResumeMap,
    respawner,
  });
  return { refresh, killSession, respawner };
}

describe('account-swap continuity is verified before the swap completes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a proactive swap whose transcript cannot be placed, without killing the session', async () => {
    const { refresh, killSession, respawner } = makeRefresh();
    const result = await refresh.refreshSession({
      sessionName: 'sagemind-studio-imessage-codes',
      reason: 'quota-swap: appyhapi → sagemind-luna',
      configHome: '/nonexistent/.claude-followme-sagemind-luna',
      accountId: 'sagemind-luna',
      callerClass: 'proactive-swap',
    });
    expect(result.ok).toBe(false);
    expect(killSession).not.toHaveBeenCalled();
    expect(respawner).not.toHaveBeenCalled();
  });

  it('a swap that must proceed re-delivers the original brief and reports the conversation as not preserved', async () => {
    const { refresh, respawner } = makeRefresh();
    const result = await refresh.refreshSession({
      sessionName: 'sagemind-studio-imessage-codes',
      configHome: '/nonexistent/.claude-followme-sagemind-luna',
      accountId: 'sagemind-luna',
      callerClass: 'reactive-swap',
    });
    expect(result.ok).toBe(true);
    expect(respawner).toHaveBeenCalledTimes(1);
    expect(respawner.mock.calls[0][2] ?? '').toContain(BRIEF);
    expect(result.ok && result.conversationPreserved).toBe(false);
  });

  it('the scheduler does not claim the conversation was preserved when it was not', async () => {
    const logs: string[] = [];
    const accounts = [
      { id: 'a', framework: 'claude-code', configHome: '/x/a' },
      { id: 'b', framework: 'claude-code', configHome: '/x/b' },
    ] as unknown as SubscriptionAccount[];
    const sched = new QuotaAwareScheduler({
      listAccounts: () => accounts,
      refreshFn: async () => ({ ok: true, conversationPreserved: false }),
      logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });
    const r = await sched.onQuotaPressure({
      sessionName: 'sagemind-studio-imessage-codes',
      exhaustedAccountId: 'a',
      nowMs: Date.now(),
      targetAccountId: 'b',
    });
    expect(r.swapped).toBe(true);
    expect(logs.join('\n')).not.toContain('conversation preserved');
  });

  it.each([
    ['a legacy boolean result', async () => true],
    ['an object result without the field', async () => ({ ok: true })],
  ] as const)('the scheduler reports preservation as unknown for %s, never as confirmed', async (_label, refreshFn) => {
    const logs: string[] = [];
    const accounts = [
      { id: 'a', framework: 'claude-code', configHome: '/x/a' },
      { id: 'b', framework: 'claude-code', configHome: '/x/b' },
    ] as unknown as SubscriptionAccount[];
    const sched = new QuotaAwareScheduler({
      listAccounts: () => accounts,
      refreshFn: refreshFn as never,
      logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });
    const r = await sched.onQuotaPressure({
      sessionName: 'sagemind-studio-imessage-codes',
      exhaustedAccountId: 'a',
      nowMs: Date.now(),
      targetAccountId: 'b',
    });
    expect(r.swapped).toBe(true);
    const all = logs.join('\n');
    expect(all).not.toContain('conversation preserved');
    expect(all).toContain('is unknown (not reported)');
  });

  it('the scheduler still reports confirmed preservation when the refresh says so', async () => {
    const logs: string[] = [];
    const accounts = [
      { id: 'a', framework: 'claude-code', configHome: '/x/a' },
      { id: 'b', framework: 'claude-code', configHome: '/x/b' },
    ] as unknown as SubscriptionAccount[];
    const sched = new QuotaAwareScheduler({
      listAccounts: () => accounts,
      refreshFn: async () => ({ ok: true, conversationPreserved: true }),
      logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });
    const r = await sched.onQuotaPressure({
      sessionName: 'sagemind-studio-imessage-codes',
      exhaustedAccountId: 'a',
      nowMs: Date.now(),
      targetAccountId: 'b',
    });
    expect(r.swapped).toBe(true);
    expect(logs.join('\n')).toContain('conversation preserved via --resume');
  });
});
