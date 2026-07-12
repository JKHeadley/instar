/**
 * calm-alerting M-P3 — the rope escalation sink router.
 * Pins: source-declared class routing (undeclared ⇒ actionable ⇒ hub, fail-loud),
 * the LIVE delivery-true conjunction (each conjunct individually failing ⇒
 * fallback to hub — including the promoted-standby shape: lease held, no
 * scheduler), both-class 24 h dedupe with visible count appends, direction
 * labels, and audit rows for every outcome.
 */
import { describe, it, expect } from 'vitest';
import { makeRopeSinkRouter, type RopeSinkDeps, type RopeSinkItem } from '../../src/monitoring/ropeSinkRouter.js';

function harness(over: Partial<{ configured: boolean; runnable: boolean }> = {}) {
  const created: any[] = [];
  const sends: Array<{ topicId: number; text: string; silent?: boolean }> = [];
  const audits: Array<Record<string, unknown>> = [];
  let now = 1_000_000_000;
  const deps: RopeSinkDeps = {
    telegram: () => ({
      createAttentionItem: async (item) => { created.push(item); },
      getAttentionItem: (id) => (created.some((c) => c.id === id) ? { topicId: 555 } : undefined),
      sendToTopic: async (topicId, text, options) => { sends.push({ topicId, text, silent: options?.silent }); },
    }),
    digestConfigured: () => over.configured ?? true,
    digestRunnableHere: () => over.runnable ?? true,
    selfNickname: () => 'Mini',
    audit: (row) => { audits.push(row); },
    now: () => now,
  };
  const route = makeRopeSinkRouter(deps);
  return { route, created, sends, audits, advance: (ms: number) => { now += ms; } };
}

const slowAlive = (n = 1): RopeSinkItem => ({
  id: `rope-probe-slow-alive:peer-1:lan:${n}`,
  title: 'Mesh rope lan answers probes but stays demoted',
  body: 'The lan rope to Laptop has answered 20 consecutive recovery probes…',
  class: 'informational', peer: 'peer-1', kind: 'lan',
});
const exhausted = (n = 1): RopeSinkItem => ({
  id: `rope-probe-exhausted:peer-1:lan:${n}`,
  title: 'Mesh rope lan not recovering',
  body: 'The lan rope to Laptop has failed 20 recovery probes…',
  class: 'actionable', peer: 'peer-1', kind: 'lan',
});

describe('rope sink router — class routing + delivery-true demotion', () => {
  it('informational + full conjunction ⇒ demoted (no hub item, audited)', () => {
    const h = harness({ configured: true, runnable: true });
    h.route(slowAlive());
    expect(h.created).toHaveLength(0);
    expect(h.audits.some((a) => a.event === 'demoted-to-digest')).toBe(true);
  });

  it('promoted-standby shape (configured but NOT runnable here) ⇒ FALLBACK to hub', () => {
    const h = harness({ configured: true, runnable: false });
    h.route(slowAlive());
    expect(h.created).toHaveLength(1);
    expect(h.audits.some((a) => a.event === 'fallback-to-hub' && a.digestRunnableHere === false)).toBe(true);
  });

  it('digest unconfigured ⇒ FALLBACK to hub', () => {
    const h = harness({ configured: false, runnable: true });
    h.route(slowAlive());
    expect(h.created).toHaveLength(1);
  });

  it('actionable ALWAYS goes to the hub, conjunction irrelevant', () => {
    const h = harness({ configured: true, runnable: true });
    h.route(exhausted());
    expect(h.created).toHaveLength(1);
    expect(h.audits.some((a) => a.event === 'actionable-to-hub')).toBe(true);
  });

  it('UNDECLARED class defaults to actionable (fail-loud)', () => {
    const h = harness({ configured: true, runnable: true });
    h.route({ id: 'x', title: 't', body: 'b', peer: 'peer-1', kind: 'lan' });
    expect(h.created).toHaveLength(1);
  });

  it('hub items carry the direction + observer label', () => {
    const h = harness({ configured: false });
    h.route(slowAlive());
    expect(h.created[0].description).toContain('observed from Mini');
    expect(h.created[0].description).toContain('directional');
  });
});

describe('rope sink router — both-class 24 h dedupe with count appends', () => {
  it('a second exhaustion episode within 24 h appends a visible count instead of a new item', () => {
    const h = harness();
    h.route(exhausted(1));
    expect(h.created).toHaveLength(1);
    h.advance(3_600_000);
    h.route(exhausted(2)); // new episode id, same (peer,kind,class)
    expect(h.created).toHaveLength(1); // no second item
    expect(h.sends.some((s) => s.text.includes('2th') || s.text.includes('2'))).toBe(true);
    expect(h.sends.every((s) => s.silent === true)).toBe(true);
    expect(h.audits.some((a) => a.event === 'deduped')).toBe(true);
  });

  it('past 24 h the window re-arms (a fresh item is allowed)', () => {
    const h = harness();
    h.route(exhausted(1));
    h.advance(25 * 3_600_000);
    h.route(exhausted(2));
    expect(h.created).toHaveLength(2);
  });

  it('informational and actionable dedupe independently per class', () => {
    const h = harness({ configured: false }); // informational falls back to hub too
    h.route(slowAlive(1));
    h.route(exhausted(1));
    expect(h.created).toHaveLength(2); // one per class
  });
});
