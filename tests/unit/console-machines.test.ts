/**
 * Console Machines page (docs/specs/console-features/capacity.md, "Machines"):
 * headline per state, the never-"offline" rule, the single-machine card, the
 * server liveness override, connections, this machine's parts and usage, and the
 * shipped page in jsdom (no stray "null", a card opens its sheet).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildMachinesPage, stateOf, loadVerdict, ropesFor, healthOf, usageOf, nameOf } from '../../dashboard/console/machines-model.js';

const NOW = Date.parse('2026-10-25T23:30:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const mach = (over: Record<string, unknown>) => ({ machineId: 'm1', nickname: 'Mac Studio', online: true, routerReceivedAt: minsAgo(0.2), loadAvg: 4, hardware: { cpuCores: 16 }, ...over });

describe('machines page model', () => {
  it('fails honestly', () => {
    expect(buildMachinesPage({ ok: false, reason: 'no answer within 5 seconds' }, null, NOW).ok).toBe(false);
  });
  it('all answering', () => {
    const p = buildMachinesPage(ok({ selfMachineId: 'm1', machines: [mach({}), mach({ machineId: 'm2', nickname: 'Mac Mini' })] }), null, NOW);
    expect(p.headline).toBe('Both machines are answering.');
    expect(p.machines[0].isSelf).toBe(true);
  });
  it('names a struggling machine, and one that is not answering, never "offline"', () => {
    const p = buildMachinesPage(ok({ machines: [mach({}), mach({ machineId: 'm2', nickname: 'Mama PC', loadAvg: 64 })] }), null, NOW);
    expect(p.headline).toBe('Mama PC is struggling.');
    const q = buildMachinesPage(ok({ machines: [mach({}), mach({ machineId: 'm3', nickname: 'Laptop', routerReceivedAt: minsAgo(40) })] }), null, NOW);
    expect(q.headline).toBe("Laptop isn't answering.");
    expect(JSON.stringify(q)).not.toMatch(/offline/i);
  });
  it('a machine with no evidence is unclear, not dead', () => {
    const p = buildMachinesPage(ok({ machines: [mach({}), mach({ machineId: 'm2', nickname: 'Laptop', routerReceivedAt: undefined })] }), null, NOW);
    expect(p.headline).toBe("I can't see Laptop clearly right now.");
  });
  it('a single-machine install gets one card', () => {
    const p = buildMachinesPage(ok({ enabled: false, machines: [] }), null, NOW);
    expect(p.single).toBe(true);
    expect(p.machines).toHaveLength(1);
    expect(p.headline).toBe('One machine, answering.');
  });
  it('the server liveness block wins over the estimate when present', () => {
    expect(stateOf(mach({ liveness: { state: 'struggling', evidenceAt: minsAgo(3) } }), NOW)).toMatchObject({ state: 'attn', label: 'struggling', estimated: false });
    expect(stateOf(mach({}), NOW).estimated).toBe(true);
  });
  it('load verdicts', () => {
    expect(loadVerdict(0.5)).toBe('ok'); expect(loadVerdict(1.5)).toBe('busy'); expect(loadVerdict(3)).toBe('overloaded'); expect(loadVerdict(undefined)).toBeNull();
  });
  it('connections in words, unknown when the health read failed', () => {
    const health = ok({ multiMachine: { syncStatus: { ropeHealth: [{ peer: 'm2', kind: 'tailscale', state: 'healthy', lastResultAt: NOW - 60_000 }, { peer: 'm2', kind: 'cloudflare', state: 'healthy', lastResultAt: null }] } } });
    const r = ropesFor('m2', health, NOW)!;
    expect(r.map((x) => x.kind)).toEqual(['Tailscale', 'Tunnel']);
    expect(r[1].state).toBe('unknown');
    expect(ropesFor('m2', { ok: false, reason: 'x' }, NOW)).toBeNull();
  });
  it('this machine’s parts and usage, honest on failure', () => {
    expect(healthOf(ok({ activeCapabilities: [{ label: 'A', status: 'active' }], issues: [] })).summary).toBe('All 1 parts working.');
    expect(healthOf(ok({ activeCapabilities: [], issues: [{ title: 'Broken' }] })).summary).toBe('1 part needs a look: Broken.');
    // A part whose own status says degraded is named with the failing probe from /health; "Safety & Trust" reads the shared safety-check count, never "All gates active".
    const sys = ok({ issues: [], activeCapabilities: [
      { label: 'Health Monitoring', status: 'active', metric: '15/16 probes passed', processes: [{ name: 'SystemReviewer', status: 'running', details: { status: 'degraded', message: '15/16 probes passed' } }] },
      { label: 'Safety & Trust', status: 'active', metric: 'All gates active', processes: [] },
      { label: 'Telegram', status: 'active', metric: '67 topics', processes: [] },
    ] });
    const health = ok({ systemReview: { failedProbes: [{ probeId: 'instar.guard-posture.anomalies', name: 'Guard Posture Anomalies' }] } });
    const guards = ok({ nickname: 'Mac Studio', guards: [{ key: 'monitoring.a.enabled', effective: 'off', offClass: 'diverged-from-default' }, { key: 'monitoring.b.enabled', effective: 'on-confirmed' }] });
    const h2 = healthOf(sys, { health, guards });
    expect(h2.summary).toBe('2 parts need a look: Health Monitoring, Safety & Trust. 1 of 3 working.');
    expect(h2.rows.find((r) => r.main === 'Health Monitoring')!.sub).toContain('failing: Guard Posture Anomalies');
    expect(h2.rows.find((r) => r.main === 'Safety & Trust')!.sub).toBe('1 safety check needs a look on Mac Studio');
    expect(JSON.stringify(h2)).not.toContain('All gates active');
    // Usage: every figure is of one core, and an ended session's last sample is never shown as "now".
    const u2 = usageOf(ok({ sources: [{ source: 'aggregate', currentCpuPercent: 50, currentRssBytes: 12e9, peakCpuPercent: 110 }, { source: 'session:live', currentCpuPercent: 7, currentRssBytes: 5e8 }, { source: 'session:gone', currentCpuPercent: 77, currentRssBytes: 3e8 }] }), { live: 'Fix it' }, { running: new Set(['live']), cores: 16 });
    expect(u2.summary).toContain('50% of one core');
    expect(u2.summary).toContain('this machine has 16');
    expect(u2.rows.map((r) => r.main)).toEqual(['Fix it', '1 session that ended in the last hour']);
    expect(JSON.stringify(u2.rows)).not.toContain('77%');
    expect(healthOf(ok({ activeCapabilities: [] })).ok).toBe(false);
    const u = usageOf(ok({ sources: [{ source: 'aggregate', currentCpuPercent: 55, currentRssBytes: 12e9, peakCpuPercent: 61 }, { source: 'session:abc', currentCpuPercent: 3, currentRssBytes: 5e8 }] }), { abc: 'Fix it' });
    expect(u.summary).toContain('55% of one core');
    expect(u.rows[0].main).toBe('Fix it');
  });
});

describe('resource rows are named', () => {
  it('matches the sampler\'s shortened session id to the full one, and never invents a name', () => {
    const names = { '07db2faf-c630-4da6-84d6-7cdcf17b3f76': 'Bug: login loop' };
    expect(nameOf('07db2faf-c630-4da6-84d6-7cdcf17b', names)).toBe('Bug: login loop');
    expect(nameOf('07db2faf-c630-4da6-84d6-7cdcf17b3f76', names)).toBe('Bug: login loop');
    expect(nameOf('zzzz', names)).toBe('A session');
    expect(usageOf(ok({ sources: [{ source: 'session:07db2faf-c630-4da6-84d6-7cdcf17b', currentCpuPercent: 7, currentRssBytes: 3e8 }] }), names).rows[0].main).toBe('Bug: login loop');
  });
});

describe('machines page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());
  it('renders cards without stray text and opens a machine sheet', async () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/capacity/machines' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const table: Record<string, unknown> = {
      '/sessions': { sessions: [] },
      '/health': { project: { name: 'echo' } },
      '/pool': { selfMachineId: 'm1', machines: [mach({ routerReceivedAt: new Date().toISOString() }), mach({ machineId: 'm2', nickname: 'Mac Mini', routerReceivedAt: new Date().toISOString() })] },
      '/guards': { summary: { offDeviant: 0, loadBearingGapKeys: [] }, guards: [] },
      '/sessions?scope=pool': { sessions: [{ id: 's1', name: 'Fix it', status: 'running', machineId: 'm1' }], pool: { failed: [] } },
      '/systems/status': { activeCapabilities: [{ label: 'Session Recovery', status: 'active' }], issues: [] },
      '/resources/summary?sinceHours=1': { sources: [] },
    };
    g.fetch = async (url: string) => { const b = table[url]; return b === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(b)) }; };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('Both machines are answering.');
    expect(doc.querySelector('#main')!.textContent).not.toContain('null');
    expect(doc.querySelectorAll('.machine-card')).toHaveLength(2);
    (doc.querySelector('.machine-card') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    expect(doc.querySelector('.sheet-title')!.textContent).toBe('Mac Studio');
    expect(doc.querySelector('.sheet-body')!.textContent).toContain('All 1 parts working.');
  });
});
