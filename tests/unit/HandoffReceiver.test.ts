/**
 * Tier-1 tests for HandoffReceiver — the incoming-machine handoff state machine
 * (§8 G3d/G3e). Covers: begin→build+send ack, ack-send failure → failed, yield
 * after ack → acquire (awake), stray yield with no handoff in progress is ignored,
 * and a failed consent acquire leaves the machine standby.
 */

import { describe, it, expect, vi } from 'vitest';
import { HandoffReceiver, type HandoffReceiverOps } from '../../src/core/HandoffReceiver.js';
import type { HandoffAck } from '../../src/core/HandoffSentinel.js';

const ACK: HandoffAck = {
  tailSeq: 9,
  ingressPosition: { platform: 'telegram', cursor: 100, capturedAt: '2026-01-01T00:00:00Z' },
  threadHistoryHash: 'h',
};

function make(over: Partial<HandoffReceiverOps> = {}, onTerminal?: any) {
  const ops: HandoffReceiverOps = {
    buildAck: vi.fn(async () => ACK),
    sendAck: vi.fn(async () => true),
    acquireOnYield: vi.fn(async () => true),
    ...over,
  };
  const r = new HandoffReceiver(ops, { onTerminal });
  return { r, ops };
}

describe('HandoffReceiver', () => {
  it('onBeginHandoff builds and sends the ack → ack_sent', async () => {
    const { r, ops } = make();
    expect(await r.onBeginHandoff()).toBe(true);
    expect(ops.buildAck).toHaveBeenCalled();
    expect(ops.sendAck).toHaveBeenCalledWith(ACK);
    expect(r.state).toBe('ack_sent');
  });

  it('onBeginHandoff → failed when the ack is not accepted', async () => {
    const { r } = make({ sendAck: vi.fn(async () => false) });
    expect(await r.onBeginHandoff()).toBe(false);
    expect(r.state).toBe('failed');
  });

  it('onBeginHandoff → failed when buildAck throws', async () => {
    const { r } = make({ buildAck: vi.fn(async () => { throw new Error('no buffer'); }) });
    expect(await r.onBeginHandoff()).toBe(false);
    expect(r.state).toBe('failed');
  });

  it('onYield after ack_sent acquires the lease → acquired', async () => {
    const onTerminal = vi.fn();
    const { r, ops } = make({}, onTerminal);
    await r.onBeginHandoff();
    expect(await r.onYield()).toBe(true);
    expect(ops.acquireOnYield).toHaveBeenCalled();
    expect(r.state).toBe('acquired');
    expect(onTerminal).toHaveBeenCalledWith('acquired', expect.any(String));
  });

  it('ignores a stray yield when no handoff is in progress (state idle)', async () => {
    const { r, ops } = make();
    expect(await r.onYield()).toBe(false);
    expect(ops.acquireOnYield).not.toHaveBeenCalled();
    expect(r.state).toBe('idle');
  });

  it('a failed consent acquire leaves the machine standby (failed)', async () => {
    const { r } = make({ acquireOnYield: vi.fn(async () => false) });
    await r.onBeginHandoff();
    expect(await r.onYield()).toBe(false);
    expect(r.state).toBe('failed');
  });
});
