import { describe, it, expect } from 'vitest';
// @ts-expect-error plain proof script
import { baselineProblem, measureNativeCalls, nativeWatch } from '../../scripts/locked-proof/native-observation.mjs';
// @ts-expect-error plain proof script
import { CASES, runCase, judge } from '../../scripts/locked-proof/lib.mjs';
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const key = '12345678-1234-1234-1234-123456789abc.0';
const start = 'Tue Nov 17 16:00:00 2026';
function evidence() {
  const server = (instanceId: string, pid: number) => ({ readStartedAt: 1, listener: { pid, start }, loginSession: 'old',
    ledger: { schema: 1, available: true, complete: true, reason: null, nodePid: pid, instanceId, sequence: 0, entries: [] as any[] } });
  const base = { storeId: 'c'.repeat(64), isolated: true, complete: true, servers: [server(A, 1), server(B, 2)], actors: [] as any[] };
  const population = structuredClone(base);
  const actor = { sequence: 1, attemptId: `${A}:1`, key, storeId: 'c'.repeat(64), pid: 42, spawn: 'spawned', exit: 'pending', exitCode: null, signal: null };
  population.servers[0].ledger.entries.push(actor); population.servers[0].ledger.sequence = 1;
  population.actors.push({ pid: 42, start, command: `/proof/instar-desktop-host relock-guard /proof/store ${key}` });
  const watch = { schema: 1, complete: true, attemptId: `${A}:1`, key, pid: 42, start: `${Date.parse(start) / 1000}.123`,
    phase: 'watch', count: 1, checkpointCount: 1 };
  const marker = { state: 'watching', guardPid: 42, guardStart: watch.start, guardWatchObservation: watch };
  const final = structuredClone(population);
  final.actors = [];
  final.servers.forEach(s => { s.readStartedAt = 101; s.loginSession = 'new'; });
  Object.assign(final.servers[0].ledger.entries[0], { exit: 'exited', exitCode: 0 });
  const ev = { id: '12.12', grantRequestId: key.slice(0, -2), guardBaseline: base, person: { cuedAt: 20, returnedAt: 99, doneAt: 100 },
    samples: [{ t: 10, markers: { [key]: marker }, guardPopulation: population }],
    final: { markers: { [key]: { ...marker, state: 'closed-not-applicable',
      guardFinalObservation: { ...watch, phase: 'final', terminal: 'closed-not-applicable' } } } } };
  return { ev, final };
}
describe('strict native lock-call measurement', () => {
  it('accepts only a complete single-child history and same-guard zero counter delta', () => {
    const { ev, final } = evidence();
    expect(measureNativeCalls(ev, final)).toMatchObject({ complete: true, lockCalls: 0, exactExit: true });
    ev.id = '12.13'; expect(measureNativeCalls(ev, final).complete).toBe(true);
    final.servers[0].loginSession = 'old'; expect(measureNativeCalls(ev, final).complete).toBe(false);
  });
  it('preserves a nonzero dispatch delta rather than erasing it', () => {
    const { ev, final } = evidence(); ev.final.markers[key].guardFinalObservation.count++;
    expect(measureNativeCalls(ev, final).lockCalls).toBe(1);
  });
  it('rejects all missing actors, discontinuities, incomplete witnesses and early reads', () => {
    const changes = [
      (e: any, f: any) => { e.guardBaseline.servers[0].ledger.instanceId = ''; },
      (e: any, f: any) => { f.servers[0].listener.start = 'unreadable'; },
      (e: any, f: any) => { e.grantRequestId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; },
      (e: any, f: any) => { f.servers[0].ledger.entries[0].storeId = 'd'.repeat(64); },
      (e: any, f: any) => { e.guardBaseline.isolated = false; },
      (e: any, f: any) => { e.guardBaseline.servers[1].ledger.available = false; },
      (e: any, f: any) => { f.servers[1].ledger.instanceId = 'restarted'; },
      (e: any, f: any) => { f.servers[0].ledger.complete = false; },
      (e: any, f: any) => { f.servers[0].ledger.entries[0].spawn = 'error'; },
      (e: any, f: any) => { f.servers[0].ledger.entries[0].exit = 'pending'; },
      (e: any, f: any) => { f.servers[0].ledger.entries[0].signal = 'SIGKILL'; },
      (e: any, f: any) => { f.servers[0].readStartedAt = 99; },
      (e: any, f: any) => { f.servers[1].readStartedAt = 99; },
      (e: any, f: any) => { f.actors.push({ pid: 99 }); },
      (e: any, f: any) => { e.samples[0].guardPopulation.complete = false; },
      (e: any, f: any) => { delete e.person.returnedAt; },
      (e: any, f: any) => { e.person.cuedAt = 1; },
      (e: any, f: any) => { delete e.final.markers[key].guardFinalObservation; },
      (e: any, f: any) => { e.final.markers[key].guardFinalObservation.complete = false; },
      (e: any, f: any) => { e.final.markers[key].guardFinalObservation.start = 'wrong'; },
      (e: any, f: any) => { e.final.markers[key].guardFinalObservation.checkpointCount = 0; },
      (e: any, f: any) => { e.final.markers[key].guardReplacements = 1; },
      (e: any, f: any) => { f.servers[0].ledger.entries.push({ ...f.servers[0].ledger.entries[0], sequence: 2, attemptId: `${A}:2` }); f.servers[0].ledger.sequence++; },
    ];
    for (const change of changes) {
      const { ev, final } = evidence(); change(ev, final);
      expect(measureNativeCalls(ev, final).complete, String(change)).toBe(false);
    }
  });
  it('does not accept scalar zero supplied without structured measurement', () => {
    const c = CASES.find((c: any) => c.id === '12.12');
    const { ev } = evidence();
    expect(judge(c, { ...ev, extra: { lockCalls: 0 } }).pass).toBe(false);
  });
  it('baseline accounts for all living actors instead of ignoring prior generations', () => {
    const { ev } = evidence();
    expect(baselineProblem(ev.guardBaseline)).toBeNull();
    expect(baselineProblem(ev.samples[0].guardPopulation)).toContain('pre-baseline');
  });
  it.each(['12.12', '12.13'])('combined actual runCase %s completes human transitions before both final reads', async id => {
    const fixture = evidence();
    let now = 1_000_000, stopped = false, departed = false, cueAt: number | undefined;
    const c = CASES.find((c: any) => c.id === id);
    const watch = fixture.ev.samples[0].markers[key];
    const terminal = fixture.ev.final.markers[key];
    const current = () => {
      const elapsed = cueAt === undefined ? -1 : now - cueAt;
      const away = id === '12.12' ? elapsed >= 1_000 && elapsed < 40_000 : departed && elapsed < 5_000;
      const closed = id === '12.12' ? elapsed >= 1_000 : departed;
      const population = structuredClone(closed ? fixture.final : fixture.ev.samples[0].guardPopulation);
      population.servers.forEach(s => { s.readStartedAt = now; s.loginSession = departed && !away ? 'new' : 'old'; });
      return { now, consoleOwner: away ? (id === '12.13' ? 'root' : 'operator') : 'instarproof',
        lockState: 'locked', dirty: false, markers: { [key]: { ...(closed ? terminal : watch),
          enterPendingAt: 1_000_000, state: closed ? 'closed-not-applicable' : stopped ? 'watching' : 'owed' } },
        guardPopulation: population, processesGone: closed, events: away ? [] : ['proof-user-console'] };
    };
    const target = { now: () => now, sleep: async (ms: number) => { now += ms; }, prepare: async () => {},
      beginGuardObservation: async () => fixture.ev.guardBaseline, openGrant: async () => ({ requestId: key.slice(0, -2) }),
      typePassword: async () => ({ sent: true }),
      act: async (action: string) => {
        if (action === 'stop-viewer') stopped = true;
        if (action === 'logout-proof-user') { departed = true; now += 10; return { departed: true, departedAt: now, producersGone: true }; }
        return {};
      },
      snapshot: async () => { now += 10; return current(); },
      askPerson: async (_text: string, cue: any) => {
        expect(cue.validUntil).toBeGreaterThan(now);
        expect(cue.text).toContain('START BY');
        cueAt = now; return { channel: 'console', outcome: 'console-only', sent: false };
      }, settled: (snap: any) => snap.markers[key].state === 'closed-not-applicable',
      extraEvidence: async (_c: any, actual: any) => {
        expect(actual.person.returnedAt).toBeDefined();
        expect(actual.person.doneAt).toBe(actual.person.returnedAt);
        now += 1; const final = current().guardPopulation;
        expect(final.servers.every(s => s.readStartedAt > actual.person.doneAt)).toBe(true);
        return { guardFinalPopulation: final, nativeLockObservation: measureNativeCalls(actual, final) };
      }, recover: async () => [] };
    const result = await runCase(c, target, { pollMs: 500 });
    expect(result.error).toBeUndefined();
    expect(result.verdict).toEqual({ pass: true, reasons: [] });
    expect(result.extra.nativeLockObservation).toMatchObject({ complete: true, lockCalls: 0 });
    if (id === '12.13') expect(result.guardCheckpoint.t).toBeLessThan(result.fired.find((f: any) => f.action === 'logout-proof-user').t);
  });

  it('actual runCase records baseline before grant and gates the cue on a positive native checkpoint', async () => {
    const { ev } = evidence();
    const order: string[] = []; let t = 1; let observations = 0;
    const c = { id: '12.12', gate: 'P12', password: false, inject: [], final: 'not-judged', noLockCall: true,
      person: { text: 'test', until: 'done', timeoutMs: 1 }, timeoutMs: 5 };
    const target = { now: () => t, sleep: async () => { t++; }, prepare: async () => {},
      beginGuardObservation: async () => { order.push('baseline'); return ev.guardBaseline; },
      openGrant: async () => { order.push('grant'); return {}; },
      snapshot: async () => {
        observations++;
        return { now: t, ...ev.samples[0], markers: observations === 1 ? {} : ev.samples[0].markers, events: ['done'] };
      },
      askPerson: async () => { expect(observations).toBeGreaterThan(1); order.push('cue'); return { channel: 'console', outcome: 'console-only', sent: false }; },
      settled: () => true, extraEvidence: async (_c: any, actual: any) => {
        expect(actual.guardBaseline).toEqual(ev.guardBaseline);
        expect(nativeWatch(actual.samples[1])).toBeTruthy(); return {};
      }, recover: async () => [] };
    const actual = await runCase(c, target, { pollMs: 1 });
    expect(order).toEqual(['baseline', 'grant', 'cue']);
    expect(actual.samples[1].guardPopulation).toEqual(ev.samples[0].guardPopulation);
    // This base branch lacks the human-roundtrip patch: its missing returnedAt must still fail.
    expect(actual.verdict.pass).toBe(false);
  });
});
