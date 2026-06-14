/**
 * Tests for the §10.5 (TOPIC-PROFILE-SPEC) Slack arm of SessionRefresh —
 * binding resolution for Slack-bound sessions + the Slack-capable respawner
 * path, so a profile-change respawn works for Slack-bound sessions, not only
 * Telegram-bound ones.
 *
 * Contract points under test:
 *  - Telegram-bound resolution takes PRECEDENCE (existing behavior preserved
 *    byte-for-byte — the Slack arm only engages after both Telegram lookups
 *    miss).
 *  - Slack binding resolves via getChannelForSession, with the optional
 *    disk-backed fallback mirroring the Telegram arm.
 *  - Kill → (fresh-clear) → respawn ORDER on the Slack path, with the fresh
 *    clear routed to the adapter's channel-resume map (routing-key keyed),
 *    NOT TopicResumeMap.
 *  - Structured refusals: slack_respawner_unwired (bound but unwired),
 *    not_telegram_bound (unbound on both), no_telegram_adapter (neither
 *    platform dep present).
 *  - Result shape: platform:'slack', conversationKey 'slack:<routingKey>',
 *    and the stable negative synthetic topicId matching the
 *    server.ts:slackChannelToSyntheticId hash.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRefresh } from '../../src/core/SessionRefresh.js';
import {
  slackConversationKey,
  parseSlackConversationKey,
  slackRoutingKeySyntheticId,
  type SlackRefreshBinding,
} from '../../src/core/slackRefreshBinding.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { TopicResumeMap } from '../../src/core/TopicResumeMap.js';

function makeDeps(overrides: {
  /** Telegram in-memory topic. Default null (the Slack-session case). */
  telegramTopicId?: number | null;
  /** Telegram disk-fallback topic. Omit to leave the method off the mock. */
  telegramDiskTopicId?: number | null;
  /** Slack in-memory routing key. Default 'C0SLACK01'. */
  slackRoutingKey?: string | null;
  /** Slack disk-fallback routing key. Omit to leave the method off the mock. */
  slackDiskRoutingKey?: string | null;
  noTelegram?: boolean;
  noSlack?: boolean;
  noSlackRespawner?: boolean;
  stateSession?: { id: string; tmuxSession: string } | null;
  slackRespawnerImpl?: (
    sessionName: string,
    routingKey: string,
    followUpPrompt: string | undefined,
    accountSwap?: { configHome?: string; accountId?: string },
  ) => Promise<string>;
  rateLimit?: { maxPerWindow: number; windowMs: number };
} = {}) {
  const telegramTopicId = overrides.telegramTopicId === undefined ? null : overrides.telegramTopicId;
  const slackRoutingKey = overrides.slackRoutingKey === undefined ? 'C0SLACK01' : overrides.slackRoutingKey;
  const stateSession = overrides.stateSession === undefined
    ? { id: 'state-id-1', tmuxSession: 'echo-slack-session' }
    : overrides.stateSession;

  const callOrder: string[] = [];

  const telegram: Partial<TelegramAdapter> = {
    getTopicForSession: vi.fn().mockReturnValue(telegramTopicId),
  };
  if (overrides.telegramDiskTopicId !== undefined) {
    telegram.resolveTopicForSessionFromDisk = vi.fn().mockReturnValue(overrides.telegramDiskTopicId);
  }

  const slack: SlackRefreshBinding = {
    getChannelForSession: vi.fn().mockReturnValue(slackRoutingKey),
    removeChannelResume: vi.fn((_key: string) => {
      callOrder.push('removeChannelResume');
    }),
  };
  if (overrides.slackDiskRoutingKey !== undefined) {
    slack.resolveChannelForSessionFromDisk = vi.fn().mockReturnValue(overrides.slackDiskRoutingKey);
  }

  const topicResumeMap: Partial<TopicResumeMap> = {
    findUuidForSession: vi.fn(),
    save: vi.fn(),
    remove: vi.fn((_topic: number) => {
      callOrder.push('removeTopicResume');
    }) as unknown as TopicResumeMap['remove'],
  };
  const sessionManager: Partial<SessionManager> = {
    killSession: vi.fn((_id: string) => {
      callOrder.push('killSession');
      return true;
    }) as unknown as SessionManager['killSession'],
  };
  const state: Partial<StateManager> = {
    listSessions: vi.fn().mockReturnValue(stateSession ? [stateSession] : []) as unknown as StateManager['listSessions'],
  };

  const respawner = vi.fn(async (_name: string, _topic: number, _prompt: string | undefined) => {
    callOrder.push('telegramRespawner');
    return 'new-telegram-session';
  });
  const slackRespawner = overrides.slackRespawnerImpl
    ? vi.fn(overrides.slackRespawnerImpl)
    : vi.fn(async (_name: string, _key: string, _prompt: string | undefined) => {
        callOrder.push('slackRespawner');
        return 'new-slack-session';
      });

  const refresh = new SessionRefresh({
    sessionManager: sessionManager as SessionManager,
    state: state as StateManager,
    telegram: overrides.noTelegram ? null : (telegram as TelegramAdapter),
    topicResumeMap: topicResumeMap as TopicResumeMap,
    respawner,
    slack: overrides.noSlack ? null : slack,
    slackRespawner: overrides.noSlackRespawner ? null : slackRespawner,
    rateLimit: overrides.rateLimit,
  });

  return { refresh, telegram, slack, topicResumeMap, sessionManager, state, respawner, slackRespawner, callOrder };
}

describe('SessionRefresh — Slack arm (§10.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path (Slack-bound session)', () => {
    it('respawns via the slackRespawner with the routing key and returns the §10.5 result shape', async () => {
      const { refresh, slackRespawner, respawner } = makeDeps();

      const result = await refresh.refreshSession({ sessionName: 'echo-slack-session', followUpPrompt: 'continue' });

      expect(result).toEqual({
        ok: true,
        newSessionName: 'new-slack-session',
        topicId: slackRoutingKeySyntheticId('C0SLACK01'),
        platform: 'slack',
        conversationKey: 'slack:C0SLACK01',
      });
      expect(slackRespawner).toHaveBeenCalledWith('echo-slack-session', 'C0SLACK01', 'continue', undefined);
      // The Telegram respawner must never fire for a Slack-bound session.
      expect(respawner).not.toHaveBeenCalled();
    });

    it('kills the old session via sessionManager BEFORE invoking the slackRespawner', async () => {
      const { refresh, sessionManager, callOrder } = makeDeps();

      await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(sessionManager.killSession).toHaveBeenCalledWith('state-id-1');
      // Order is load-bearing: the kill fires beforeSessionKill, which is what
      // persists the Slack channel-resume entry the respawner then consumes.
      expect(callOrder).toEqual(['killSession', 'slackRespawner']);
    });

    it('handles a THREAD routing key (`<channelId>:<thread_ts>`) end-to-end', async () => {
      const threadKey = 'C0SLACK01:1718000000.000100';
      const { refresh, slackRespawner } = makeDeps({ slackRoutingKey: threadKey });

      const result = await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(result).toMatchObject({
        ok: true,
        platform: 'slack',
        conversationKey: `slack:${threadKey}`,
        topicId: slackRoutingKeySyntheticId(threadKey),
      });
      expect(slackRespawner).toHaveBeenCalledWith('echo-slack-session', threadKey, undefined, undefined);
    });
  });

  describe('binding precedence (Telegram first, byte-for-byte)', () => {
    it('a Telegram-bound session never consults the Slack binding and keeps the pre-Slack result shape', async () => {
      const { refresh, slack, respawner, slackRespawner } = makeDeps({ telegramTopicId: 9235 });

      const result = await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      // EXACT equality: no platform/conversationKey fields appear on the
      // Telegram result — existing consumers see the identical shape.
      expect(result).toEqual({ ok: true, newSessionName: 'new-telegram-session', topicId: 9235 });
      expect(respawner).toHaveBeenCalledWith('echo-slack-session', 9235, undefined, undefined);
      expect(slack.getChannelForSession).not.toHaveBeenCalled();
      expect(slackRespawner).not.toHaveBeenCalled();
    });

    it('consults Slack only after BOTH Telegram lookups (in-memory + disk) miss', async () => {
      const { refresh, telegram, slack } = makeDeps({
        telegramTopicId: null,
        telegramDiskTopicId: null,
      });

      const result = await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(result.ok).toBe(true);
      expect(telegram.getTopicForSession).toHaveBeenCalled();
      expect(telegram.resolveTopicForSessionFromDisk).toHaveBeenCalledWith('echo-slack-session');
      expect(slack.getChannelForSession).toHaveBeenCalledWith('echo-slack-session');
    });

    it('a Telegram DISK-fallback hit still wins over a Slack binding', async () => {
      const { refresh, slack, respawner, slackRespawner } = makeDeps({
        telegramTopicId: null,
        telegramDiskTopicId: 13435,
      });

      const result = await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(result).toEqual({ ok: true, newSessionName: 'new-telegram-session', topicId: 13435 });
      expect(respawner).toHaveBeenCalled();
      expect(slack.getChannelForSession).not.toHaveBeenCalled();
      expect(slackRespawner).not.toHaveBeenCalled();
    });
  });

  describe('Slack disk-backed fallback', () => {
    it('resolves the routing key from disk when the in-memory registry misses', async () => {
      const { refresh, slack, slackRespawner } = makeDeps({
        slackRoutingKey: null,
        slackDiskRoutingKey: 'C0FROMDISK',
      });

      const result = await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(result).toMatchObject({ ok: true, platform: 'slack', conversationKey: 'slack:C0FROMDISK' });
      expect(slack.resolveChannelForSessionFromDisk).toHaveBeenCalledWith('echo-slack-session');
      expect(slackRespawner).toHaveBeenCalledWith('echo-slack-session', 'C0FROMDISK', undefined, undefined);
    });

    it('does NOT consult the disk fallback when the in-memory lookup hits', async () => {
      const { refresh, slack } = makeDeps({
        slackRoutingKey: 'C0INMEM',
        slackDiskRoutingKey: 'C0FROMDISK',
      });

      const result = await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(result).toMatchObject({ ok: true, conversationKey: 'slack:C0INMEM' });
      expect(slack.resolveChannelForSessionFromDisk).not.toHaveBeenCalled();
    });

    it('tolerates an adapter without the optional disk-fallback method', async () => {
      // slackDiskRoutingKey omitted → method absent on the binding object.
      const { refresh } = makeDeps({ slackRoutingKey: null });

      const result = await refresh.refreshSession({ sessionName: 'orphan-session' });

      expect(result.ok).toBe(false);
      expect((result as { code: string }).code).toBe('not_telegram_bound');
    });
  });

  describe('fresh mode (poisoned-transcript recovery, Slack-routed)', () => {
    it('clears the SLACK channel resume AFTER kill and BEFORE respawn — never TopicResumeMap', async () => {
      const { refresh, slack, topicResumeMap, callOrder } = makeDeps();

      const result = await refresh.refreshSession({ sessionName: 'echo-slack-session', fresh: true });

      expect(result.ok).toBe(true);
      expect(slack.removeChannelResume).toHaveBeenCalledWith('C0SLACK01');
      // The Telegram resume map must NOT be touched on the Slack path — the
      // entry beforeSessionKill saved lives in the adapter's channel-resume
      // map, keyed on the routing key.
      expect(topicResumeMap.remove).not.toHaveBeenCalled();
      // Order is load-bearing: beforeSessionKill (inside killSession) writes
      // the entry; the clear must land after the kill and before the
      // respawner reads the map.
      expect(callOrder).toEqual(['killSession', 'removeChannelResume', 'slackRespawner']);
    });

    it('default (no fresh) preserves the channel resume — never clears it', async () => {
      const { refresh, slack, callOrder } = makeDeps();

      await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(slack.removeChannelResume).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['killSession', 'slackRespawner']);
    });

    it('clears with the THREAD routing key when the binding is a thread', async () => {
      const threadKey = 'C0SLACK01:1718000000.000100';
      const { refresh, slack } = makeDeps({ slackRoutingKey: threadKey });

      await refresh.refreshSession({ sessionName: 'echo-slack-session', fresh: true });

      expect(slack.removeChannelResume).toHaveBeenCalledWith(threadKey);
    });
  });

  describe('structured refusals', () => {
    it('returns slack_respawner_unwired when Slack-bound but no slackRespawner is wired (no kill fired)', async () => {
      const { refresh, sessionManager, respawner } = makeDeps({ noSlackRespawner: true });

      const result = await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(result).toEqual({
        ok: false,
        code: 'slack_respawner_unwired',
        message: expect.stringContaining('slack:C0SLACK01'),
      });
      // §10.5 honest degradation: the session must be left ALIVE so it can
      // resume via CONTINUATION on the next message — a kill here would turn
      // the degradation into an outage.
      expect(sessionManager.killSession).not.toHaveBeenCalled();
      expect(respawner).not.toHaveBeenCalled();
    });

    it('returns not_telegram_bound (back-compat code) when unbound on BOTH platforms, naming both in the message', async () => {
      const { refresh, sessionManager } = makeDeps({ slackRoutingKey: null });

      const result = await refresh.refreshSession({ sessionName: 'orphan-session' });

      expect(result).toEqual({
        ok: false,
        code: 'not_telegram_bound',
        message: expect.stringContaining('or Slack conversation'),
      });
      expect(sessionManager.killSession).not.toHaveBeenCalled();
    });

    it('returns no_telegram_adapter only when NEITHER platform dep is wired', async () => {
      const { refresh } = makeDeps({ noTelegram: true, noSlack: true });

      const result = await refresh.refreshSession({ sessionName: 'whoever' });

      expect(result).toEqual({
        ok: false,
        code: 'no_telegram_adapter',
        message: expect.stringContaining('No Telegram adapter wired'),
      });
    });

    it('a Slack-bound session refreshes fine on a server with NO Telegram adapter', async () => {
      // The pre-§10.5 code returned no_telegram_adapter unconditionally when
      // telegram was absent — this is the boundary that changed.
      const { refresh, slackRespawner } = makeDeps({ noTelegram: true });

      const result = await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(result).toMatchObject({ ok: true, platform: 'slack', newSessionName: 'new-slack-session' });
      expect(slackRespawner).toHaveBeenCalled();
    });

    it('returns session_not_found when no running state session matches (Slack-bound)', async () => {
      const { refresh, slackRespawner, sessionManager } = makeDeps({ stateSession: null });

      const result = await refresh.refreshSession({ sessionName: 'ghost-session' });

      expect(result).toEqual({
        ok: false,
        code: 'session_not_found',
        message: expect.stringContaining('No running session'),
      });
      expect(slackRespawner).not.toHaveBeenCalled();
      expect(sessionManager.killSession).not.toHaveBeenCalled();
    });
  });

  describe('shared guards apply to the Slack path', () => {
    it('rate guard blocks the (maxPerWindow + 1)th Slack refresh', async () => {
      const { refresh, slackRespawner } = makeDeps({ rateLimit: { maxPerWindow: 2, windowMs: 60_000 } });

      expect((await refresh.refreshSession({ sessionName: 'echo-slack-session' })).ok).toBe(true);
      expect((await refresh.refreshSession({ sessionName: 'echo-slack-session' })).ok).toBe(true);
      const blocked = await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(blocked).toMatchObject({ ok: false, code: 'rate_limited' });
      expect(slackRespawner).toHaveBeenCalledTimes(2);
    });

    it('in-flight guard refuses a concurrent Slack refresh for the same session', async () => {
      let release!: (v: string) => void;
      const held = new Promise<string>(r => { release = r; });
      const { refresh, sessionManager } = makeDeps({
        slackRespawnerImpl: async () => held,
      });

      const p1 = refresh.refreshSession({ sessionName: 'echo-slack-session' });
      await Promise.resolve();
      await Promise.resolve();
      const second = await refresh.refreshSession({ sessionName: 'echo-slack-session' });

      expect(second).toMatchObject({ ok: false, code: 'refresh_in_progress' });
      expect(sessionManager.killSession).toHaveBeenCalledTimes(1);

      release('new-slack-session');
      expect((await p1).ok).toBe(true);
    });
  });

  describe('account-swap on the Slack path', () => {
    let tmpHome: string;
    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-refresh-swap-home-'));
    });
    afterEach(() => {
      try { SafeFsExecutor.safeRmSync(tmpHome, { recursive: true, force: true, operation: 'tests/unit/sessionRefresh-slack.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
    });

    it('forwards the accountSwap to the slackRespawner and seeds onboarding flags BEFORE it runs', async () => {
      fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-1' } }));
      let flagsAtRespawnTime: Record<string, unknown> | null = null;
      const { refresh, slackRespawner } = makeDeps({
        slackRespawnerImpl: async () => {
          try {
            flagsAtRespawnTime = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8'));
          } catch { flagsAtRespawnTime = null; }
          return 'new-slack-session';
        },
      });

      const result = await refresh.refreshSession({
        sessionName: 'echo-slack-session',
        configHome: tmpHome,
        accountId: 'acct-2',
      });

      expect(result.ok).toBe(true);
      expect(slackRespawner).toHaveBeenCalledWith(
        'echo-slack-session',
        'C0SLACK01',
        undefined,
        { configHome: tmpHome, accountId: 'acct-2' },
      );
      expect(flagsAtRespawnTime).toMatchObject({ hasCompletedOnboarding: true });
    });
  });

  describe('key-scheme helpers', () => {
    it('slackConversationKey / parseSlackConversationKey round-trip channel and thread keys', () => {
      expect(slackConversationKey('C0SLACK01')).toBe('slack:C0SLACK01');
      expect(parseSlackConversationKey('slack:C0SLACK01')).toBe('C0SLACK01');
      expect(parseSlackConversationKey('slack:C0SLACK01:1718000000.000100')).toBe('C0SLACK01:1718000000.000100');
      expect(parseSlackConversationKey('9235')).toBeNull(); // bare numeric = Telegram
      expect(parseSlackConversationKey('slack:')).toBeNull(); // empty routing key
    });

    it('slackRoutingKeySyntheticId matches the server.ts:slackChannelToSyntheticId hash, is negative and stable', () => {
      // Reference implementation copied verbatim from
      // src/commands/server.ts:slackChannelToSyntheticId — the two must agree
      // so PresenceProxy / resume-heartbeat / refresh results all bridge a
      // given Slack conversation to the SAME numeric id.
      function reference(channelId: string): number {
        let hash = 0;
        for (let i = 0; i < channelId.length; i++) {
          hash = ((hash << 5) - hash + channelId.charCodeAt(i)) | 0;
        }
        return -(Math.abs(hash) + 1);
      }
      for (const key of ['C0SLACK01', 'C0SLACK01:1718000000.000100', 'D0DMCHAN', 'x']) {
        const id = slackRoutingKeySyntheticId(key);
        expect(id).toBe(reference(key));
        expect(id).toBeLessThan(0);
        expect(id).toBe(slackRoutingKeySyntheticId(key)); // stable
      }
      // Distinct keys map to distinct ids (channel vs its thread).
      expect(slackRoutingKeySyntheticId('C0SLACK01'))
        .not.toBe(slackRoutingKeySyntheticId('C0SLACK01:1718000000.000100'));
    });
  });
});
