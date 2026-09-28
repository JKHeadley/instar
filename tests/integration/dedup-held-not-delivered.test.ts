/**
 * dedup-held-not-delivered — full HTTP send path (/telegram/reply) through the
 * real origin boot and routes.
 *
 * 2026-09-27 (Mac Studio, topic 102965): a reply held with 409
 * `destination-not-authorized` (or `transport-acceptance-unknown`) left its
 * content reservation live, so the resend of the identical text answered
 * "NOT SENT — suppressed duplicate … already delivered" for a message the user
 * never received. Only a platform-accepted send may suppress an identical one.
 * Only the Telegram wire is injected; the lease is a toggle.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { createRoutes } from '../../src/server/routes.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { originLeaseDependencyFixture } from '../helpers/originLeaseDependency.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { waitForOriginDisplayReady } from '../helpers/telegramOriginReady.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.unstubAllGlobals();
  }
}, 30_000);

const TEXT = 'Here is the full answer to your question about the release, with the verification results.';

async function replyApp() {
  const lease = await originLeaseDependencyFixture();
  cleanup.push(lease.close);
  const gate = { holds: true };
  const telegramConfig = { token: '123:dedup-held-fixture', chatId: '-100123', messageOrigin: { display: { enabled: false } } };
  const config = { projectDir: lease.root, stateDir: lease.stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
    messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
  await writeFile(path.join(lease.stateDir, 'config.json'), JSON.stringify(config));
  let lifecycle: OriginSessionLifecycle | undefined;
  const boot = await bootTelegramOrigin({ config: config as never, token: telegramConfig.token, workerUrl: worker,
    noticeOwner: true, holdsLease: () => gate.holds, isSessionLive: () => true,
    attachSessionLifecycle: value => { lifecycle = value; }, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
  cleanup.push(() => boot.close());
  const token = await lifecycle!.issue({ sessionId: 'session', harnessId: 'codex-cli', projectDir: lease.root, configuredModel: 'fixture-model' });
  const telegram = new TelegramAdapter(telegramConfig, lease.stateDir, { suppressLifelineAutoCreate: true });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer fixture-auth') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ config, telegramOrigin: boot.runtime, telegram, sessionManager: { clearInjectionTracker: () => undefined } } as never));
  await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: '42' });
  let messageId = 10;
  const wire = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: messageId++, chat: { id: -100123 }, message_thread_id: 42 } })));
  vi.stubGlobal('fetch', wire);
  const reply = () => request(app).post('/telegram/reply/42').set('Authorization', 'Bearer fixture-auth')
    .set('X-Instar-Origin-Session', token).send({ text: TEXT });
  return { gate, wire, reply };
}

describe('a held Telegram reply does not count as already delivered', () => {
  it('held (destination-not-authorized), then the identical resend goes out; a genuine repeat is still suppressed', async () => {
    const { gate, wire, reply } = await replyApp();
    gate.holds = false;
    const held = await reply();
    expect(held.status, JSON.stringify(held.body)).toBe(409);
    expect(held.body).toMatchObject({ error: 'telegram-origin-held', reason: 'destination-not-authorized' });
    expect(wire).not.toHaveBeenCalled();

    gate.holds = true;
    const resend = await reply();
    expect(resend.status, JSON.stringify(resend.body)).toBe(200);
    expect(resend.body.suppressedDuplicate).toBeUndefined();
    expect(wire).toHaveBeenCalledOnce();

    const repeat = await reply();
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ suppressedDuplicate: true });
    expect(wire).toHaveBeenCalledOnce();
  }, 60_000);

  it('outcome-unknown transport failure, then the identical resend goes out', async () => {
    const { wire, reply } = await replyApp();
    wire.mockRejectedValueOnce(new Error('socket hang up'));
    const unknown = await reply();
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(409);
    expect(unknown.body).toMatchObject({ reason: 'transport-acceptance-unknown', outcome: 'outcome-unknown' });

    const resend = await reply();
    expect(resend.status, JSON.stringify(resend.body)).toBe(200);
    expect(resend.body.suppressedDuplicate).toBeUndefined();
    expect(wire).toHaveBeenCalledTimes(2);
  }, 60_000);
});
