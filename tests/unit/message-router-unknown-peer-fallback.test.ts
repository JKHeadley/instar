/**
 * Unit tests — cross-machine /messages/send to a machine THIS registry does not
 * know (messages-send-unknown-peer-fallback).
 *
 * Three real MessageRouters (origin O, peer P, target T) with real Ed25519 keys
 * and real MessageStores. `fetch` is routed to the receiving router's relay()
 * exactly as POST /api/messages/relay-machine does (Machine-HMAC is the route's
 * concern and is covered by the integration tier).
 *
 * Registries model the live 2026-11-20 split: O knows {O,P}; P knows {O,P,T};
 * T knows {P,T} only (it never paired with O).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageRouter, canonicalJSON } from '../../src/messaging/MessageRouter.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { generateSigningKeyPair, sign } from '../../src/core/MachineIdentity.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const O = 'm_origin_0000000001';
const P = 'm_peer_00000000002';
const T = 'm_target_000000003';
const R = 'm_revoked_00000004';
const URLS: Record<string, string> = {
  [O]: 'http://origin.test:4042',
  [P]: 'http://peer.test:4042/',
  [T]: 'http://target.test:4042',
};

type Keys = { publicKey: string; privateKey: string };

function identity(self: string, known: Record<string, { status: 'active' | 'revoked' }>, keys: Record<string, Keys>) {
  return {
    isMachineActive: vi.fn((id: string) => known[id]?.status === 'active'),
    getMachineUrl: vi.fn((id: string) => (known[id] ? URLS[id] ?? null : null)),
    getSigningPublicKeyPem: vi.fn((id: string) => (known[id] ? keys[id]?.publicKey ?? null : null)),
    getActiveMachines: vi.fn(() =>
      Object.entries(known)
        .filter(([, e]) => e.status === 'active')
        .map(([machineId, entry]) => ({ machineId, entry })),
    ),
    loadRegistry: vi.fn(() => ({
      version: 1,
      machines: Object.fromEntries(
        Object.entries(known).map(([id, e]) => [id, { status: e.status, ...(e.status === 'revoked' ? { revokedAt: '2026-11-20T10:10:08.283Z' } : {}) }]),
      ),
    })),
    loadIdentity: vi.fn(() => ({ machineId: self })),
  } as any;
}

describe('MessageRouter — unknown-peer pool fallback', () => {
  const dirs: string[] = [];
  const stores: MessageStore[] = [];
  const routers: Record<string, MessageRouter> = {};
  const tmux: Record<string, { sendKeys: ReturnType<typeof vi.fn> }> = {};
  let keys: Record<string, Keys>;
  let fetchCalls: string[];
  let reportSpy: ReturnType<typeof vi.spyOn>;
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
    tmux[self] = ops;
    routers[self] = new MessageRouter(
      store,
      new MessageDelivery(new MessageFormatter(), ops as any),
      {
        localAgent: 'echo',
        localMachine: self,
        serverUrl: URLS[self] ?? 'http://x',
        isOwnSession: (s: string) => s === 'echo-topic-144319',
      },
      {
        identityManager: identity(self, known, keys),
        signingKeyPem: keys[self].privateKey,
        nonceStore: { validate: vi.fn().mockReturnValue({ valid: true }) } as any,
        securityLog: { append: vi.fn() } as any,
      },
    );
    return store;
  }

  let storeO: MessageStore;
  let storeP: MessageStore;
  let storeT: MessageStore;

  beforeEach(async () => {
    keys = { [O]: generateSigningKeyPair(), [P]: generateSigningKeyPair(), [T]: generateSigningKeyPair(), [R]: generateSigningKeyPair() };
    storeO = await makeRouter(O, { [O]: { status: 'active' }, [P]: { status: 'active' }, [R]: { status: 'revoked' } });
    storeP = await makeRouter(P, { [O]: { status: 'active' }, [P]: { status: 'active' }, [T]: { status: 'active' } });
    storeT = await makeRouter(T, { [P]: { status: 'active' }, [T]: { status: 'active' } });
    fetchCalls = [];
    // Route fetch to the receiving router exactly as the relay-machine route does.
    global.fetch = vi.fn(async (url: string, init: any) => {
      fetchCalls.push(String(url));
      const m = /^http:\/\/(origin|peer|target)\.test:4042\/api\/messages\/relay-machine$/.exec(String(url));
      if (!m) return { ok: false, status: 404 } as any;
      const id = m[1] === 'origin' ? O : m[1] === 'peer' ? P : T;
      const accepted = await routers[id].relay(JSON.parse(init.body), 'machine');
      return { ok: accepted, status: accepted ? 200 : 409 } as any;
    }) as any;
    reportSpy = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    reportSpy.mockRestore();
    for (const s of stores.splice(0)) await s.destroy();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/message-router-unknown-peer-fallback.test.ts' });
  });

  it('relays to the mounted /api/messages/relay-machine route (the old path matched no route)', async () => {
    const r = await routers[O].send({ agent: 'echo', session: 's', machine: O }, { agent: 'echo', session: 'best', machine: P }, 'info', 'medium', 'hi', 'body');
    expect(fetchCalls).toEqual(['http://peer.test:4042/api/messages/relay-machine']);
    expect(r.phase).toBe('received');
    expect(r.delivered).toBe(true);
  });

  it('carries a message for a machine unknown here through a peer that knows it', async () => {
    const r = await routers[O].send(
      { agent: 'echo', session: 's', machine: O },
      { agent: 'echo', session: 'echo-topic-144319', machine: T },
      'info', 'medium', 'join code', 'run instar join',
    );
    expect(r.phase).toBe('received');
    expect(r.delivered).toBe(true);
    expect(r.via).toBe(P);
    expect(fetchCalls).toEqual([
      'http://peer.test:4042/api/messages/relay-machine',
      'http://target.test:4042/api/messages/relay-machine',
    ]);
    // The forwarder never keeps a foreign-addressed copy as its own.
    expect(await storeP.exists(r.messageId)).toBe(false);
    // The target verified the forwarder's signature and holds the message.
    const atTarget = await storeT.get(r.messageId);
    expect(atTarget).not.toBeNull();
    expect(atTarget!.transport.relayChain).toEqual([O, P]);
    expect(atTarget!.transport.signedBy).toBe(P);
    expect(atTarget!.message.from.machine).toBe(O);
    // A named session of the target's own agent is typed into, like a local send.
    expect(tmux[T].sendKeys).toHaveBeenCalled();
    expect(atTarget!.delivery.phase).toBe('delivered');
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('refuses to send to a revoked machine, with no fallback and a plain notice', async () => {
    const r = await routers[O].send({ agent: 'echo', session: 's', machine: O }, { agent: 'echo', session: 'x', machine: R }, 'info', 'medium', 'hi', 'body');
    expect(r.phase).toBe('failed');
    expect(r.delivered).toBe(false);
    expect(r.failureReason).toMatch(/revoked/);
    expect(r.notice).toMatch(/removed from this agent's machines/);
    expect(fetchCalls).toEqual([]);
    expect(reportSpy).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when no peer can carry it, and reports once per target per window', async () => {
    const unknown = 'm_nobody_knows_me_5';
    const send = () => routers[O].send({ agent: 'echo', session: 's', machine: O }, { agent: 'echo', session: 'x', machine: unknown }, 'info', 'medium', 'hi', 'body');
    const r1 = await send();
    const r2 = await send();
    for (const r of [r1, r2]) {
      expect(r.phase).toBe('failed');
      expect(r.delivered).toBe(false);
      expect(r.failureReason).toMatch(/not known to this machine/);
      expect(r.notice).toMatch(/not delivered/);
    }
    // P was asked and refused (it does not know the target either).
    expect(fetchCalls.every((u) => u === 'http://peer.test:4042/api/messages/relay-machine')).toBe(true);
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect((await storeO.get(r1.messageId))!.delivery.phase).toBe('failed');
  });

  function signedBy(signer: string, chain: string[], toMachine: string, id: string) {
    const now = new Date().toISOString();
    const env: any = {
      schemaVersion: 1,
      message: { id, from: { agent: 'echo', session: 's', machine: O }, to: { agent: 'echo', session: 'echo-topic-144319', machine: toMachine }, type: 'info', priority: 'medium', subject: 'x', body: 'y', createdAt: now, ttlMinutes: 30 },
      transport: { relayChain: chain, originServer: URLS[O], nonce: `n-${id}:${now}`, timestamp: now },
      delivery: { phase: 'sent', transitions: [{ from: 'created', to: 'sent', at: now }], attempts: 0 },
    };
    const payload = { message: env.message, relayChain: env.transport.relayChain, originServer: env.transport.originServer, nonce: env.transport.nonce, timestamp: env.transport.timestamp };
    env.transport.signature = sign(canonicalJSON(payload), keys[signer].privateKey);
    env.transport.signedBy = signer;
    return env;
  }

  it('a forwarder carries at most one hop', async () => {
    // Validly signed by O, but O is already the SECOND hop (chain [X, O]).
    const env = signedBy(O, ['m_upstream_x', O], T, 'two-hop');
    expect(await routers[P].relay(env, 'machine')).toBe(false);
    expect(fetchCalls).toEqual([]);
    expect(await storeP.exists('two-hop')).toBe(false);
  });

  it('a forwarder refuses an envelope whose chain does not start with its signer', async () => {
    const env = signedBy(O, ['m_someone_else'], T, 'chain-mismatch');
    expect(await routers[P].relay(env, 'machine')).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  it('a forwarder refuses a target it does not know either', async () => {
    const env = signedBy(O, [O], 'm_unknown_to_peer', 'unknown-to-peer');
    expect(await routers[P].relay(env, 'machine')).toBe(false);
    expect(fetchCalls).toEqual([]);
    expect(await storeP.exists('unknown-to-peer')).toBe(false);
  });

  it('a validly signed one-hop envelope is carried by the forwarder', async () => {
    const env = signedBy(O, [O], T, 'one-hop');
    expect(await routers[P].relay(env, 'machine')).toBe(true);
    expect(fetchCalls).toEqual(['http://target.test:4042/api/messages/relay-machine']);
    expect((await storeT.get('one-hop'))!.transport.relayChain).toEqual([O, P]);
  });
});
