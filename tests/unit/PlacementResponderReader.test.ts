import { describe, it, expect, vi } from 'vitest';
import { PlacementResponderReader } from '../../src/core/PlacementResponderReader.js';

describe('PlacementResponderReader', () => {
  it('telegram: channelId is the topic; returns the placement owner', async () => {
    const fetchPlacement = vi.fn(async (t: string) => ({ owner: 'm_mini', ownerNickname: 'Mac Mini' }));
    const r = new PlacementResponderReader({
      topicForChannel: (_s, c) => c, // telegram: channel == topic
      fetchPlacement,
    });
    expect(await r.resolve('telegram', '960021')).toBe('m_mini');
    expect(fetchPlacement).toHaveBeenCalledWith('960021');
  });

  it('returns owner (who holds it), reflecting a real seat move', async () => {
    const r = new PlacementResponderReader({
      topicForChannel: (_s, c) => c,
      fetchPlacement: async () => ({ owner: 'm_laptop' }),
    });
    expect(await r.resolve('telegram', '13481')).toBe('m_laptop');
  });

  it('slack: uses the injected channel→topic mapping', async () => {
    const fetchPlacement = vi.fn(async (_t: string) => ({ owner: 'm_mini' }));
    const r = new PlacementResponderReader({
      topicForChannel: (s, c) => (s === 'slack' && c === 'C123' ? 'topic-77' : null),
      fetchPlacement,
    });
    expect(await r.resolve('slack', 'C123')).toBe('m_mini');
    expect(fetchPlacement).toHaveBeenCalledWith('topic-77');
  });

  it('no placement-tracked topic → null (and never calls fetch)', async () => {
    const fetchPlacement = vi.fn(async () => ({ owner: 'x' }));
    const r = new PlacementResponderReader({
      topicForChannel: () => null,
      fetchPlacement,
    });
    expect(await r.resolve('slack', 'C-unknown')).toBeNull();
    expect(fetchPlacement).not.toHaveBeenCalled();
  });

  it('owner null → null', async () => {
    const r = new PlacementResponderReader({
      topicForChannel: (_s, c) => c,
      fetchPlacement: async () => ({ owner: null }),
    });
    expect(await r.resolve('telegram', '1')).toBeNull();
  });

  it('a fetch error degrades to null (never throws — driver keeps the reply)', async () => {
    const r = new PlacementResponderReader({
      topicForChannel: (_s, c) => c,
      fetchPlacement: async () => { throw new Error('placement 503'); },
    });
    await expect(r.resolve('telegram', '1')).resolves.toBeNull();
  });

  it('the resolve field is bound (usable directly as RealChannelDriver.resolveResponderMachine)', async () => {
    const r = new PlacementResponderReader({
      topicForChannel: (_s, c) => c,
      fetchPlacement: async () => ({ owner: 'm_mini' }),
    });
    const fn = r.resolve; // detached reference — must still work (arrow-bound)
    expect(await fn('telegram', '5')).toBe('m_mini');
  });
});
