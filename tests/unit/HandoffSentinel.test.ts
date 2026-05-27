/**
 * Tier-1 tests for HandoffSentinel — the planned-handoff lifecycle owner (§8 G3e).
 * The critical safety property: the lease is NEVER yielded unless the ack is
 * verified AND validation passes. Both sides of every gate are covered.
 */

import { describe, it, expect, vi } from 'vitest';
import { HandoffSentinel, type HandoffOps, type FlushManifest, type HandoffAck } from '../../src/core/HandoffSentinel.js';
import type { IngressPosition } from '../../src/core/types.js';

const POS: IngressPosition = { platform: 'telegram', cursor: 4242, capturedAt: '2026-01-01T00:00:00Z' };
const MANIFEST: FlushManifest = { tailSeq: 7, ingressPosition: POS, threadHistoryHash: 'abc123' };
const GOOD_ACK: HandoffAck = { tailSeq: 7, ingressPosition: POS, threadHistoryHash: 'abc123' };

function ops(over?: Partial<HandoffOps>): HandoffOps {
  return {
    flush: vi.fn(async () => MANIFEST),
    awaitAck: vi.fn(async () => GOOD_ACK),
    validate: vi.fn(async () => true),
    sendYield: vi.fn(async () => {}),
    demoteSelf: vi.fn(async () => {}),
    ...over,
  };
}
const cfg = (over?: any) => ({ handoffAckTimeoutMs: 5_000, minHandoffIntervalMs: 60_000, ...over });

describe('HandoffSentinel', () => {
  it('completes a planned handoff when ack verifies and validation passes', async () => {
    const o = ops();
    const s = new HandoffSentinel(o, cfg());
    const outcome = await s.initiate();
    expect(outcome).toBe('handed-off');
    expect(s.state).toBe('committed');
    expect(o.sendYield).toHaveBeenCalledTimes(1);
    expect(o.demoteSelf).toHaveBeenCalledTimes(1);
  });

  it('ABORTS and stays awake (no yield) when no ack arrives', async () => {
    const o = ops({ awaitAck: vi.fn(async () => null) });
    const s = new HandoffSentinel(o, cfg());
    const outcome = await s.initiate();
    expect(outcome).toBe('aborted-stay-awake');
    expect(o.sendYield).not.toHaveBeenCalled(); // never yields without a verified ack
    expect(o.demoteSelf).not.toHaveBeenCalled();
  });

  it('ABORTS when the ack echo does not match the flush manifest', async () => {
    const o = ops({ awaitAck: vi.fn(async () => ({ ...GOOD_ACK, threadHistoryHash: 'WRONG' })) });
    const s = new HandoffSentinel(o, cfg());
    expect(await s.initiate()).toBe('aborted-stay-awake');
    expect(o.sendYield).not.toHaveBeenCalled();
  });

  it('ABORTS when the ingress position echo mismatches', async () => {
    const o = ops({ awaitAck: vi.fn(async () => ({ ...GOOD_ACK, ingressPosition: { ...POS, cursor: 9999 } })) });
    const s = new HandoffSentinel(o, cfg());
    expect(await s.initiate()).toBe('aborted-stay-awake');
    expect(o.sendYield).not.toHaveBeenCalled();
  });

  it('ABORTS when validation fails (no yield)', async () => {
    const o = ops({ validate: vi.fn(async () => false) });
    const s = new HandoffSentinel(o, cfg());
    expect(await s.initiate()).toBe('aborted-stay-awake');
    expect(o.sendYield).not.toHaveBeenCalled();
  });

  it('treats a validator throw/timeout as "not verified" (no yield)', async () => {
    const o = ops({ validate: vi.fn(async () => { throw new Error('validator timeout'); }) });
    const s = new HandoffSentinel(o, cfg());
    expect(await s.initiate()).toBe('aborted-stay-awake');
    expect(o.sendYield).not.toHaveBeenCalled();
  });

  it('fails (not yield) when the flush itself fails', async () => {
    const o = ops({ flush: vi.fn(async () => { throw new Error('flush boom'); }) });
    const s = new HandoffSentinel(o, cfg());
    expect(await s.initiate()).toBe('failed');
    expect(o.sendYield).not.toHaveBeenCalled();
  });

  it('respects the anti-oscillation floor', async () => {
    let now = 1_000_000;
    const o = ops();
    const s = new HandoffSentinel(o, cfg({ now: () => now }));
    expect(await s.initiate()).toBe('handed-off');
    // Immediately try again within minHandoffIntervalMs.
    now += 1_000;
    const second = await s.initiate();
    expect(second).toBe('aborted-stay-awake');
    expect((o.flush as any).mock.calls.length).toBe(1); // second handoff never even flushed
  });

  it('exposes inProgress=false after completion (race guard releases)', async () => {
    const s = new HandoffSentinel(ops(), cfg());
    await s.initiate();
    expect(s.inProgress).toBe(false);
  });

  it('emits a terminal event with the outcome', async () => {
    const onTerminal = vi.fn();
    const s = new HandoffSentinel(ops(), cfg({ onTerminal }));
    await s.initiate();
    expect(onTerminal).toHaveBeenCalledWith('handed-off', expect.any(String));
  });
});
