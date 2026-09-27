/**
 * lease-renew-unreachable-peers — full HTTP send path (/telegram/reply) on the
 * preferred captain while peers are unreachable.
 *
 * 2026-09-27 (Mac Studio): a permanently-unreachable peer made every renewal
 * broadcast wait out a 30s rope timeout, overrunning the 20s tick await; the
 * lease lapsed and replies were refused `destination-not-authorized` for ~30min.
 * Real TelegramOriginBoot + routes + MultiMachineCoordinator renew timer +
 * LeaseCoordinator + HttpLeaseTransport; only the peer fetch and the Telegram
 * wire are injected. Both sides of the fence are proven.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}, 30_000);

/** A dead peer never answers (every rope black-holed); a live one confirms (legacy 2xx). */
const peerFetch = (async (url: string, opts: { signal?: AbortSignal }) => {
  if (url.startsWith('http://live-peer')) return { ok: true, json: async () => ({}) };
  return new Promise((_resolve, reject) => {
    opts.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout')));
  });
}) as unknown as typeof fetch;

const DEAD = { machineId: 'mac-mini', url: 'http://dead-peer' };
const DEAD2 = { machineId: 'laptop', url: 'http://dead-peer-2' };
const LIVE = { machineId: 'standby', url: 'http://live-peer' };

async function sendAfter70s(opts: Parameters<typeof originLeaseDependencyFixture>[0]) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const clock = { value: Date.now() };
  const lease = await originLeaseDependencyFixture({ ...opts, clock, fetchImpl: peerFetch, broadcastDeadlineMs: 100 });
  cleanup.push(lease.close);
  const telegramConfig = { token: '123:lease-unreachable-fixture', chatId: '-100123', messageOrigin: { display: { enabled: false } } };
  const config = { projectDir: lease.root, stateDir: lease.stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
    messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
  await writeFile(path.join(lease.stateDir, 'config.json'), JSON.stringify(config));
  let lifecycle: OriginSessionLifecycle | undefined;
  const boot = await bootTelegramOrigin({ config: config as never, token: telegramConfig.token, workerUrl: worker,
    noticeOwner: true, holdsLease: () => lease.coordinator.holdsLease(), isSessionLive: () => true,
    attachSessionLifecycle: value => { lifecycle = value; }, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
  cleanup.push(() => boot.close());
  const token = await lifecycle!.issue({ sessionId: 'session', harnessId: 'codex-cli', projectDir: lease.root, configuredModel: 'fixture-model' });
  const telegram = new TelegramAdapter(telegramConfig, lease.stateDir, { suppressLifelineAutoCreate: true });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer fixture-auth') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ config, telegramOrigin: boot.runtime, telegram, sessionManager: { clearInjectionTracker: () => undefined } } as never));
  await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: '42' });
  const wire = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: -100123 }, message_thread_id: 42 } })));
  vi.stubGlobal('fetch', wire);
  const epoch = lease.lc.currentEpoch();
  for (const step of [30_000, 30_000, 10_000]) {
    clock.value += step;
    await vi.advanceTimersByTimeAsync(step);
    // The renew tick's broadcast waits on REAL timers (its deadline); let it settle.
    await delay(400);
  }
  const response = await request(app).post('/telegram/reply/42').set('Authorization', 'Bearer fixture-auth')
    .set('X-Instar-Origin-Session', token).send({ text: 'Still here while the other machines are away.' });
  return { lease, response, wire, epoch };
}

describe('sends stay authorized on the preferred captain while peers are unreachable', () => {
  it('one dead peer + one live peer: the live confirmation renews the lease and the send goes out', async () => {
    const { lease, response, wire, epoch } = await sendAfter70s({ peers: [DEAD, LIVE] });
    expect(lease.coordinator.holdsLease()).toBe(true);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(wire).toHaveBeenCalledOnce();
    expect(lease.lc.currentEpoch()).toBe(epoch);
  }, 60_000);

  it('every peer unreachable and presumed gone: the preferred captain holds and the send goes out', async () => {
    const { lease, response, wire, epoch } = await sendAfter70s({ peers: [DEAD, DEAD2], soloCaptain: { allPeersPresumedGone: true } });
    expect(lease.coordinator.holdsLease()).toBe(true);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(wire).toHaveBeenCalledOnce();
    expect(lease.lc.currentEpoch()).toBe(epoch); // the hold never advances the epoch
  }, 60_000);

  it('every peer unreachable but recently alive: the split-brain fence still lapses the lease and the send is held', async () => {
    const { lease, response, wire } = await sendAfter70s({ peers: [DEAD, DEAD2], soloCaptain: { allPeersPresumedGone: false } });
    expect(lease.coordinator.holdsLease()).toBe(false);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(wire).not.toHaveBeenCalled();
  }, 60_000);
});
