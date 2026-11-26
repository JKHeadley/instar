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

  async function boot(opts: { alive: boolean; mappedTo: string; running: boolean }) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-dead-'));
    const respawner = vi.fn(async (_n: string, _t: number, _p: string | undefined) => 'echo-desk');
    const killSession = vi.fn().mockReturnValue(true);
    const refresh = new SessionRefresh({
      sessionManager: { killSession, isSessionAlive: vi.fn().mockReturnValue(opts.alive) } as unknown as SessionManager,
      state: {
        listSessions: vi.fn().mockReturnValue(opts.running ? [{ id: 'st-1', tmuxSession: 'echo-desk' }] : []),
      } as unknown as StateManager,
      telegram: {
        getTopicForSession: vi.fn().mockReturnValue(52075),
        getSessionForTopic: vi.fn().mockReturnValue(opts.mappedTo),
      } as unknown as TelegramAdapter,
      topicResumeMap: { findUuidForSession: vi.fn(), save: vi.fn(), remove: vi.fn() } as unknown as TopicResumeMap,
      respawner,
    });
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), sessionRefresh: refresh } as never));
    const url = await new Promise<string>((resolve) => {
      srv = app.listen(0, () => resolve(`http://127.0.0.1:${(srv!.address() as AddressInfo).port}`));
    });
    return { url, respawner, killSession };
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
});
