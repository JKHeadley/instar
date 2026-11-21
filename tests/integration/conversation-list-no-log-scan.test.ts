/**
 * GET /mobile/conversations over the real HTTP pipeline with a REAL TelegramAdapter
 * holding history for many closed topics (docs/specs/main-loop-freeze-conversation-list.md,
 * fb-52447f16-7d3). The 2026-11-21 Echo Studio freezes were this request reading the whole
 * Telegram log once per topic on the main thread. The bar: the request reads the log zero
 * times synchronously, and the previews arrive once the background index is built.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { buildTelegramListRows } from '../../src/server/telegramListRows.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const N = 120;
const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(async () => {
  ProcessIntegrity.reset();
  for (const c of cleanups) await c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/conversation-list-no-log-scan.test.ts' });
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clist-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test machine' });
  const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } }, sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' } };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const signer = loadMachineSigner(dir)!;
  const keyLookup = identityKeyLookup(dir);
  const keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  pairing.keyLedger = keyLedger;
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger, dispatch: () => async () => 'delivered',
  });

  // A previous server life logged history for N topics; their sessions are closed now.
  const tgDir = path.join(dir, 'tg');
  fs.mkdirSync(tgDir);
  const writer = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, tgDir);
  let id = 1;
  for (let t = 1; t <= N; t++) {
    for (let k = 0; k < 5; k++, id++) writer.logInboundMessage({ messageId: id, topicId: 5000 + t, text: `msg ${k} in ${t}`, timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString() });
  }
  await writer.stop();
  const telegram = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, tgDir);
  cleanups.push(() => telegram.stop());
  for (let t = 1; t <= N; t++) { telegram.registerTopicSession(5000 + t, `s-${t}`, `Planning notes ${t}`); telegram.unregisterTopic(5000 + t); }

  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createMobileConversationRouter({
    config: config as never, pairing, service: svc, machineId: () => 'm1',
    // The production producer (AgentServer.conversationFlatDeps.telegramTopics).
    telegramTopics: () => buildTelegramListRows({
      mappings: () => telegram.getAllTopicMappings(),
      lastEntries: (ids) => telegram.getTopicLastEntries(ids),
      displayName: (_id, name) => name,
      previewText: (t) => t,
    }),
  }));
  return { app, telegram, logPath: path.join(tgDir, 'telegram-messages.jsonl') };
}

describe('GET /mobile/conversations with many closed Telegram topics', () => {
  it('never reads the Telegram log synchronously, and shows previews once the index is built', async () => {
    const e = await setup();
    expect(fs.existsSync(e.logPath)).toBe(true);
    const spy = vi.spyOn(fs, 'readFileSync');
    const logReads = () => spy.mock.calls.filter((c) => String(c[0]) === e.logPath).length;
    try {
      const first = await request(e.app).get('/mobile/conversations?limit=200').set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
      expect(first.status).toBe(200);
      const tgRows = first.body.conversations.filter((c: { platform: string }) => c.platform === 'telegram');
      expect(tgRows).toHaveLength(N);
      expect(logReads()).toBe(0);

      await e.telegram.buildLastEntryIndex();
      const second = await request(e.app).get('/mobile/conversations?limit=200').set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
      expect(second.status).toBe(200);
      const row = second.body.conversations.find((c: { id: unknown; platform: string }) => c.platform === 'telegram' && c.id === 5001);
      expect(row?.lastPreview).toBe('msg 4 in 1');
      expect(logReads()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
