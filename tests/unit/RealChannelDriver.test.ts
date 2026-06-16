import { describe, it, expect, vi } from 'vitest';
import { RealChannelDriver, type SurfaceSender } from '../../src/core/RealChannelDriver.js';
import type { Surface } from '../../src/core/LiveTestArtifactStore.js';

function fakeSender(reply: { text: string; messageId: string } | null): SurfaceSender {
  return {
    send: vi.fn(async (_c: string, _t: string) => ({ messageId: 'sent-1' })),
    awaitReply: vi.fn(async () => reply),
  };
}

const demoYes = { isDemoChannel: () => true };
const demoNo = { isDemoChannel: () => false };

describe('RealChannelDriver', () => {
  it('dispatches send to the surface sender', async () => {
    const tg = fakeSender({ text: 'hi', messageId: 'r1' });
    const driver = new RealChannelDriver({
      senders: { telegram: tg },
      demoRegistry: demoNo,
      resolveResponderMachine: async () => 'mini',
    });
    const res = await driver.send('telegram', '13481', 'hello');
    expect(res.messageId).toBe('sent-1');
    expect(tg.send).toHaveBeenCalledWith('13481', 'hello');
  });

  it('awaitReply stamps responderMachineId from the placement reader (the cross-machine proof)', async () => {
    const tg = fakeSender({ text: 'served from mini', messageId: 'r9' });
    const resolve = vi.fn(async (_s: Surface, _c: string) => 'm_mini');
    const driver = new RealChannelDriver({
      senders: { telegram: tg },
      demoRegistry: demoNo,
      resolveResponderMachine: resolve,
    });
    const reply = await driver.awaitReply('telegram', '960021', { timeoutMs: 5000, afterMessageId: 'sent-1' });
    expect(reply).not.toBeNull();
    expect(reply!.text).toBe('served from mini');
    expect(reply!.responderMachineId).toBe('m_mini');
    expect(resolve).toHaveBeenCalledWith('telegram', '960021');
  });

  it('null reply (timeout) returns null without calling the placement reader', async () => {
    const tg = fakeSender(null);
    const resolve = vi.fn(async () => 'm_mini');
    const driver = new RealChannelDriver({
      senders: { telegram: tg },
      demoRegistry: demoNo,
      resolveResponderMachine: resolve,
    });
    const reply = await driver.awaitReply('telegram', '1', { timeoutMs: 10, afterMessageId: 'x' });
    expect(reply).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a placement-reader error degrades to undefined responder, never throws away the real reply', async () => {
    const sl = fakeSender({ text: 'real reply', messageId: 'r2' });
    const driver = new RealChannelDriver({
      senders: { slack: sl },
      demoRegistry: demoYes,
      resolveResponderMachine: async () => { throw new Error('placement read 503'); },
    });
    const reply = await driver.awaitReply('slack', 'C1', { timeoutMs: 100 });
    expect(reply).not.toBeNull();
    expect(reply!.text).toBe('real reply');
    expect(reply!.responderMachineId).toBeUndefined();
  });

  it('a missing sender for a surface throws loudly (never a silent skip)', async () => {
    const driver = new RealChannelDriver({
      senders: { telegram: fakeSender(null) }, // no slack sender
      demoRegistry: demoNo,
      resolveResponderMachine: async () => null,
    });
    await expect(driver.send('slack', 'C1', 'x')).rejects.toThrow(/no real sender configured for surface "slack"/);
  });

  it('isDemoChannel delegates to the registry', () => {
    const driver = new RealChannelDriver({
      senders: {},
      demoRegistry: { isDemoChannel: (s, c) => s === 'slack' && c === 'C-demo' },
      resolveResponderMachine: async () => null,
    });
    expect(driver.isDemoChannel('slack', 'C-demo')).toBe(true);
    expect(driver.isDemoChannel('slack', 'C-other')).toBe(false);
    expect(driver.isDemoChannel('telegram', 'C-demo')).toBe(false);
  });

  it('resolveResponderMachine returning null → responderMachineId undefined', async () => {
    const tg = fakeSender({ text: 'x', messageId: 'r' });
    const driver = new RealChannelDriver({
      senders: { telegram: tg },
      demoRegistry: demoNo,
      resolveResponderMachine: async () => null,
    });
    const reply = await driver.awaitReply('telegram', '1', { timeoutMs: 10 });
    expect(reply!.responderMachineId).toBeUndefined();
  });
});
