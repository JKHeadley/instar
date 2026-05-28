/**
 * Tier-1 tests for HandoffWireTransport — the ack/yield channel of the planned
 * handoff (spec §8 G3d/G3e). Real Ed25519 signing, injected fetch + fake timers.
 * Covers: awaitAck resolves on recordAck, awaitAck times out → null, sendYield /
 * sendAck POST to the right endpoints with signed headers, onYield handler, and
 * the no-peer / no-pending edge cases.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { HandoffWireTransport, type HandoffWirePeer } from '../../src/core/HandoffWireTransport.js';
import type { HandoffAck } from '../../src/core/HandoffSentinel.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ACK: HandoffAck = {
  tailSeq: 12,
  ingressPosition: { platform: 'telegram', cursor: 4567, capturedAt: '2026-01-01T00:00:00Z' },
  threadHistoryHash: 'abc123',
};

function make(peer: HandoffWirePeer | null, fetchImpl?: any) {
  let seq = 0;
  return new HandoffWireTransport({
    selfMachineId: 'm_a',
    signingKeyPem: privateKey,
    peer: () => peer,
    nextSequence: () => ++seq,
    fetchImpl,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HandoffWireTransport', () => {
  it('awaitAck resolves when recordAck delivers the incoming ack', async () => {
    const t = make({ machineId: 'm_b', url: 'http://m_b' });
    const p = t.awaitAck(5000);
    t.recordAck(ACK);
    expect(await p).toEqual(ACK);
  });

  it('awaitAck resolves null on timeout', async () => {
    vi.useFakeTimers();
    const t = make({ machineId: 'm_b', url: 'http://m_b' });
    const p = t.awaitAck(5000);
    vi.advanceTimersByTime(5001);
    expect(await p).toBeNull();
  });

  it('sendYield POSTs to /api/handoff/yield with signed machine-auth headers', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true })) as any;
    const t = make({ machineId: 'm_b', url: 'http://m_b' }, fetchImpl);
    expect(await t.sendYield()).toBe(true);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://m_b/api/handoff/yield');
    expect(opts.headers['X-Machine-Id']).toBe('m_a');
    expect(opts.headers['X-Signature']).toBeTruthy();
    expect(JSON.parse(opts.body).yield).toBe(true);
  });

  it('sendAck POSTs the echo to /api/handoff/ack', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true })) as any;
    const t = make({ machineId: 'm_b', url: 'http://m_b' }, fetchImpl);
    expect(await t.sendAck(ACK)).toBe(true);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://m_b/api/handoff/ack');
    expect(JSON.parse(opts.body).ack.tailSeq).toBe(12);
  });

  it('recordYield invokes the registered onYield handler', () => {
    const t = make({ machineId: 'm_b', url: 'http://m_b' });
    const cb = vi.fn();
    t.onYield(cb);
    t.recordYield();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('no peer → sendYield/sendAck are false (cannot reach a counterpart)', async () => {
    const t = make(null, vi.fn());
    expect(await t.sendYield()).toBe(false);
    expect(await t.sendAck(ACK)).toBe(false);
  });

  it('recordAck with no pending awaitAck is a safe no-op', () => {
    const t = make({ machineId: 'm_b', url: 'http://m_b' });
    expect(() => t.recordAck(ACK)).not.toThrow();
  });
});
