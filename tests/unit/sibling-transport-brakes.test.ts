/**
 * Tier-1 tests for the P19 brakes on the two remaining mesh transports —
 * HttpLiveTailTransport and ReplyMarkerTransport (audit fix #5, completing the
 * set #874 started on HttpLeaseTransport): every outbound request carries an
 * abort signal (hung-socket brake), and per-peer failure logging is
 * state-change-gated (first / every-Nth / recovery), never per-attempt.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { HttpLiveTailTransport } from '../../src/core/HttpLiveTailTransport.js';
import { ReplyMarkerTransport } from '../../src/core/ReplyMarkerTransport.js';

const { privateKey } = generateKeyPairSync('ed25519');
const signingKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function makeLiveTail(fetchImpl: any, failureLogEveryN?: number) {
  let seq = 0;
  const lines: string[] = [];
  const t = new HttpLiveTailTransport({
    selfMachineId: 'm_a',
    signingKeyPem,
    peers: () => [{ machineId: 'm_b', url: 'http://peer', encryptionPublicKey: 'cGsK' }],
    nextSequence: () => ++seq,
    encryptFor: (content) => ({ v: 3, alg: 'test', payload: content } as any),
    fetchImpl,
    failureLogEveryN,
    logger: (m) => lines.push(m),
  });
  return { t, lines };
}

function makeMarker(fetchImpl: any, failureLogEveryN?: number) {
  let seq = 0;
  const lines: string[] = [];
  const t = new ReplyMarkerTransport({
    selfMachineId: 'm_a',
    signingKeyPem,
    peers: () => [{ machineId: 'm_b', url: 'http://peer' }],
    nextSequence: () => ++seq,
    fetchImpl,
    failureLogEveryN,
    logger: (m) => lines.push(m),
  });
  return { t, lines };
}

const FLUSH = { topic: '42', seq: 1, content: 'hello' };
const MARKER = { dedupeKey: 'tg:1:2', platform: 'telegram', replyIdempotencyKey: 'r1', epoch: 7, topic: '42' };

describe('sibling-transport P19 brakes', () => {
  it('live-tail: every outbound request carries an abort signal', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true })) as any;
    const { t } = makeLiveTail(fetchImpl);
    await t.broadcast(FLUSH);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reply-marker: every outbound request carries an abort signal', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true })) as any;
    const { t } = makeMarker(fetchImpl);
    await t.broadcast(MARKER);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('SUSTAINED-FAILURE BOUND (P19, live-tail): 25 failed flushes log 3 lines, not 25', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const { t, lines } = makeLiveTail(fetchImpl, 10);
    for (let i = 0; i < 25; i++) await t.broadcast({ ...FLUSH, seq: i + 1 });
    expect(lines).toHaveLength(3); // first + #10 + #20
    expect(lines[0]).toContain('became unreachable');
    expect(lines[2]).toContain('20 consecutive failures');
  });

  it('SUSTAINED-FAILURE BOUND (P19, reply-marker): rejecting peer (403 per marker) logs gated, not per-attempt', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 })) as any;
    const { t, lines } = makeMarker(fetchImpl, 10);
    for (let i = 0; i < 12; i++) await t.broadcast({ ...MARKER, dedupeKey: `k${i}` });
    expect(lines).toHaveLength(2); // first (status 403) + the 10th reminder
    expect(lines[0]).toContain('status 403');
  });

  it('recovery logs exactly once on both transports', async () => {
    let fail = true;
    const mk = async () => { if (fail) throw new Error('down'); return { ok: true }; };
    const { t: lt, lines: ltLines } = makeLiveTail(vi.fn(mk) as any, 100);
    const { t: mt, lines: mtLines } = makeMarker(vi.fn(mk) as any, 100);
    await lt.broadcast(FLUSH); await mt.broadcast(MARKER);
    fail = false;
    await lt.broadcast(FLUSH); await mt.broadcast(MARKER);
    await lt.broadcast(FLUSH); await mt.broadcast(MARKER);
    expect(ltLines.filter((l) => l.includes('recovered after 1 consecutive failures'))).toHaveLength(1);
    expect(mtLines.filter((l) => l.includes('recovered after 1 consecutive failures'))).toHaveLength(1);
  });

  it('steady success is silent on both transports (no per-send chatter)', async () => {
    const ok = vi.fn(async () => ({ ok: true })) as any;
    const { t: lt, lines: ltLines } = makeLiveTail(ok);
    const { t: mt, lines: mtLines } = makeMarker(ok);
    for (let i = 0; i < 10; i++) { await lt.broadcast(FLUSH); await mt.broadcast(MARKER); }
    expect(ltLines).toHaveLength(0);
    expect(mtLines).toHaveLength(0);
  });
});
