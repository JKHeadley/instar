/**
 * Console Machines page (docs/specs/console-features/capacity.md, "Machines"):
 * headline per state, the never-"offline" rule, the single-machine card, the
 * server liveness override, connections, this machine's parts and usage, and the
 * shipped page in jsdom (no stray "null", a card opens its sheet).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildMachinesPage, stateOf, loadVerdict, ropesFor, healthOf, usageOf, poolUsageOf } from '../../dashboard/console/machines-model.js';

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
    expect(p.machines.find((m) => m.isSelf)!.name).toBe('Mac Studio');
  });
  it('order never depends on which machine served the page: trouble first, then the leading machine', () => {
    const pool = (self: string) => ok({ selfMachineId: self, router: { holder: 'm2' }, machines: [mach({}), mach({ machineId: 'm2', nickname: 'Mac Mini' }), mach({ machineId: 'm3', nickname: 'Laptop' })] });
    const a = buildMachinesPage(pool('m1'), null, NOW).machines.map((m) => m.name);
    const b = buildMachinesPage(pool('m3'), null, NOW).machines.map((m) => m.name);
    expect(a).toEqual(['Mac Mini', 'Laptop', 'Mac Studio']);
    expect(b).toEqual(a);
  });
  it('poolUsageOf reads every machine from the pooled resources answer, and an older single-machine answer', () => {
    const u = poolUsageOf(ok({ machine: 'Mac Studio', headline: 'x', combined: { headline: '2 of 3 machines · 8.1 GB of memory', busiest: 'Busiest: Mac Studio, 43% CPU', notAnswering: ['Mama PC'] }, machines: [
      { name: 'Mama PC', state: 'not-answering', line: 'Not answering', sessions: [] },
      { name: 'Mac Studio', state: 'answering', line: '43% CPU · 6.1 GB', server: { name: 'The agent server', cpuPercent: 4, memoryBytes: 1e9 }, sessions: [{ name: 'build', cpuPercent: 20, memoryBytes: 5e8 }] },
    ] }));
    expect(u).toMatchObject({ ok: true, pooled: true, summary: '2 of 3 machines · 8.1 GB of memory', notAnswering: ['Mama PC'] });
    expect(u.byName['Mama PC']).toEqual({ line: 'Not answering', state: 'not-answering', rows: [] });
    expect(u.byName['Mac Studio'].rows.map((r: { main: string }) => r.main)).toEqual(['The agent server', 'build']);
    const old = poolUsageOf(ok({ machine: 'Mac Studio', enabled: true, headline: 'Instar is using 4% CPU', sessions: [] }));
    expect(old).toMatchObject({ ok: true, pooled: false, summary: 'Instar is using 4% CPU' });
    expect(Object.keys(old.byName)).toEqual(['Mac Studio']);
    expect(poolUsageOf({ ok: false, reason: 'timed out' })).toEqual({ ok: false, reason: 'timed out' });
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
    expect(healthOf(ok({ activeCapabilities: [], issues: [{ title: 'Broken' }] })).summary).toBe('1 part needs a look.');
    expect(healthOf(ok({ activeCapabilities: [] })).ok).toBe(false);
    const u = usageOf(ok({ sources: [{ source: 'aggregate', currentCpuPercent: 55, currentRssBytes: 12e9, peakCpuPercent: 61 }, { source: 'session:abc', currentCpuPercent: 3, currentRssBytes: 5e8 }] }), { abc: 'Fix it' });
    expect(u.summary).toContain('55% CPU');
    expect(u.rows[0].main).toBe('Fix it');
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
      '/mobile/resources': { machine: 'Mac Studio', enabled: true, headline: 'x', scope: 'pool', combined: { headline: 'All 2 machines · 3.0 GB of memory · 1 session', busiest: 'Busiest: Mac Mini, 30% CPU' }, machines: [
        { name: 'Mac Studio', state: 'answering', line: '12% CPU · 1.0 GB', sessions: [{ name: 'Fix it', cpuPercent: 8, memoryBytes: 5e8 }] },
        { name: 'Mac Mini', state: 'answering', line: '30% CPU · 2.0 GB', sessions: [] },
      ] },
    };
    g.fetch = async (url: string) => { const b = table[url]; return b === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(b)) }; };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('Both machines are answering.');
    expect(doc.querySelector('#main')!.textContent).not.toContain('null');
    expect(doc.querySelectorAll('.machine-card')).toHaveLength(2);
    const main = doc.querySelector('#main')!.textContent!;
    expect(main).not.toMatch(/this one|this machine/i);
    expect(main).toContain('All 2 machines · 3.0 GB of memory · 1 session');
    const card = (name: string) => [...doc.querySelectorAll('.machine-card')].find((c) => c.querySelector('.mc-name')!.textContent === name) as HTMLButtonElement;
    expect(card('Mac Mini').textContent).toContain('Using 30% CPU · 2.0 GB');
    card('Mac Studio').click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    expect(doc.querySelector('.sheet-title')!.textContent).toBe('Mac Studio');
    expect(doc.querySelector('.sheet-body')!.textContent).toContain('All 1 parts working.');
    expect(doc.querySelector('.sheet-body')!.textContent).toContain('Fix it');
    // A machine other than the one serving the page shows its resources and a Remote desktop link too.
    card('Mac Mini').click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    const sheetBody = [...doc.querySelectorAll('.sheet-body')].pop()!;
    expect(sheetBody.textContent).toContain('30% CPU · 2.0 GB');
    expect(sheetBody.querySelector('a[href="/dashboard/desktop.html?machineId=m2"]')!.textContent).toBe('Open Mac Mini');
  });
});

describe('machineCarePool (CMT-1199)', () => {
  it('gives each machine its own line, names the ones it cannot read, and keeps the watch-only header', async () => {
    const { machineCarePool } = await import('../../dashboard/console/machines-model.js');
    expect(machineCarePool({ ok: false })).toBeNull();
    const v = machineCarePool({ ok: true, data: {
      scope: 'pool',
      machines: [
        { machineId: 'm_self', machineNickname: 'Studio', self: true, state: { uptimeDays: 2, safetyHolds: [], lastRehearsal: null } },
        { machineId: 'm_mini', machineNickname: 'Mac Mini', self: false, state: { uptimeDays: 9, safetyHolds: [{ active: true, label: 'A person using the machine now' }], lastRehearsal: { outcome: 'would-roll' } } },
      ],
      pool: { failed: [{ machineId: 'm_pc', machineNickname: 'Mama PC', reason: 'route-missing' }, { machineId: 'm_x', reason: 'peer-unreachable' }] },
    } });
    expect(v.header).toBe('Restart care is watching only, nothing restarts.');
    expect(v.byMachine.m_self).toBe('Up 2 days · no practice run yet');
    expect(v.byMachine.m_mini).toBe('Up 9 days · practice run: would have waited a night · holding: A person using the machine now');
    expect(v.selfLine).toBe('Up 2 days · no practice run yet');
    expect(v.missing).toEqual(['Mama PC: can’t tell, on an older version', 'a machine with no name yet: can’t tell, did not answer']);
  });

  it('treats an older server that ignores scope=pool as this machine only', async () => {
    const { machineCarePool } = await import('../../dashboard/console/machines-model.js');
    const v = machineCarePool({ ok: true, data: { uptimeDays: 3, safetyHolds: [], lastRehearsal: { outcome: 'would-restart' } } });
    expect(v).toEqual({ header: 'Restart care is watching only, nothing restarts.', byMachine: {}, selfLine: 'Up 3 days · practice run: would have restarted', missing: [] });
  });
});

describe('machineCareLine', () => {
  it('says plainly that nothing restarts, and reports the last practice run', async () => {
    const { machineCareLine } = await import('../../dashboard/console/machines-model.js');
    expect(machineCareLine({ ok: false })).toBeNull();
    expect(machineCareLine({ ok: true, data: { uptimeDays: 3.2, safetyHolds: [], lastRehearsal: null } })).toBe('Restart care is watching only, nothing restarts. · Up 3.2 days · No practice run yet');
    const line = machineCareLine({ ok: true, data: { uptimeDays: 9, safetyHolds: [{ active: true, label: 'A person using the machine now' }, { active: false, label: 'x' }], lastRehearsal: { outcome: 'would-roll' } } });
    expect(line).toContain('would have waited a night');
    expect(line).toContain('Holding now: A person using the machine now');
  });
});
