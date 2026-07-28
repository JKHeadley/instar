/**
 * The channel registry must never lose a channel.
 *
 * INCIDENT (2026-07-26). Three inter-agent failures in one evening shared one shape: the thing that
 * failed removed itself from the list of failures. A dropped relay left "connected" as the only
 * record. A subsystem that threw before registering was missing from an 88-row guard inventory — not
 * "off", not "errored", ABSENT. A peer had no row at all in the surface built to report peer health.
 *
 * A missing row and a healthy system are indistinguishable to a reader. So the property under test is
 * not "does it report correctly" but "can it lose anything" — and the answer must be no, for every
 * way a probe can misbehave.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveChannels,
  type ChannelDefinition,
  type ChannelProbeResult,
} from '../../src/core/channelRegistry.js';

const FIXED_NOW = () => '2026-07-26T20:30:00.000Z';

function def(id: string, probe: () => Promise<ChannelProbeResult>): ChannelDefinition {
  return { id, purpose: `purpose of ${id}`, whenPreferred: `prefer ${id} when…`, cost: `cost of ${id}`, probe };
}

const ok = (): Promise<ChannelProbeResult> =>
  Promise.resolve({ state: 'working', direction: 'bidirectional', detail: 'probed and usable' });

describe('channel registry — absence is impossible', () => {
  it('REGRESSION: a channel whose probe THROWS still gets a row', async () => {
    // This is the incident, in miniature. Before: it would vanish and read as "nothing wrong".
    const report = await resolveChannels([
      def('healthy', ok),
      def('explodes', () => Promise.reject(new Error('relay socket closed'))),
    ], FIXED_NOW);

    expect(report.channels).toHaveLength(2);
    const boom = report.channels.find(c => c.id === 'explodes')!;
    expect(boom.state).toBe('unknown');
    expect(boom.probeFailed).toBe(true);
    expect(boom.detail).toContain('relay socket closed');
  });

  it('REGRESSION: a probe that throws SYNCHRONOUSLY still gets a row', async () => {
    // A rejected promise and a synchronous throw are different code paths; both must be contained.
    const report = await resolveChannels([
      def('sync-throw', (() => { throw new Error('constructed nothing'); }) as never),
    ], FIXED_NOW);

    expect(report.channels).toHaveLength(1);
    expect(report.channels[0].state).toBe('unknown');
    expect(report.channels[0].probeFailed).toBe(true);
  });

  it('a probe returning garbage is UNDETERMINED, never healthy', async () => {
    // The dangerous direction is a malformed result defaulting to "working".
    const report = await resolveChannels([
      def('garbage', () => Promise.resolve({ nope: true } as unknown as ChannelProbeResult)),
      def('nullish', () => Promise.resolve(null as unknown as ChannelProbeResult)),
    ], FIXED_NOW);

    expect(report.channels).toHaveLength(2);
    for (const c of report.channels) {
      expect(c.state).toBe('unknown');
      expect(c.probeFailed).toBe(true);
    }
    expect(report.summary.working).toBe(0);
  });

  it('a HANGING probe cannot make the registry unanswerable', async () => {
    // One wedged channel must not take the whole surface down with it.
    const report = await resolveChannels([
      def('healthy', ok),
      def('hangs', () => new Promise<ChannelProbeResult>(() => { /* never settles */ })),
    ], FIXED_NOW);

    expect(report.channels).toHaveLength(2);
    const hung = report.channels.find(c => c.id === 'hangs')!;
    expect(hung.state).toBe('unknown');
    expect(hung.detail).toContain('exceeded');
  }, 10_000);

  it('the row count equals the DEFINITION count, whatever the probes do', async () => {
    // The single load-bearing invariant, stated directly.
    const defs = [
      def('a', ok),
      def('b', () => Promise.reject(new Error('x'))),
      def('c', () => Promise.resolve({ state: 'half-built', direction: 'receive-only', detail: 'send has no caller' })),
      def('d', () => Promise.resolve({ state: 'not-configured', direction: 'none', detail: 'config key absent' })),
    ];
    const report = await resolveChannels(defs, FIXED_NOW);
    expect(report.channels).toHaveLength(defs.length);
    expect(report.channels.map(c => c.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('channel registry — the vocabulary is wide enough to be honest', () => {
  it('represents half-built: receive works, send does not', async () => {
    // The real case: a purpose-built peer protocol whose send half has no executing caller.
    // A binary up/down registry would have shown this as usable and cost real time mid-outage.
    const report = await resolveChannels([
      def('a2a-telegram', () => Promise.resolve({
        state: 'half-built', direction: 'receive-only',
        detail: 'inbound hook is wired; the send function has no executing caller',
      })),
    ], FIXED_NOW);

    const c = report.channels[0];
    expect(c.state).toBe('half-built');
    expect(c.direction).toBe('receive-only');
    expect(report.summary.working).toBe(0);
  });

  it('distinguishes reachable-no-credential from broken', async () => {
    const report = await resolveChannels([
      def('peer-http', () => Promise.resolve({
        state: 'reachable-no-credential', direction: 'none',
        detail: 'endpoint answers; no credential held for its authenticated routes',
      })),
    ], FIXED_NOW);
    expect(report.channels[0].state).toBe('reachable-no-credential');
  });

  it('distinguishes not-configured (off) from broken', async () => {
    // Off is a decision, not a fault. Conflating them manufactures false alarms.
    const report = await resolveChannels([
      def('dispatch', () => Promise.resolve({
        state: 'not-configured', direction: 'none', detail: 'no config key on this agent; never constructed',
      })),
    ], FIXED_NOW);
    expect(report.channels[0].state).toBe('not-configured');
    expect(report.summary.unknown).toBe(0); // off is KNOWN, not undetermined
  });

  it('UNKNOWN is never counted as unusable — "could not tell" is not "broken"', async () => {
    // Collapsing these is the same error as collapsing "no row" with "healthy", pointing the other way.
    const report = await resolveChannels([
      def('cant-tell', () => Promise.reject(new Error('no route to host'))),
      def('really-broken', () => Promise.resolve({ state: 'broken', direction: 'none', detail: 'refused' })),
    ], FIXED_NOW);

    expect(report.summary.unknown).toBe(1);
    expect(report.summary.unusable).toBe(1);
  });

  it('every verdict carries evidence — a state without a detail is not acceptable', async () => {
    const report = await resolveChannels([
      def('a', ok),
      def('b', () => Promise.reject(new Error('down'))),
      def('c', () => Promise.resolve({ state: 'broken', direction: 'none', detail: 'refused connection' })),
    ], FIXED_NOW);
    for (const c of report.channels) {
      expect(c.detail.length).toBeGreaterThan(0);
    }
  });

  /**
   * Dead-check guard. Every assertion above would pass against a resolver that labelled everything
   * `unknown`, or against an empty definition list. Assert the resolver actually discriminates.
   */
  it('discriminates — it is not stuck on one verdict, and it reports the healthy case', async () => {
    const report = await resolveChannels([
      def('good', ok),
      def('bad', () => Promise.resolve({ state: 'broken', direction: 'none', detail: 'refused' })),
      def('partial', () => Promise.resolve({ state: 'half-built', direction: 'receive-only', detail: 'no sender' })),
      def('dunno', () => Promise.reject(new Error('?'))),
    ], FIXED_NOW);

    expect(new Set(report.channels.map(c => c.state))).toEqual(
      new Set(['working', 'broken', 'half-built', 'unknown']),
    );
    expect(report.summary).toEqual({ total: 4, working: 1, unusable: 2, unknown: 1 });
    expect(report.generatedAt).toBe('2026-07-26T20:30:00.000Z');
  });

  it('an EMPTY definition list is reported honestly, not as health', async () => {
    // Zero channels must not read as "nothing wrong" — the incident's shape at the whole-registry level.
    const report = await resolveChannels([], FIXED_NOW);
    expect(report.channels).toEqual([]);
    expect(report.summary).toEqual({ total: 0, working: 0, unusable: 0, unknown: 0 });
  });
});
