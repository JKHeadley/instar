/**
 * messages-reach-renamed-sessions §D (PR-B): cross-machine session messages.
 * Real Ed25519 keys; two in-process MessageRouters; the queue's fetch calls the
 * receiver's relayFromMachine and answers with a real signed ack/nack.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MessageRouter, signedPayloadOf, canonicalJSON } from '../../src/messaging/MessageRouter.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { CrossMachineRelayQueue } from '../../src/messaging/CrossMachineRelayQueue.js';
import { signRelayAnswer, verifyRelayAnswer } from '../../src/server/machineAuth.js';
import { resolveSessionTarget } from '../../src/messaging/sessionAddressResolver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';

function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
const A = 'm_a', B = 'm_b';
const K = { [A]: keys(), [B]: keys() };
const idm = (active: string[]) => ({
  isMachineActive: (id: string) => active.includes(id),
  getMachineUrl: () => null,
  getSigningPublicKeyPem: (id: string) => K[id]?.publicPem ?? null,
}) as any;
const sec = () => ({ events: [] as any[], append(e: any) { this.events.push(e); } }) as any;
const tmux = (running: Set<string>, typed: Array<{ s: string; t: string }>) => ({
  getForegroundProcess: () => 'bash',
  isSessionAlive: (s: string) => running.has(s),
  hasActiveHumanInput: () => false,
  sendKeys: (s: string, t: string) => { typed.push({ s, t }); return true; },
  getOutputLineCount: () => 100,
});

describe('cross-machine relay (PR-B)', () => {
  let dirA: string, dirB: string;
  let storeA: MessageStore, storeB: MessageStore;
  let routerA: MessageRouter, routerB: MessageRouter;
  const typedB: Array<{ s: string; t: string }> = [];
  const failuresA: string[] = [];
  const runningB = new Set(['echo-worker']);

  beforeEach(async () => {
    typedB.length = 0; failuresA.length = 0;
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-b-'));
    vi.spyOn(os, 'homedir').mockReturnValue(dirA);
    storeA = new MessageStore(dirA); await storeA.initialize();
    storeB = new MessageStore(dirB); await storeB.initialize();
    const sessionsB = [{ id: 'w1', name: 'worker', tmuxSession: 'echo-worker', status: 'running', startedAt: '2020-01-01T00:00:00Z' }];
    routerB = new MessageRouter(storeB, new MessageDelivery(new MessageFormatter(), tmux(runningB, typedB) as any), {
      localAgent: 'echo', localMachine: B, serverUrl: 'http://b',
      isOwnSession: (n) => runningB.has(n),
      resolveSession: (t, asOf) => resolveSessionTarget(t, { sessions: sessionsB, sessionNameForTopic: () => null, isStandingDown: () => false, prefix: 'echo', asOf }),
    }, { identityManager: idm([A, B]), signingKeyPem: K[B].privatePem, nonceStore: {} as any, securityLog: sec() });

    // A's fetch delivers to B's relayFromMachine and answers like the real route.
    const fetchToB = async (_url: string, init: any) => {
      const env = JSON.parse(init.body) as MessageEnvelope;
      const reqNonce = init.headers['X-Nonce'];
      const r = await routerB.relayFromMachine(env, init.headers['X-Machine-Id']);
      const ans = (code?: string) => { const a = { machineId: B, messageId: env.message.id, reqNonce, ...(code ? { code } : {}) }; return { a, sig: signRelayAnswer(a, K[B].privatePem) }; };
      if (r.outcome === 'refused') { const { a, sig } = ans(r.code); return new Response(JSON.stringify({ nack: a, sig, code: r.code }), { status: 409 }); }
      const { a, sig } = ans(); return new Response(JSON.stringify({ ok: true, ack: a, sig }), { status: 200 });
    };
    routerA = new MessageRouter(storeA, new MessageDelivery(new MessageFormatter(), tmux(new Set(), []) as any), {
      localAgent: 'echo', localMachine: A, serverUrl: 'http://a',
      onDeliveryFailure: (_e, reason) => failuresA.push(reason),
      peerAddresses: () => ['http://b.test'],
    }, { identityManager: idm([A, B]), signingKeyPem: K[A].privatePem, nonceStore: {} as any, securityLog: sec() });
    (routerA as any).relayQueue = new CrossMachineRelayQueue({
      ...(routerA as any).relayQueue.deps,
      fetchImpl: fetchToB as any,
    });
    await routerA.startRelayQueue();
    // B answers notices back to A over the same signed protocol.
    const fetchToA = async (_url: string, init: any) => {
      const env = JSON.parse(init.body) as MessageEnvelope;
      const reqNonce = init.headers['X-Nonce'];
      const r = await routerA.relayFromMachine(env, init.headers['X-Machine-Id']);
      const a = { machineId: A, messageId: env.message.id, reqNonce, ...(r.outcome === 'refused' ? { code: r.code } : {}) };
      const sig = signRelayAnswer(a, K[A].privatePem);
      return new Response(JSON.stringify(r.outcome === 'refused' ? { nack: a, sig } : { ok: true, ack: a, sig }), { status: r.outcome === 'refused' ? 409 : 200 });
    };
    (routerB as any).config.peerAddresses = () => ['http://a.test'];
    (routerB as any).relayQueue = new CrossMachineRelayQueue({ ...(routerB as any).relayQueue.deps, fetchImpl: fetchToA as any });
    await routerB.startRelayQueue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of [dirA, dirB]) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/messages-cross-machine-relay.test.ts' });
  });

  const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 10)); } };

  it('a session message to another machine is acked (signed), stored there, and typed into the session', async () => {
    const res = await routerA.send({ agent: 'echo', session: 'echo-lead', machine: A }, { agent: 'echo', session: 'echo-worker', machine: B }, 'handoff', 'medium', 'S', 'Body');
    expect(res.phase).toBe('relaying');
    await until(async () => (await storeA.get(res.messageId))?.delivery.phase === 'received');
    expect((await storeA.get(res.messageId))!.delivery.phase).toBe('received');
    await until(async () => typedB.length > 0);
    expect(typedB[0].s).toBe('echo-worker');
    const onB = await storeB.get(res.messageId);
    expect(onB!.delivery.phase).toBe('delivered');
    expect(onB!.delivery.deliveryPending).toBe(false);
  });

  it('a stopped role on the receiver fails there and the origin envelope becomes failed via a signed notice', async () => {
    const res = await routerA.send({ agent: 'echo', session: 'echo-lead', machine: A }, { agent: 'echo', session: 'echo-gone', machine: B }, 'handoff', 'medium', 'S', 'Body');
    await until(async () => (await storeA.get(res.messageId))?.delivery.phase === 'failed');
    const onA = await storeA.get(res.messageId);
    expect(onA!.delivery.phase).toBe('failed');
    expect(onA!.delivery.failureReason).toContain(`refused on ${B}`);
    expect(failuresA.length).toBe(1);
    expect(typedB).toHaveLength(0);
  });

  it('arrival refuses a wrong machine, agent or sender', async () => {
    const mk = (over: any) => {
      const now = new Date().toISOString();
      const env: any = { schemaVersion: 1, message: { id: crypto.randomUUID(), from: { agent: 'echo', session: 's', machine: A }, to: { agent: 'echo', session: 'echo-worker', machine: B }, type: 'info', priority: 'low', subject: 'S', body: 'B', createdAt: now, ttlMinutes: 30, ...over }, transport: { relayChain: [A], originServer: 'x', nonce: 'n', timestamp: now, age: 0 }, delivery: { phase: 'relaying', transitions: [], attempts: 0 } };
      env.transport.signature = crypto.sign(null, Buffer.from(canonicalJSON(signedPayloadOf(env))), K[A].privatePem).toString('base64');
      env.transport.signedBy = A;
      return env as MessageEnvelope;
    };
    expect(await routerB.relayFromMachine(mk({ to: { agent: 'echo', session: 'x', machine: 'm_c' } }), A)).toEqual({ outcome: 'refused', code: 'relay-wrong-machine' });
    expect(await routerB.relayFromMachine(mk({ from: { agent: 'other', session: 's', machine: A } }), A)).toEqual({ outcome: 'refused', code: 'relay-wrong-agent' });
    expect(await routerB.relayFromMachine(mk({}), 'm_c')).toEqual({ outcome: 'refused', code: 'relay-sender-mismatch' });
    const tampered = mk({}); tampered.message.body = 'changed';
    expect(await routerB.relayFromMachine(tampered, A)).toEqual({ outcome: 'refused', code: 'relay-signature-invalid' });
    const ok = mk({});
    expect(await routerB.relayFromMachine(ok, A)).toEqual({ outcome: 'stored' });
    expect(await routerB.relayFromMachine(ok, A)).toEqual({ outcome: 'duplicate' });
  });

  it('freshness: the receiver judges a relayed message by arrival − age − 2×signature window', async () => {
    const res = await routerA.send({ agent: 'echo', session: 'echo-lead', machine: A }, { agent: 'echo', session: 'echo-worker', machine: B }, 'handoff', 'medium', 'S', 'Body');
    await until(async () => typedB.length > 0);
    const onB = await storeB.get(res.messageId);
    const arrived = Date.parse(onB!.delivery.arrivedAt!);
    expect(arrived - onB!.delivery.asOf!).toBeGreaterThanOrEqual(10 * 60_000);
    expect(arrived - onB!.delivery.asOf!).toBeLessThan(10 * 60_000 + 60_000);
  });

  it('signedPayloadOf includes age only when present (older envelopes verify unchanged)', () => {
    const base: any = { message: { id: '1' }, transport: { relayChain: [], originServer: 'o', nonce: 'n', timestamp: 't' } };
    expect('age' in signedPayloadOf(base)).toBe(false);
    expect(signedPayloadOf({ ...base, transport: { ...base.transport, age: 5 } }).age).toBe(5);
  });
});

describe('CrossMachineRelayQueue one pass', () => {
  const env = () => ({ message: { id: 'mid', to: { machine: 'm_t' }, createdAt: new Date().toISOString() }, transport: {} } as any as MessageEnvelope);
  const kp = keys();
  const make = (answers: Array<(nonce: string) => Response | Error>) => {
    let i = 0;
    return new CrossMachineRelayQueue({
      localMachine: 'm_s',
      addressesFor: () => answers.map((_, n) => `http://addr${n}`),
      resignForAttempt: () => {},
      signRequestHeaders: () => ({ 'X-Nonce': `nonce${i}` }),
      peerPublicKey: () => kp.publicPem,
      onOutcome: async () => {},
      fetchImpl: (async () => { const a = answers[i](`nonce${i}`); i++; if (a instanceof Error) throw a; return a; }) as any,
    });
  };
  const signed = (nonce: string, code?: string) => { const a = { machineId: 'm_t', messageId: 'mid', reqNonce: nonce, ...(code ? { code } : {}) }; return { a, sig: signRelayAnswer(a, kp.privatePem) }; };

  it('unsigned 404, 502 and 530 move on; a verified ack ends the pass', async () => {
    const q = make([
      () => new Response('nope', { status: 404 }),
      () => new Response('{}', { status: 502 }),
      () => new Response('{"error":"x"}', { status: 530 }),
      (n) => { const { a, sig } = signed(n); return new Response(JSON.stringify({ ack: a, sig }), { status: 200 }); },
    ]);
    expect(await q.onePass(env())).toMatchObject({ kind: 'received', via: 'http://addr3' });
  });

  it('a verified nack ends the pass with its code; an unverified one moves on', async () => {
    const q = make([
      () => new Response(JSON.stringify({ nack: { machineId: 'm_t', messageId: 'mid', reqNonce: 'nonce0', code: 'relay-loop' }, sig: 'bad' }), { status: 409 }),
      (n) => { const { a, sig } = signed(n, 'relay-wrong-agent'); return new Response(JSON.stringify({ nack: a, sig }), { status: 409 }); },
    ]);
    expect(await q.onePass(env())).toMatchObject({ kind: 'refused', code: 'relay-wrong-agent' });
  });

  it('ack-less 2xx and timeouts are named as readings, never as proof', async () => {
    const t = new Error('timeout'); t.name = 'TimeoutError';
    const q = make([() => new Response('{"ok":true}', { status: 200 }), () => t]);
    const out = await q.onePass(env());
    expect(out.kind).toBe('unreachable');
    if (out.kind === 'unreachable') {
      expect(out.reason.startsWith('unconfirmed: may have arrived')).toBe(true);
      expect(out.reason).toContain('a server stored it without confirming');
    }
  });

  it('no address fails at once', async () => {
    const q = new CrossMachineRelayQueue({ localMachine: 'm_s', addressesFor: () => [], resignForAttempt: () => {}, signRequestHeaders: () => ({}), peerPublicKey: () => null, onOutcome: async () => {} });
    expect(await q.onePass(env())).toMatchObject({ kind: 'unreachable', reason: 'no usable address for m_t' });
  });

  it('verifyRelayAnswer binds machine, message and nonce', () => {
    const { a, sig } = signed('n1');
    expect(verifyRelayAnswer(a, sig, 'm_t', 'mid', 'n1', kp.publicPem)).toBe('ack');
    expect(verifyRelayAnswer(a, sig, 'm_x', 'mid', 'n1', kp.publicPem)).toBe(false);
    expect(verifyRelayAnswer(a, sig, 'm_t', 'other', 'n1', kp.publicPem)).toBe(false);
    expect(verifyRelayAnswer(a, sig, 'm_t', 'mid', 'n2', kp.publicPem)).toBe(false);
  });
});

describe('PR-B second-pass fixes', () => {
  it('an envelope re-queued from disk is re-signed with relayChain = [local]', async () => {
    const q = new CrossMachineRelayQueue({
      localMachine: 'm_s', addressesFor: () => [], resignForAttempt: () => {}, signRequestHeaders: () => ({}), peerPublicKey: () => null, onOutcome: async () => {},
    });
    expect(q).toBeTruthy();
    const src = fs.readFileSync(path.join(__dirname, '../../src/messaging/MessageRouter.ts'), 'utf8');
    const resign = src.slice(src.indexOf('resignForAttempt: (env) => {'), src.indexOf('signRequestHeaders:'));
    expect(resign).toMatch(/env\.transport\.relayChain = \[config\.localMachine\];/);
  });

  it('boot recovery excludes settled outcomes and delegates unfinished work through its exclusive wrapper', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/messaging/MessageRouter.ts'), 'utf8');
    const rec = src.slice(src.indexOf('async recoverPendingRelayed'), src.indexOf('private async applyRemoteNotice'));
    expect(rec).toContain("['delivered', 'read', 'failed', 'expired', 'dead-lettered'].includes(env.delivery.phase)");
    expect(rec).toContain("if (env.delivery.typingStartedAt || env.delivery.phase === 'received') await this.deliverRelayed(env)");
  });
});
