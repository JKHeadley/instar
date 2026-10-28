// @ts-nocheck — production boot path exercised over real HTTP.
/**
 * Tier-3 "feature is alive" test for the held-reply outcome lookup
 * (Echo Bugs topic 10000000967): the production server boots the origin
 * runtime and `GET /telegram/origins/operations/:id/outcome` answers from
 * it — a 404 `unknown` for an id this machine never saw (never a 503), 401
 * without ordinary API auth, and `delivered` when only the fallback record
 * holds Telegram's receipt.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { compileOriginWorker, compileOriginConfigWorker } from '../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); }, 30_000);

describe('held-reply outcome lookup lifecycle', () => {
  it('is alive on the production boot path and answers from the store and the fallback record', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-held-outcome-')), stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    cleanup.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'origin-held-outcome-e2e' }));
    const telegramConfig = { token: '123:held-outcome-fixture', chatId: '-100123' };
    const config = { projectName: 'held-outcome-fixture', projectDir: root, stateDir, port: 0, authToken: 'held-outcome-auth', dashboardPin: '654321',
      messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const boot = await bootTelegramOrigin({ config, token: telegramConfig.token, workerUrl: await compileOriginWorker(), configWorkerUrl: await compileOriginConfigWorker(),
      noticeOwner: true, holdsLease: () => true, isSessionLive: () => false, attachSessionLifecycle: () => undefined,
      diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
    cleanup.push(() => boot.close());
    const telegram = new TelegramAdapter(telegramConfig, stateDir, { suppressLifelineAutoCreate: true }); cleanup.push(() => telegram.stop());
    const server = new AgentServer({ config, state: new StateManager(stateDir), sessionManager: createMockSessionManager(), telegram, telegramOrigin: boot.runtime });
    cleanup.push(() => server.stop());
    const http = server.getApp().listen(0, '127.0.0.1'); cleanup.push(() => new Promise(resolve => http.close(resolve)));
    await new Promise(resolve => http.listening ? resolve() : http.once('listening', resolve));
    const base = `http://127.0.0.1:${http.address().port}`;
    const auth = { Authorization: 'Bearer held-outcome-auth', 'X-Instar-AgentId': 'held-outcome-fixture' };

    // Alive: an id this machine never saw answers 404 unknown, never 503.
    const unknown = await fetch(`${base}/telegram/origins/operations/00000000-0000-4000-8000-000000000000/outcome`, { headers: auth });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ outcome: 'unknown', safeToResend: false, source: 'none' });

    // Ordinary API auth is required; the route never leaks without it.
    expect((await fetch(`${base}/telegram/origins/operations/00000000-0000-4000-8000-000000000000/outcome`)).status).toBe(401);
    expect((await fetch(`${base}/telegram/origins/operations/not%20an%20id/outcome`, { headers: auth })).status).toBe(400);

    // Only the fallback record holds Telegram's receipt (the store write failed): delivered, do not resend.
    const operationId = 'f659abab-6f46-4aae-abda-520623faccd9';
    boot.runtime.unrecordedReceipts.append({ operationId, originId: 'o-1', childId: 'c-1', attemptId: 'a-1',
      receiptJson: JSON.stringify({ messageId: '8812' }), messageId: '8812', chatId: '-100123', topicId: '42', at: Date.now() });
    const delivered = await fetch(`${base}/telegram/origins/operations/${operationId}/outcome`, { headers: auth });
    expect(delivered.status).toBe(200);
    const body = await delivered.json();
    expect(body).toMatchObject({ operationId, outcome: 'delivered', safeToResend: false, source: 'unrecorded-receipt', messageIds: ['8812'] });
    expect(JSON.stringify(body)).not.toContain('Original answer');
  }, 60_000);
});
