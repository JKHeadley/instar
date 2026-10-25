import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { TelegramOriginHoldError } from '../../src/messaging/telegram-origin/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-rejection-http-'));
  cleanup.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test:dashboard-rejection-http:cleanup' }));
  const stateDir = path.join(root, '.instar'); fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const savedPath = path.join(stateDir, 'state', 'dashboard-message.json');
  const saved = JSON.stringify({ messageId: 88, savedAt: '2026-09-10T00:00:00.000Z' }); fs.writeFileSync(savedPath, saved);
  const telegram = new TelegramAdapter({ token: '123:dashboard-http-fixture', chatId: '-100123', dashboardTopicId: 5, dashboardPin: '123456' }, stateDir);
  cleanup.push(() => telegram.stop());
  const config = { projectName: 'dashboard-http-fixture', projectDir: root, stateDir, port: 0, authToken: 'fixture-auth',
    sessions: {}, tunnel: { enabled: true, type: 'quick' } };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer fixture-auth') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ config, telegram, tunnel: { url: 'https://fixture.example.test' }, sessionManager: {} } as never));
  return { app, telegram, savedPath, saved };
}

describe('dashboard refresh HTTP edit rejection', () => {
  it.each(['held', 'outcome-unknown'] as const)('returns the existing failure response for %s without creating another send', async outcome => {
    const f = fixture();
    const held = new TelegramOriginHoldError('credential-capacity-unavailable', 'original-operation', outcome);
    const wire = vi.fn().mockRejectedValue(held); vi.stubGlobal('fetch', wire);
    const send = vi.spyOn(f.telegram, 'sendToTopic');
    const response = await request(f.app).post('/telegram/dashboard-refresh').set('Authorization', 'Bearer fixture-auth').send({});
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).toContain('credential-capacity-unavailable');
    expect(send).not.toHaveBeenCalled(); expect(wire).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.savedPath, 'utf8')).toBe(f.saved);
  });

  it('refreshes through the real route after Telegram proves the pinned message missing', async () => {
    const f = fixture(), methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const method = new URL(url).pathname.split('/').pop()!; methods.push(method);
      if (method === 'editMessageText') return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: -100123 }, message_thread_id: 5 } }));
    }));
    const response = await request(f.app).post('/telegram/dashboard-refresh').set('Authorization', 'Bearer fixture-auth').send({});
    expect(response.status).toBe(200); expect(response.body.action).toBe('refreshed');
    expect(methods).toEqual(['editMessageText', 'sendMessage', 'unpinAllForumTopicMessages', 'pinChatMessage']);
    expect(JSON.parse(fs.readFileSync(f.savedPath, 'utf8')).messageId).toBe(99);
  });
});
