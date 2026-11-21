/**
 * Unit tests — cross-machine /messages/send outcome honesty
 * (messages-send-cross-machine-honest).
 *
 * Two real MessageRouters (origin O, peer P) with real Ed25519 keys and real
 * MessageStores. `fetch` is routed to the receiving router's relay() only when
 * the URL is the route the receiver really mounts (POST /api/messages/relay-machine);
 * anything else answers 404, exactly like the live server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { signRelayAnswer } from '../../src/server/machineAuth.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';

const O = 'm_origin_0000000001';
const P = 'm_peer_00000000002';
const R = 'm_revoked_00000004';
const URLS: Record<string, string> = {
  [O]: 'http://origin.test:4042',
  [P]: 'http://peer.test:4042/', // trailing slash on purpose
};

type Keys = { publicKey: string; privateKey: string };

function identity(self: string, known: Record<string, { status: 'active' | 'revoked' }>, keys: Record<string, Keys>) {
  return {
    isMachineActive: vi.fn((id: string) => known[id]?.status === 'active'),
    getMachineUrl: vi.fn((id: string) => (known[id] ? URLS[id] ?? null : null)),
    getSigningPublicKeyPem: vi.fn((id: string) => (known[id] ? keys[id]?.publicKey ?? null : null)),
    loadRegistry: vi.fn(() => ({
      version: 1,
      machines: Object.fromEntries(
        Object.entries(known).map(([id, e]) => [id, { status: e.status, ...(e.status === 'revoked' ? { revokedAt: '2026-11-20T10:10:08.283Z' } : {}) }]),
      ),
    })),
    loadIdentity: vi.fn(() => ({ machineId: self })),
  } as any;
}

describe('MessageRouter — cross-machine outcome honesty', () => {
  const dirs: string[] = [];
  const stores: MessageStore[] = [];
  const routers: Record<string, MessageRouter> = {};
  let keys: Record<string, Keys>;
  let fetchCalls: string[];
  let reportSpy: ReturnType<typeof vi.spyOn>;
  let storeO: MessageStore;
  let storeP: MessageStore;
  const originalFetch = global.fetch;

  async function makeRouter(self: string, known: Record<string, { status: 'active' | 'revoked' }>): Promise<MessageStore> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `instar-e2-${self}-`));
    dirs.push(dir);
    const store = new MessageStore(dir);
    await store.initialize();
    stores.push(store);
    const ops = {
      getForegroundProcess: vi.fn().mockReturnValue('bash'),
      isSessionAlive: vi.fn().mockReturnValue(true),
      hasActiveHumanInput: vi.fn().mockReturnValue(false),
      sendKeys: vi.fn().mockReturnValue(true),
      getOutputLineCount: vi.fn().mockReturnValue(100),
    };
    routers[self] = new MessageRouter(
      store,
      new MessageDelivery(new MessageFormatter(), ops as any),
      { localAgent: 'echo', localMachine: self, serverUrl: URLS[self] ?? 'http://x', peerAddresses: (m: string) => (URLS[m] ? [URLS[m]] : []) },
      {
        identityManager: identity(self, known, keys),
        signingKeyPem: keys[self].privateKey,
        nonceStore: { validate: vi.fn().mockReturnValue({ valid: true }) } as any,
        securityLog: { append: vi.fn() } as any,
      },
    );
    return store;
  }

  beforeEach(async () => {
    keys = { [O]: generateSigningKeyPair(), [P]: generateSigningKeyPair(), [R]: generateSigningKeyPair() };
    fetchCalls = [];
    // Installed BEFORE the routers exist: the relay queue (§D.5) binds `fetch` when it is built.
    // Answers like the real route: a signed ack (200) or a signed nack (409) from the receiver.
    global.fetch = vi.fn(async (url: string, init: any) => {
      fetchCalls.push(String(url));
      const m = /^http:\/\/(origin|peer)\.test:4042\/api\/messages\/relay-machine$/.exec(String(url));
      if (!m) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      const target = m[1] === 'origin' ? O : P;
      const env = JSON.parse(init.body) as MessageEnvelope;
      const r = await routers[target].relayFromMachine(env, init.headers['X-Machine-Id']);
      const answer = { machineId: target, messageId: env.message.id, reqNonce: init.headers['X-Nonce'], ...(r.outcome === 'refused' ? { code: r.code } : {}) };
      const sig = signRelayAnswer(answer, keys[target].privateKey);
      if (r.outcome === 'refused') return new Response(JSON.stringify({ nack: answer, sig, code: r.code }), { status: 409 });
      return new Response(JSON.stringify({ ok: true, ack: answer, sig }), { status: 200 });
    }) as any;
    storeO = await makeRouter(O, { [O]: { status: 'active' }, [P]: { status: 'active' }, [R]: { status: 'revoked' } });
    storeP = await makeRouter(P, { [O]: { status: 'active' }, [P]: { status: 'active' } });
    await routers[O].startRelayQueue();
    await routers[P].startRelayQueue();
    reportSpy = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    reportSpy.mockRestore();
    for (const s of stores.splice(0)) await s.destroy();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/message-router-cross-machine-honest.test.ts' });
  });

  const sendTo = (machine: string) =>
    routers[O].send({ agent: 'echo', session: 's', machine: O }, { agent: 'echo', session: 'echo-topic-1', machine }, 'info', 'medium', 'hi', 'body');

  const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await f()) return; await new Promise((res) => setTimeout(res, 10)); } };

  it('relays to the mounted /api/messages/relay-machine route, so a paired peer receives it', async () => {
    const r = await sendTo(P);
    // §D.5: a same-agent session message is queued for one pass and answered `relaying`;
    // the signed ack from the peer then settles it as `received`.
    expect(r.phase).toBe('relaying');
    expect(r.failureReason).toBeUndefined();
    await until(async () => (await storeO.get(r.messageId))?.delivery.phase === 'received');
    expect(fetchCalls).toEqual(['http://peer.test:4042/api/messages/relay-machine']);
    expect((await storeO.get(r.messageId))!.delivery.phase).toBe('received');
    expect(await storeP.exists(r.messageId)).toBe(true);
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('refuses a revoked machine with its own reason and a plain notice, contacting nobody', async () => {
    const r = await sendTo(R);
    expect(r.phase).toBe('failed');
    expect(r.delivered).toBe(false);
    expect(r.failureReason).toMatch(/revoked/);
    expect(r.notice).toMatch(/removed from this agent's machines/);
    expect(fetchCalls).toEqual([]);
    expect(reportSpy).toHaveBeenCalledTimes(1);
  });

  it('fails an unknown machine loudly, and reports once per target per window', async () => {
    const r1 = await sendTo('m_nobody_knows_me_5');
    const r2 = await sendTo('m_nobody_knows_me_5');
    for (const r of [r1, r2]) {
      expect(r.phase).toBe('failed');
      expect(r.delivered).toBe(false);
      expect(r.failureReason).toMatch(/not known to this machine/);
      expect(r.notice).toMatch(/paired with this machine again/);
    }
    expect(fetchCalls).toEqual([]);
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect((await storeO.get(r1.messageId))!.delivery.phase).toBe('failed');
    // A different target gets its own report.
    await sendTo('m_another_unknown_6');
    expect(reportSpy).toHaveBeenCalledTimes(2);
  });

  it('same-machine sends carry no cross-machine outcome fields', async () => {
    const r = await routers[O].send({ agent: 'echo', session: 's', machine: O }, { agent: 'echo', session: 'best', machine: 'local' }, 'info', 'medium', 'hi', 'body');
    expect(r.delivered).toBeUndefined();
    expect(r.notice).toBeUndefined();
  });
});
