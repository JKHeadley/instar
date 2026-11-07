/**
 * Two team boundaries in their real code: a team phone's words are never commands, a second
 * machine is refused at the real pair route (docs/specs/team-roles-and-access.md §4.1).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { wireTelegramRouting } from '../../src/commands/server.js';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { Message } from '../../src/core/types.js';

function wired() {
  const inject = vi.fn();
  const findOrCreateForumTopic = vi.fn(async () => ({ topicId: 900, name: 'x' }));
  const adapter = {
    onTopicMessage: null as null | ((m: Message) => Promise<void>),
    isAuthorizedSender: () => true, handleCommand: async () => false, getTopicName: () => 'Client work', resolveTopicName: async () => 'Client work',
    getSessionForTopic: () => 'live-session', getTopicHistory: () => [], getLifelineTopicId: () => 1, registerTopicSession: vi.fn(),
    sendToTopic: vi.fn(async () => ({ ok: true })), sendMessageThroughFunnel: vi.fn(), findOrCreateForumTopic, trackMessageInjection: vi.fn(), isPolling: false,
  };
  const sessions = {
    isSessionAlive: () => true, requiresCodexGenerationRespawn: () => false, captureOutput: () => '', clearSessionFrameworkCache: vi.fn(),
    spawnInteractiveSession: vi.fn(async () => 'x'), injectTelegramMessage: inject,
  };
  wireTelegramRouting(adapter as unknown as TelegramAdapter, sessions as unknown as SessionManager);
  const say = (content: string, metadata: Record<string, unknown>) => adapter.onTopicMessage!({
    id: 'm', userId: '5', content, channel: { type: 'telegram', identifier: '50' }, receivedAt: new Date().toISOString(),
    metadata: { messageThreadId: 50, telegramUserId: 5, firstName: 'Mia', ...metadata },
  } as Message);
  return { inject, findOrCreateForumTopic, say };
}

describe('a team phone\'s words are never commands', () => {
  it.each(['/new', '/new Payroll'])('"%s" from a team phone reaches the session as plain text and opens no topic', async (text) => {
    const w = wired();
    await w.say(text, { teamPhone: true });
    await vi.waitFor(() => expect(w.inject).toHaveBeenCalled());
    expect(String(w.inject.mock.calls[0].join(' '))).toContain(text);
    expect(w.findOrCreateForumTopic).not.toHaveBeenCalled();
  });

  it('the same words from anyone else are still the command', async () => {
    const w = wired();
    await w.say('/new', {});
    await vi.waitFor(() => expect(w.findOrCreateForumTopic).toHaveBeenCalled());
    expect(w.inject).not.toHaveBeenCalled();
  });
});

describe('POST /api/pair on an agent that has had a team', () => {
  const appWith = (teamJoinBlocked: () => boolean) => {
    const app = express();
    app.use(express.json());
    app.use(createMachineRoutes({
      identityManager: { baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-pair-')) }, heartbeatManager: {}, securityLog: { append: () => undefined }, authDeps: {}, localMachineId: 'm1', localSigningKeyPem: 'x',
      onDemote: () => undefined, onPromote: () => undefined, teamJoinBlocked,
    } as never));
    return app;
  };
  it('refuses with a plain reason before reading anything', async () => {
    const r = await request(appWith(() => true)).post('/api/pair').send({ pairingCode: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('team-needs-one-machine');
    expect(r.body.detail).toMatch(/second machine/);
  });

  it('carries on as before otherwise', async () => {
    const r = await request(appWith(() => false)).post('/api/pair').send({});
    expect(r.status).toBe(400);
  });
});
