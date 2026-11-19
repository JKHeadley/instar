/**
 * One verdict per inbound message.
 *
 * Incident (2026-11-18, topic 144201): the operator sent a correction with a
 * photo — "This plan is NOT working. the wrong account is growing: dawn and NOT
 * healdey.justin". The lifeline gives up on a forward after 10s and re-sends it;
 * the sentinel's model call took 5–13s, so the same message reached
 * decideInboundDisposition again and again. The preserved model answers for that
 * one message, in order, were:
 *
 *   redirect, emergency-stop, redirect, redirect, redirect, redirect, redirect
 *
 * Each delivery asked afresh, so the second delivery's lone 'emergency-stop'
 * killed the session. The first decision for a message must be THE decision for
 * every repeated delivery of that message.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessageSentinel, INBOUND_DECISION_REUSE_MS, INBOUND_DECISION_MAX_ENTRIES } from '../../src/core/MessageSentinel.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const CORRECTION = '[The user sent a photo (attachment `144709`, `photo-1794973251771-144709.jpg`). It is stored on another machine and cannot be opened here.]\n'
  + 'This plan is NOT working. the wrong account is growing: dawn and NOT healdey.justin';
const INCIDENT_ANSWERS = ['redirect', 'emergency-stop', 'redirect', 'redirect', 'redirect', 'redirect', 'redirect'];

/** A model that answers from a script, one answer per call, and counts the calls. */
function scriptedIntel(answers: string[], delayMs = 0) {
  let i = 0;
  const calls: string[] = [];
  const provider = {
    evaluate: async (prompt: string) => {
      calls.push(prompt);
      const a = answers[Math.min(i, answers.length - 1)];
      i++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return a;
    },
  } as unknown as IntelligenceProvider;
  return { provider, calls };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('MessageSentinel — one verdict per inbound message', () => {
  it('replays the incident: seven deliveries of the same correction get the first verdict, and nothing kills', async () => {
    const { provider, calls } = scriptedIntel(INCIDENT_ANSWERS);
    const s = new MessageSentinel({ intelligence: provider });
    const key = 'telegram:144201:144709';

    const decisions = [];
    for (let n = 0; n < 7; n++) decisions.push(await s.decideInboundDisposition(CORRECTION, 144201, key));

    expect(calls).toHaveLength(1);
    for (const d of decisions) expect(d.disposition).toBe('route-through');
    expect(decisions[0].reused).toBeUndefined();
    expect(decisions.slice(1).every((d) => d.reused === true)).toBe(true);
    expect(s.dispositionStats.decisionReused).toBe(6);
  });

  it('discriminator: without a message key the same script re-asks and the second delivery kills (the old behaviour)', async () => {
    const { provider, calls } = scriptedIntel(INCIDENT_ANSWERS);
    const s = new MessageSentinel({ intelligence: provider });

    const first = await s.decideInboundDisposition(CORRECTION, 144201);
    const second = await s.decideInboundDisposition(CORRECTION, 144201);

    expect(calls).toHaveLength(2);
    expect(first.disposition).toBe('route-through');
    expect(second.disposition).toBe('kill');
  });

  it('a delivery that arrives while the first classification is still running waits for that same verdict', async () => {
    const { provider, calls } = scriptedIntel(INCIDENT_ANSWERS, 30);
    const s = new MessageSentinel({ intelligence: provider });
    const key = 'telegram:144201:144709';

    const [a, b, c] = await Promise.all([
      s.decideInboundDisposition(CORRECTION, 144201, key),
      s.decideInboundDisposition(CORRECTION, 144201, key),
      s.decideInboundDisposition(CORRECTION, 144201, key),
    ]);

    expect(calls).toHaveLength(1);
    expect([a.disposition, b.disposition, c.disposition]).toEqual(['route-through', 'route-through', 'route-through']);
  });

  it('a genuine model-inferred stop is reused too: every delivery of that message is a stop', async () => {
    const { provider, calls } = scriptedIntel(['emergency-stop', 'normal']);
    const s = new MessageSentinel({ intelligence: provider });
    const key = 'telegram:7:1';
    const msg = 'I changed my mind, do not touch the database at all right now';

    const first = await s.decideInboundDisposition(msg, 7, key);
    const again = await s.decideInboundDisposition(msg, 7, key);

    expect(calls).toHaveLength(1);
    expect(first.disposition).toBe('kill');
    expect(again.disposition).toBe('kill');
  });

  it('different messages are decided separately: another message id, or the same id with different text', async () => {
    const { provider, calls } = scriptedIntel(['redirect', 'emergency-stop', 'normal']);
    const s = new MessageSentinel({ intelligence: provider });

    const a = await s.decideInboundDisposition(CORRECTION, 144201, 'telegram:144201:144709');
    const b = await s.decideInboundDisposition(CORRECTION, 144201, 'telegram:144201:144710');
    const c = await s.decideInboundDisposition(`${CORRECTION} (edited)`, 144201, 'telegram:144201:144709');

    expect(calls).toHaveLength(3);
    expect(a.disposition).toBe('route-through');
    expect(b.disposition).toBe('kill');
    expect(c.disposition).toBe('route-through');
  });

  it('the exact-match floor still stops at once on every delivery and never consults the model', async () => {
    const { provider, calls } = scriptedIntel(['normal']);
    const s = new MessageSentinel({ intelligence: provider });

    const first = await s.decideInboundDisposition('stop', 9, 'telegram:9:5');
    const again = await s.decideInboundDisposition('stop', 9, 'telegram:9:5');

    expect(first.disposition).toBe('kill');
    expect(again.disposition).toBe('kill');
    expect(calls).toHaveLength(0);
  });

  it('a redelivered deterministic pause counts once toward the pause circuit-breaker', async () => {
    const s = new MessageSentinel({});
    for (let n = 0; n < 5; n++) {
      const d = await s.decideInboundDisposition('pause', 11, 'telegram:11:42');
      expect(d.disposition).toBe('pause');
    }
    expect(s.dispositionStats.pauseConsumed).toBe(1);
  });

  it('a decision that throws is not remembered: the next delivery decides afresh', async () => {
    const { provider } = scriptedIntel(['redirect']);
    const s = new MessageSentinel({ intelligence: provider });
    const spy = vi.spyOn(s, 'classify').mockRejectedValueOnce(new Error('boom'));

    await expect(s.decideInboundDisposition(CORRECTION, 1, 'telegram:1:1')).rejects.toThrow('boom');
    const d = await s.decideInboundDisposition(CORRECTION, 1, 'telegram:1:1');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(d.disposition).toBe('route-through');
    expect(d.reused).toBeUndefined();
  });

  it('a fallback is not a verdict: when the model call fails, the next delivery asks again', async () => {
    let n = 0;
    const provider = {
      evaluate: async () => { n++; if (n === 1) throw new Error('model unreachable'); return 'redirect'; },
    } as unknown as IntelligenceProvider;
    const s = new MessageSentinel({ intelligence: provider });

    const first = await s.decideInboundDisposition(CORRECTION, 1, 'telegram:1:3');
    const second = await s.decideInboundDisposition(CORRECTION, 1, 'telegram:1:3');
    const third = await s.decideInboundDisposition(CORRECTION, 1, 'telegram:1:3');

    expect(first.degraded).toBe(true);
    expect(first.disposition).toBe('route-through');
    expect(n).toBe(2); // the failed first call, then one real judgment, then reuse
    expect(second.degraded).toBeUndefined();
    expect(second.reused).toBeUndefined();
    expect(third.reused).toBe(true);
  });

  it('the cap drops the oldest remembered verdict first', async () => {
    const { provider, calls } = scriptedIntel(['redirect']);
    const s = new MessageSentinel({ intelligence: provider });
    for (let i = 0; i < INBOUND_DECISION_MAX_ENTRIES + 1; i++) {
      await s.decideInboundDisposition(CORRECTION, 1, `telegram:1:${i}`);
    }
    expect(calls).toHaveLength(INBOUND_DECISION_MAX_ENTRIES + 1);
    await s.decideInboundDisposition(CORRECTION, 1, `telegram:1:${INBOUND_DECISION_MAX_ENTRIES}`); // newest: kept
    expect(calls).toHaveLength(INBOUND_DECISION_MAX_ENTRIES + 1);
    await s.decideInboundDisposition(CORRECTION, 1, 'telegram:1:0'); // oldest: dropped
    expect(calls).toHaveLength(INBOUND_DECISION_MAX_ENTRIES + 2);
  });

  it('after the reuse window a delivery of the same message is decided again', async () => {
    vi.useFakeTimers();
    const { provider, calls } = scriptedIntel(['redirect', 'normal']);
    const s = new MessageSentinel({ intelligence: provider });

    await s.decideInboundDisposition(CORRECTION, 1, 'telegram:1:2');
    vi.setSystemTime(Date.now() + INBOUND_DECISION_REUSE_MS + 1000);
    const later = await s.decideInboundDisposition(CORRECTION, 1, 'telegram:1:2');

    expect(calls).toHaveLength(2);
    expect(later.reused).toBeUndefined();
  });
});
