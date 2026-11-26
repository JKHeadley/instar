/**
 * SEC-133: the agent signs a relay/registry login challenge only when it has the shape the real
 * relay sends (32 random bytes as base64). A relay that sends any other bytes, such as the exact
 * bytes of a pair-verify receipt, gets no signature. Real RelayClient against a ws stand-in relay.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { RelayClient } from '../../src/threadline/client/RelayClient.js';
import { RegistryRestClient } from '../../src/threadline/client/RegistryRestClient.js';
import { generateIdentityKeyPair, verify } from '../../src/threadline/ThreadlineCrypto.js';
import { receiptMessageBytes } from '../../src/threadline/PairVerifyReceipt.js';
import { isRelayChallengeNonce, reportRefusedChallenge, resetRefusedChallengeReportsForTesting } from '../../src/threadline/client/relayChallenge.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

const servers: WebSocketServer[] = [];
afterEach(async () => { DegradationReporter.resetForTesting(); resetRefusedChallengeReportsForTesting(); for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r())); });

function identity() {
  const kp = generateIdentityKeyPair();
  return { fingerprint: crypto.createHash('sha256').update(kp.publicKey).digest('hex').slice(0, 32), publicKey: kp.publicKey, privateKey: kp.privateKey, x25519PublicKey: Buffer.alloc(32), createdAt: new Date().toISOString() } as never;
}

async function relaySending(nonce: string): Promise<{ url: string; got: Promise<{ auth: Record<string, unknown> | null; closed: boolean }> }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }); servers.push(wss);
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const got = new Promise<{ auth: Record<string, unknown> | null; closed: boolean }>((resolve) => {
    wss.on('connection', (ws) => {
      let auth: Record<string, unknown> | null = null;
      ws.on('message', (m) => { const f = JSON.parse(m.toString()); if (f.type === 'auth') { auth = f; resolve({ auth, closed: false }); } });
      ws.on('close', () => resolve({ auth, closed: true }));
      ws.send(JSON.stringify({ type: 'challenge', nonce }));
      setTimeout(() => resolve({ auth, closed: false }), 1500);
    });
  });
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, got };
}

describe('SEC-133: relay login challenge shape', () => {
  it('accepts exactly the shape the real relay mints, and nothing else', () => {
    for (let i = 0; i < 50; i++) expect(isRelayChallengeNonce(crypto.randomBytes(32).toString('base64'))).toBe(true);
    const receipt = receiptMessageBytes('pair-1', 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), '2026-11-21T00:00:00.000Z').toString('utf-8');
    for (const bad of [receipt, '', 'x', '{"type":"envelope"}', crypto.randomBytes(16).toString('base64'), crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('base64').replace('=', 'A'), `${crypto.randomBytes(32).toString('base64')}\n`]) {
      expect(isRelayChallengeNonce(bad)).toBe(false);
    }
  });

  it('signs a real relay challenge with the identity key', async () => {
    const id = identity() as unknown as { publicKey: Buffer };
    const nonce = crypto.randomBytes(32).toString('base64');
    const { url, got } = await relaySending(nonce);
    const client = new RelayClient({ relayUrl: url, name: 't', reconnectInitialMs: 60_000 } as never, id as never);
    client.on('error', () => { /* expected noise */ });
    client.connect().catch(() => { /* the stand-in never sends auth_ok */ });
    const { auth } = await got;
    client.disconnect?.();
    expect(auth).not.toBeNull();
    expect(verify(id.publicKey, Buffer.from(nonce, 'utf-8'), Buffer.from(String(auth!.signature), 'base64'))).toBe(true);
  });

  it('refuses to sign a challenge carrying the bytes of a pair-verify receipt, with no error event, and connect() settles', async () => {
    const id = identity();
    const receipt = receiptMessageBytes('pair-1', 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), '2026-11-21T00:00:00.000Z').toString('utf-8');
    const { url, got } = await relaySending(receipt);
    // NO 'error' listener on purpose: an emitted 'error' would throw (the server path has none).
    const client = new RelayClient({ relayUrl: url, name: 't', reconnectInitialMs: 60_000 } as never, id);
    const refused: unknown[] = [];
    client.on('challenge-refused', (e) => { refused.push(e); });
    await expect(client.connect()).rejects.toThrow(/not 32 random bytes/);
    const { auth } = await got;
    client.disconnect();
    expect(auth).toBeNull();
    expect(refused).toHaveLength(1);
    expect(DegradationReporter.getInstance().getRecentEvents().some((e) => e.feature === 'RelayClient.challengeRefused')).toBe(true);
  });

  it('reports a refusing relay once per 10 minutes, not on every retry', () => {
    const count = () => DegradationReporter.getInstance().getRecentEvents().filter((e) => e.feature === 'RelayClient.challengeRefused').length;
    const t = 1_000_000;
    reportRefusedChallenge('relay', 'wss://bad.example/v1', t);
    reportRefusedChallenge('relay', 'wss://bad.example/v1', t + 1_000);
    reportRefusedChallenge('relay', 'wss://bad.example/v1', t + 9 * 60_000);
    expect(count()).toBe(1);
    reportRefusedChallenge('relay', 'wss://bad.example/v1', t + 11 * 60_000);
    expect(count()).toBe(2);
  });

  it('the registry login also refuses a challenge that is not 32 random bytes', async () => {
    const id = identity();
    const { url, got } = await relaySending('threadline-pair-verify-v2\u0000forged');
    const reg = new RegistryRestClient({ relayUrl: url, identity: id, agentName: 't' } as never);
    await expect(reg.authenticate()).rejects.toThrow(/not 32 random bytes/);
    const { auth } = await got;
    expect(auth).toBeNull();
  });
});
