/** The production HTTP route and Telegram adapter keep a verified title alive. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('verified topic names on the live HTTP path', () => {
  it('serves the real title after a placeholder rebind and session close', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-verified-topic-e2e-'));
    const telegram = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, dir);
    const sessions = [
      { id: 'known', name: 'echo-topic-127504', tmuxSession: 'echo-topic-127504', status: 'running', startedAt: new Date().toISOString(), telegramTopicId: 127504 },
      { id: 'unknown', name: 'echo-topic-99', tmuxSession: 'echo-topic-99', status: 'running', startedAt: new Date().toISOString(), telegramTopicId: 99 },
    ];
    const app = express();
    app.use(createRoutes({
      config: { authToken: 'fixture-auth', stateDir: dir, port: 0, sessions: { maxSessions: 5 } },
      telegram,
      state: { listSessions: () => sessions },
      sessionManager: { getCachedRunningSessions: () => ({ sessions }) },
      messagingToneGate: null, outboundDedupGate: null, topicIntentArcCheck: null, topicMemory: null,
    } as never));
    const server = await new Promise<import('node:http').Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      telegram.registerTopicSession(127504, 'first', 'Instar dashboard makeover');
      telegram.registerTopicSession(127504, 'second', 'topic-127504');
      telegram.unregisterTopic(127504);
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/telegram/topics?scope=pool`, {
        headers: { Authorization: 'Bearer fixture-auth' },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { topics: Array<{ topicId: number; topicName: string }>; pool: { unresolved: number[] } };
      expect(body.topics).toContainEqual(expect.objectContaining({ topicId: 127504, topicName: 'Instar dashboard makeover' }));
      expect(body.pool.unresolved).toEqual([]);
      const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, { headers: { Authorization: 'Bearer fixture-auth' } });
      expect(sessionResponse.status).toBe(200);
      const listed = await sessionResponse.json() as Array<{ name: string }>;
      expect(listed.map(s => s.name)).toEqual(['Instar dashboard makeover', 'Conversation name unavailable']);
      const statusResponse = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: 'Bearer fixture-auth' } });
      expect(statusResponse.status).toBe(200);
      const status = await statusResponse.json() as { sessions: { list: Array<{ name: string }> } };
      expect(status.sessions.list.map(s => s.name)).toEqual(['Instar dashboard makeover', 'Conversation name unavailable']);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await telegram.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/verified-topic-names-lifecycle.test.ts:cleanup' });
    }
  });
});
