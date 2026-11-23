import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { readPeerMessageGeneration, generationProofId, type MessageGenerationObservation } from '../../src/messaging/peerMessageTarget.js';
import { signRelayAnswer } from '../../src/server/machineAuth.js';
import { MESSAGE_GENERATION_PATH } from '../../src/messaging/types.js';

const key = () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  return { publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privatePem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};
const sender = key(), receiver = key();
const peer = { machineId: 'receiver', url: 'http://192.168.1.2:4040', kind: 'lan' };
function answer(init: any, observation: MessageGenerationObservation = { target: 'echo-worker', sessionId: 'incarnation-1', observedAt: Date.now() }, change = {}) {
  const ack = { machineId: 'receiver', messageId: generationProofId(observation), reqNonce: init.headers['X-Nonce'] };
  return { observation, ack, sig: signRelayAnswer(ack, receiver.privatePem), ...change };
}
const read = (fetchImpl: any, change = {}) => readPeerMessageGeneration({ peer, target: 'echo-worker', selfMachine: 'sender', signingKeyPem: sender.privatePem, peerPublicKeyPem: receiver.publicPem, fetchImpl, ...change });

describe('nonce-bound peer message generation proof', () => {
  it('works over registered LAN HTTP, authenticates the response, sends no bearer, and never follows redirects', async () => {
    const fetch = vi.fn(async (_url, init) => new Response(JSON.stringify(answer(init))));
    expect(await read(fetch)).toEqual({ sessionId: 'incarnation-1' });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(peer.url + MESSAGE_GENERATION_PATH);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: JSON.stringify({ target: 'echo-worker' }) });
    expect(init.headers['X-Machine-Id']).toBe('sender');
    expect(init.headers['X-Signature']).toBeTypeOf('string');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['target', 'sessionId', 'observedAt'])('changing signed observation %s is refused', async (field) => {
    expect(await read(async (_url, init) => {
      const proof = answer(init);
      (proof.observation as any)[field] = field === 'observedAt' ? Date.now() + 1 : 'substituted';
      return new Response(JSON.stringify(proof));
    })).toHaveProperty('reason');
  });

  it('changing the signed peer, target digest or request nonce is refused', async () => {
    for (const change of [{ machineId: 'wrong-peer' }, { messageId: 'wrong-target' }, { reqNonce: 'old-request' }]) {
      expect(await read(async (_url, init) => {
        const proof = answer(init); Object.assign(proof.ack, change);
        return new Response(JSON.stringify(proof));
      })).toHaveProperty('reason');
    }
  });

  it('a replayed valid answer cannot prove the next request', async () => {
    let old: unknown;
    const fetch = async (_url: string, init: any) => {
      old ??= answer(init);
      return new Response(JSON.stringify(old));
    };
    expect(await read(fetch)).toHaveProperty('sessionId');
    expect(await read(fetch)).toHaveProperty('reason');
  });

  it('a proof signed by another key is refused', async () => {
    expect(await read(async (_url, init) => new Response(JSON.stringify(answer(init))), { peerPublicKeyPem: sender.publicPem })).toHaveProperty('reason');
  });

  it('a signed no-holder answer supplies no generation', async () => {
    expect(await read(async (_url, init) => new Response(JSON.stringify(answer(init, { target: 'echo-worker', sessionId: null, observedAt: Date.now() }))))).toMatchObject({ reason: 'receiving machine has no unique running session for that role' });
  });

  it.each([301, 302, 307, 401, 403, 404, 503])('HTTP %s supplies no proof, including a mixed-version 404', async (status) => {
    const fetch = vi.fn(async () => new Response('', { status, headers: { location: 'http://another.example' } }));
    expect(await read(fetch)).toMatchObject({ reason: expect.stringContaining(`HTTP ${status}`) });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('an unsigned 404, malformed proof or redirect cannot suppress a valid second registered rope', async () => {
    for (const bad of [() => new Response('', { status: 404 }), () => new Response('{}'), () => new Response('', { status: 307, headers: { location: 'http://unregistered.example' } })]) {
      let calls = 0;
      const fetch = vi.fn(async (_url, init) => ++calls === 1 ? bad() : new Response(JSON.stringify(answer(init))));
      expect(await read(fetch, { peer: { ...peer, ropes: [{ url: 'https://receiver.dawn-tunnel.dev', kind: 'cloudflare' }] } })).toEqual({ sessionId: 'incarnation-1' });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1][0]).toBe('https://receiver.dawn-tunnel.dev' + MESSAGE_GENERATION_PATH);
    }
  });

  it('an oversized response cannot allocate an unbounded proof body', async () => {
    expect(await read(async () => new Response('x'.repeat(4097)))).toHaveProperty('reason');
  });

  it('no registered identity or address never dials', async () => {
    const fetch = vi.fn();
    expect(await read(fetch, { peer: null })).toHaveProperty('reason');
    expect(await read(fetch, { peerPublicKeyPem: null })).toHaveProperty('reason');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('network failures inspect each registered rope within the shared deadline', async () => {
    const fetch = vi.fn(async () => { throw new Error('refused'); });
    expect(await read(fetch, { peer: { ...peer, ropes: [1, 2, 3, 4].map((n) => ({ url: `http://192.168.1.${n + 2}:4040`, kind: 'lan' })) } })).toHaveProperty('reason');
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.every((call) => (call as any)[1].signal instanceof AbortSignal)).toBe(true);
  });
});
