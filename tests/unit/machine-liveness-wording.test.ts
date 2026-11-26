/**
 * trustworthy-machine-load A5 — the one wording template, and the pin that NO
 * renderer says "offline" without positive offline evidence. Covers the pure
 * line formatter, the pool empty-state classifier (the sessions view), and the
 * dashboard's shipped glance component.
 */
import { describe, expect, it } from 'vitest';
import { deriveLiveness, formatLivenessLine, type DirectAttempt } from '../../src/core/machineLiveness.js';
import { classifyMachineEmptyState } from '../../src/server/poolEmptyState.js';
import { machineRowText, machineRecordNode } from '../../dashboard/glance.js';

const NOW = 1_800_000_000_000;
const THRESH = 15 * 60_000;
const base = { isSelf: false, nowMs: NOW, failoverThresholdMs: THRESH, attempts: [] as DirectAttempt[] };

const STATES = {
  live: deriveLiveness({ ...base, lastDirectSuccessAtMs: NOW - 20_000 }),
  unreachable: deriveLiveness({ ...base, attempts: [{ atMs: NOW - 1000, ok: false, shape: 'timeout' }], savedDirectAtMs: NOW - 40 * 60_000 }),
  stale: deriveLiveness({ ...base, relayedOriginAtMs: NOW - 50 * 60_000 }),
  unknown: deriveLiveness(base),
};

describe('formatLivenessLine — one template', () => {
  it('renders `<liveness>, last evidence <age> ago from <source>` and never "offline"', () => {
    expect(formatLivenessLine(STATES.live)).toBe('live, last evidence 20 s ago from a direct check from this machine');
    expect(formatLivenessLine(STATES.unreachable)).toBe('unreachable (silent), last evidence 40 min ago from a saved record of a direct check');
    expect(formatLivenessLine(STATES.stale)).toBe('stale, last evidence 50 min ago from a relayed heartbeat file');
    expect(formatLivenessLine(STATES.unknown)).toBe('unknown — no evidence yet');
    for (const l of Object.values(STATES)) expect(formatLivenessLine(l)).not.toMatch(/offline/i);
  });
});

describe('classifyMachineEmptyState with liveness (the sessions view)', () => {
  it('never says offline from evidence alone; stale/unknown are first-class kinds', () => {
    const nick = (id: string) => (id === 'm_mini' ? 'Mac Mini' : id);
    const run = (liveness: typeof STATES.live, failedReason: string | null = null, online = false) =>
      classifyMachineEmptyState({ online, failedReason, liveness, nicknameOf: nick }, NOW);
    expect(run(STATES.live, null, true)).toMatchObject({ kind: 'online', text: 'online — no active sessions' });
    expect(run(STATES.unreachable, 'timeout')).toMatchObject({ kind: 'unreachable', text: 'unreachable (silent), last evidence 40 min ago from a saved record of a direct check' });
    expect(run(STATES.stale, 'offline')).toMatchObject({ kind: 'stale', text: 'stale, last evidence 50 min ago from a relayed heartbeat file' });
    expect(run(STATES.unknown, 'offline')).toMatchObject({ kind: 'unknown', text: 'unknown — no evidence yet' });
    expect(run(STATES.unknown, 'no-known-url')).toMatchObject({ kind: 'unknown', text: 'no known address for this machine' });
    // Registry live, but THIS request failed: both facts named, still not "offline".
    expect(run(STATES.live, 'timeout', true).text).toBe('did not answer this request (timeout); last reached 20 s ago');
    const withSighting = deriveLiveness({ ...base, peerSighting: { observerMachineId: 'm_mini', ageMs: 60_000, receivedAtMs: NOW } });
    expect(run(withSighting, 'offline').text).toBe('unknown — no evidence yet; Mac Mini reached it 1 min ago');
    for (const l of Object.values(STATES)) {
      for (const reason of [null, 'offline', 'timeout', 'error']) {
        expect(run(l, reason).text).not.toMatch(/offline/i);
      }
    }
  });

  it('keeps the legacy path byte-identical when no liveness is supplied (older callers)', () => {
    const s = classifyMachineEmptyState({ online: false, failedReason: 'offline', routerReceivedAt: new Date(NOW - 7200_000).toISOString() }, NOW);
    expect(s).toMatchObject({ kind: 'offline', text: 'offline since 2h ago' });
  });
});

describe('dashboard glance (shipped component) honours the evidence', () => {
  const doc = {
    createElement(tag: string) {
      const el: Record<string, unknown> & { children: unknown[]; appendChild: (c: unknown) => void; setAttribute: () => void; addEventListener: () => void } = {
        tag, className: '', textContent: '', children: [], value: '',
        appendChild(c: unknown) { this.children.push(c); }, setAttribute() {}, addEventListener() {},
      };
      return el;
    },
  };
  const texts = (node: unknown): string => {
    const n = node as { textContent?: string; children?: unknown[] };
    return [n.textContent ?? '', ...((n.children ?? []).map(texts))].join(' ');
  };

  it('an unknown peer reads "Unknown — no contact yet", a stale one "Not checked recently", an unreachable one names the shape; none say Offline', () => {
    const mk = (liveness: unknown, livenessLine: string, extra: Record<string, unknown> = {}) => ({ machineId: 'm_pc', nickname: 'Mama PC', online: false, liveness, livenessLine, ...extra });
    expect(machineRowText(mk(STATES.unknown, formatLivenessLine(STATES.unknown)))).toBe('Mama PC — Unknown — no contact yet');
    expect(machineRowText(mk(STATES.stale, formatLivenessLine(STATES.stale)))).toBe('Mama PC — Not checked recently — last evidence 50 min ago from a relayed heartbeat file');
    expect(machineRowText(mk(STATES.unreachable, formatLivenessLine(STATES.unreachable)))).toBe('Mama PC — Unreachable — not answering (last evidence 40 min ago from a saved record of a direct check)');
    for (const l of Object.values(STATES)) expect(machineRowText(mk(l, formatLivenessLine(l)))).not.toMatch(/offline/i);
    // Legacy server (no liveness field) keeps the old word.
    expect(machineRowText({ machineId: 'm_pc', nickname: 'Mama PC', online: false })).toBe('Mama PC — Offline');
  });

  it('the record shows the evidence line and the load verdict with its age (B1/B2 surfaced)', () => {
    const m = {
      machineId: 'm_pc', nickname: 'Mama PC', online: true, liveness: STATES.live, livenessLine: formatLivenessLine(STATES.live),
      loadVerdict: 'saturated', loadReportAgeMs: 12_000,
      loadReport: { cpuIdlePct: 4, memAvailablePct: 22, eventLoopLagP99Ms: 410 },
    };
    const out = texts(machineRecordNode(doc as unknown as Document, m));
    expect(out).toContain('Evidence');
    expect(out).toContain('live, last evidence 20 s ago');
    // The record clamps long values for display; assert the head and the lag separately.
    expect(out).toContain('overloaded — 96% CPU busy, 22% memory free');
    expect(out).toContain('server lag 410 ms');
    const unknown = texts(machineRecordNode(doc as unknown as Document, { ...m, loadVerdict: 'unknown', loadReport: undefined }));
    expect(unknown).toContain('Load');
    expect(unknown).toContain('unknown');
    expect(unknown).not.toContain('as of');
  });
});
