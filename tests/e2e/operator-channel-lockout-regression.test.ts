/**
 * Operator-channel-sacred E2E regression — the exact 2026-06-25 lockout must be
 * impossible: no stream of benign inbound messages can ever lock the operator out,
 * even when the classifier mislabels EVERY message as 'pause' (or capacity-sheds).
 *
 * This is the lifecycle proof: it drives the REAL MessageSentinel.decideInboundDisposition
 * (the production decision both consume paths call) the way an inbound stream would.
 */
import { describe, it, expect } from 'vitest';
import { MessageSentinel } from '../../src/core/MessageSentinel.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const alwaysPause: IntelligenceProvider = { evaluate: async () => 'pause' } as unknown as IntelligenceProvider;
const alwaysCapacityShed: IntelligenceProvider = {
  evaluate: async () => { throw Object.assign(new Error('cap'), { capacityUnavailable: true }); },
} as unknown as IntelligenceProvider;

describe('lockout regression — the channel can NEVER be sealed by a benign stream', () => {
  it('20 benign messages with the LLM mislabeling EVERY one as pause → all delivered, zero consumed', async () => {
    const s = new MessageSentinel({ intelligence: alwaysPause });
    const benign = ['Testing', 'Checking in to see if telegram is working', 'hello?', 'are you there', 'status?'];
    let consumed = 0, delivered = 0;
    for (let i = 0; i < 20; i++) {
      const d = await s.decideInboundDisposition(benign[i % benign.length], 28130);
      if (d.disposition === 'pause' || d.disposition === 'kill') consumed++;
      if (d.disposition === 'route-through') delivered++;
    }
    expect(consumed).toBe(0);   // not one benign message was eaten
    expect(delivered).toBe(20); // every message reached the agent
  });

  it('a benign stream under sustained capacity-shed (the spawn-cap incident) is fully delivered', async () => {
    const s = new MessageSentinel({ intelligence: alwaysCapacityShed });
    for (let i = 0; i < 10; i++) {
      const d = await s.decideInboundDisposition('Testing ' + i, 28130);
      expect(d.disposition).toBe('route-through');
    }
  });

  it('the "send a message to resume" recovery is not a trap: a follow-up always gets through', async () => {
    const s = new MessageSentinel({ intelligence: alwaysPause });
    // even if a deterministic pause consumed first, the operator's follow-ups deliver
    await s.decideInboundDisposition('pause', 28130); // deterministic consume
    // benign follow-ups (none start with a deterministic pause/stop pattern) all deliver,
    // even though the LLM mislabels each as 'pause' — the recovery is escapable.
    const followups = ['hello', 'are you there', 'did it work', 'what happened'];
    for (const m of followups) {
      const d = await s.decideInboundDisposition(m, 28130);
      expect(d.disposition).toBe('route-through'); // never re-consumed → escapable
    }
  });

  it('a genuine stop in the stream is still honored (not lost to route-through)', async () => {
    const s = new MessageSentinel({ intelligence: alwaysCapacityShed });
    await s.decideInboundDisposition('Testing', 28130);
    const stop = await s.decideInboundDisposition('please stop everything now', 28130);
    expect(stop.disposition).toBe('kill'); // rescued despite capacity-shed
  });
});
