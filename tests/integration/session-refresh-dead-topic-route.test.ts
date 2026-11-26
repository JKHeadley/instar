/**
 * POST /sessions/refresh on a DEAD-but-still-mapped topic session (2026-10-14:
 * the 2.0 desk was reaped and the route answered `session_not_found`, so only an
 * inbound user message could bring it back). The route now respawns it directly
 * through the real SessionRefresh + respawner, synchronously (200); every other
 * refusal is unchanged.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SessionRefresh } from '../../src/core/SessionRefresh.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { TopicResumeMap } from '../../src/core/TopicResumeMap.js';

const AUTH = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };

describe('POST /sessions/refresh — dead mapped topic session (integration)', () => {
  let srv: import('node:http').Server | null = null;
  let dir = '';

  afterEach(async () => {
    if (srv) await new Promise<void>((r) => srv!.close(() => r()));
    srv = null;
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/session-refresh-dead-topic-route.test.ts:cleanup' });
    dir = '';
  });

  async function boot(opts: { alive: boolean; mappedTo: string | null; running: boolean; pin?: boolean; protected?: boolean; busy?: boolean; noWorkGate?: boolean; dryRun?: boolean; killFails?: boolean; localModel?: boolean; reuseState?: boolean; differentThread?: boolean; pinnedRefreshStopId?: string; hasSuccessor?: boolean }) {
    if (!opts.reuseState) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-dead-'));
    const respawner = vi.fn(async (_n: string, _t: number, _p: string | undefined, _options?: object) => 'echo-desk');
    const payload = Buffer.from(JSON.stringify({ email: 'target@example.org' })).toString('base64url');
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { id_token: `test.${payload}.test` } }));
    const target = { id: 'target', email: 'target@example.org', provider: 'openai', framework: 'codex-cli', status: 'active', configHome: dir };
    const source = {
      id: 'st-1', tmuxSession: 'echo-desk', status: opts.running ? 'running' : 'killed', pinnedRefreshStopId: opts.pinnedRefreshStopId,
      framework: 'codex-cli', subscriptionAccountId: 'source',
      claudeSessionId: '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2', telegramTopicId: 52075,
    };
    const state = {
      listSessions: vi.fn().mockReturnValue(opts.running ? [source] : []),
      getSession: vi.fn().mockReturnValue(source),
      hasTelegramSessionSuccessor: vi.fn().mockReturnValue(!!opts.hasSuccessor),
    } as unknown as StateManager;
    const killSession = vi.fn().mockReturnValue(!opts.killFails);
    const afterIdleProbe = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const unanswered = vi.fn<() => 'none' | 'unknown' | { from: string; body: string; at: string }>().mockReturnValue('none');
    const getPendingInjection = vi.fn();
    const refresh = new SessionRefresh({
      pinnedRebriefDir: path.join(dir, 'rebriefs'),
      sessionManager: { killSession, getPendingInjection, isSessionAlive: vi.fn().mockReturnValue(opts.alive) } as unknown as SessionManager,
      state,
      telegram: {
        getTopicForSession: vi.fn().mockReturnValue(opts.mappedTo === null ? null : 52075),
        getSessionForTopic: vi.fn().mockReturnValue(opts.mappedTo),
      } as unknown as TelegramAdapter,
      topicResumeMap: { findUuidForSession: vi.fn(), save: vi.fn(), remove: vi.fn(), getForFramework: vi.fn().mockReturnValue(opts.differentThread ? 'different-thread' : source.claudeSessionId) } as unknown as TopicResumeMap,
      respawner,
      workGateCtx: opts.noWorkGate ? undefined : {
        getKnobs: () => ({ enabled: true, dryRun: opts.dryRun === true, reactiveGraceMs: 0, recheckMs: 0 }),
        resolveUnansweredInbound: unanswered,
        probe: async () => {
          await afterIdleProbe();
          return {
            busy: !!opts.busy, turnLeg: opts.busy ? 'working' : 'idle', subagentLeg: 'ok',
            verifiedSubagentCoverage: true, turnInFlight: !!opts.busy, subagents: [], reason: opts.busy ? 'busy-turn' : null,
          };
        },
      },
    });
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 't', stateDir: dir, port: 0,
      subscriptionPool: { explicitRefreshAccountPin: opts.pin },
      sessions: { protectedSessions: opts.protected ? ['echo-desk'] : [] },
    }, startTime: new Date(), state, subscriptionPool: { list: () => [target] },
      topicProfile: { resolver: { resolve: () => ({ framework: 'codex-cli', sources: { model: opts.localModel ? 'local-model-binding' : 'profile-pin' } }) } },
      sessionRefresh: refresh } as never));
    const url = await new Promise<string>((resolve) => {
      srv = app.listen(0, () => resolve(`http://127.0.0.1:${(srv!.address() as AddressInfo).port}`));
    });
    return { url, respawner, killSession, target, afterIdleProbe, unanswered, getPendingInjection };
  }

  const post = (url: string, body: Record<string, unknown>) =>
    fetch(`${url}/sessions/refresh`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

  it('a dead session the topic still maps to is respawned synchronously (200), no kill', async () => {
    const { url, respawner, killSession } = await boot({ alive: false, mappedTo: 'echo-desk', running: false });
    const res = await post(url, { sessionName: 'echo-desk', followUpPrompt: 'rebuild' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, respawnedDead: true, topicId: 52075, newSessionName: 'echo-desk' });
    expect(respawner).toHaveBeenCalledWith('echo-desk', 52075, 'rebuild');
    expect(killSession).not.toHaveBeenCalled();
  });

  it('a topic now mapped to another session keeps the old 409 session_not_found', async () => {
    const { url, respawner } = await boot({ alive: false, mappedTo: 'echo-desk-2', running: false });
    const res = await post(url, { sessionName: 'echo-desk' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'session_not_found' });
    expect(respawner).not.toHaveBeenCalled();
  });

  it('a running session still takes the normal 202 kill-and-respawn path', async () => {
    const { url } = await boot({ alive: true, mappedTo: 'echo-desk', running: true });
    const res = await post(url, { sessionName: 'echo-desk' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, message: 'Refresh scheduled' });
  });

  it('refuses an explicit pin by default, without refreshing', async () => {
    const { url, killSession } = await boot({ alive: true, mappedTo: 'echo-desk', running: true });
    const res = await post(url, { sessionName: 'echo-desk', targetAccountId: 'target' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'refresh-account-pin-disabled' });
    expect(killSession).not.toHaveBeenCalled();
  });

  it('uses the selected account and forwards the rebrief through the real refresh', async () => {
    const { url, respawner, killSession } = await boot({ alive: true, mappedTo: 'echo-desk', running: true, pin: true });
    const res = await post(url, { sessionName: 'echo-desk', targetAccountId: 'target', followUpPrompt: 'Continue the existing work.' });
    expect(res.status).toBe(202);
    const receipt = await res.json() as { pinnedRefreshAttemptId: string };
    expect(receipt).toMatchObject({ targetAccountId: 'target', pinnedRefreshAttemptId: expect.any(String) });
    await vi.waitFor(() => expect(respawner).toHaveBeenCalledWith(
      'echo-desk', 52075, 'Continue the existing work.', { accountId: 'target', configHome: dir, expectedCodexEmail: 'target@example.org', expectedResumeThreadId: '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2', expectedSourceSessionId: 'st-1', pinnedRefreshAttemptId: receipt.pinnedRefreshAttemptId },
    ));
    expect(killSession).toHaveBeenCalledTimes(1);    expect(killSession).toHaveBeenCalledWith('st-1', expect.any(String));
  });

  it.each(['missing', 'protected', 'dead', 'forced', 'busy', 'local', 'unknown-idle', 'dry-run'] as const)('refuses a %s pinned refresh', async (mode) => {
    const { url, killSession, respawner } = await boot({
      alive: mode !== 'dead', mappedTo: 'echo-desk', running: mode !== 'dead',
      pin: true, protected: mode === 'protected', busy: mode === 'busy',
      noWorkGate: mode === 'unknown-idle', dryRun: mode === 'dry-run', localModel: mode === 'local',
    });
    const res = await post(url, {
      sessionName: 'echo-desk',
      targetAccountId: mode === 'missing' ? 'unknown' : 'target',
      force: mode === 'forced',
    });
    expect(res.status).toBe(mode === 'forced' ? 400 : 409);
    expect(killSession).not.toHaveBeenCalled();
    expect(respawner).not.toHaveBeenCalled();
  });

  it('rechecks the account immediately before killing the original session', async () => {
    const { url, killSession, respawner, target } = await boot({ alive: true, mappedTo: 'echo-desk', running: true, pin: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await post(url, { sessionName: 'echo-desk', targetAccountId: 'target' })).status).toBe(202);
      target.status = 'needs-reauth';
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('refresh_intent_changed')));
      expect(killSession).not.toHaveBeenCalled();
      expect(respawner).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not launch a replacement if termination is unconfirmed', async () => {
    const { url, killSession, respawner } = await boot({ alive: true, mappedTo: 'echo-desk', running: true, pin: true, killFails: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await post(url, { sessionName: 'echo-desk', targetAccountId: 'target', followUpPrompt: 'Do not replay.' })).status).toBe(202);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('refresh_kill_unconfirmed')));
      expect(killSession).toHaveBeenCalledWith('st-1', expect.any(String));
      expect(respawner).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(dir, 'rebriefs', 'echo-desk.json'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['queued', 'injected'] as const)('keeps a %s Telegram turn that races the final idle probe', async mode => {
    const harness = await boot({ alive: true, mappedTo: 'echo-desk', running: true, pin: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      harness.afterIdleProbe.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
        if (mode === 'queued') harness.unanswered.mockReturnValue({ from: 'User', body: 'New turn', at: new Date().toISOString() });
        else harness.getPendingInjection.mockReturnValue({ topicId: 52075, injectedAt: Date.now(), text: 'New turn' });
      });
      expect((await post(harness.url, { sessionName: 'echo-desk', targetAccountId: 'target' })).status).toBe(202);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('Incoming work is pending')));
      expect(harness.killSession).not.toHaveBeenCalled();
      expect(harness.respawner).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('recovers the exact rebrief after a failed launch and a server restart', async () => {
    const first = await boot({ alive: true, mappedTo: 'echo-desk', running: true, pin: true });
    first.respawner.mockRejectedValueOnce(new Error('native launch failed before injection'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const record = path.join(dir, 'rebriefs', 'echo-desk.json');
    try {
      const accepted = await post(first.url, {
        sessionName: 'echo-desk', targetAccountId: 'target', followUpPrompt: 'Resume the Engine milestone.',
      });
      expect(accepted.status).toBe(202);
      const receipt = await accepted.json() as { pinnedRefreshAttemptId: string };
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
        expect.stringContaining('unexpected error'), expect.any(Error),
      ));
      const stopped = JSON.parse(fs.readFileSync(record, 'utf8'));
      expect(stopped).toMatchObject({ sourceId: 'st-1', topicId: 52075, threadId: '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2', rebrief: 'Resume the Engine milestone.', stopId: receipt.pinnedRefreshAttemptId });
      expect(first.killSession).toHaveBeenCalledWith('st-1', stopped.stopId);
      await new Promise<void>(resolve => srv!.close(() => resolve()));
      srv = null;
      const restarted = await boot({ alive: false, mappedTo: null, running: false, reuseState: true, pinnedRefreshStopId: stopped.stopId });
      const recovery = await post(restarted.url, { sessionName: 'echo-desk' });
      expect(recovery.status).toBe(200);
      expect(restarted.respawner).toHaveBeenCalledTimes(1);
      expect(restarted.respawner).toHaveBeenCalledWith(
        'echo-desk', 52075, 'Resume the Engine milestone.', { expectedResumeThreadId: '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2', expectedSourceSessionId: 'st-1' },
      );
      expect(fs.existsSync(record)).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  it.each(['changed-thread', 'ended-successor'] as const)('does not recover a stale rebrief after %s', async mode => {
    const restarted = await boot({ alive: false, mappedTo: null, running: false, differentThread: mode === 'changed-thread', hasSuccessor: mode === 'ended-successor', pinnedRefreshStopId: 'attempt-1' });
    const folder = path.join(dir, 'rebriefs');
    fs.mkdirSync(folder);
    const record = path.join(folder, 'echo-desk.json');
    fs.writeFileSync(record, JSON.stringify({
      sourceId: 'st-1', topicId: 52075, threadId: '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2',
      rebrief: 'Earlier project work.', stopId: 'attempt-1',
    }));
    const recovery = await post(restarted.url, { sessionName: 'echo-desk' });
    expect(recovery.status).toBe(409);
    expect(restarted.respawner).not.toHaveBeenCalled();
    expect(fs.existsSync(record)).toBe(true);
  });
});
