/** Timeline regressions only. Never touches a real desktop account. */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
// @ts-expect-error standalone proof harness
import { CASES, runCase, judge } from '../../scripts/locked-proof/lib.mjs';
// @ts-expect-error standalone proof harness
import { RealTarget } from '../../scripts/locked-proof/driver.mjs';

const byId = (id: string) => CASES.find((c: { id: string }) => c.id === id);
const KEY = 'request.0';
const BASE = 1_000_000;
function world(id: string, options: { away?: number; back?: number; unknown?: [number, number]; transit?: [number, number]; watchDelay?: number; preCueUnlock?: boolean; noWatch?: boolean; lateUnlock?: number } = {}) {
  let now = BASE;
  let stopAt: number | undefined;
  let cueAt: number | undefined;
  let logoutAt: number | undefined;
  const actions: Array<{ action: string; t: number }> = [];
  const cues: Array<{ text: string; t: number }> = [];
  const samples: any[] = [];
  const watchStart = () => (stopAt ?? BASE) + (options.watchDelay ?? 0);
  const target = {
    now: () => now, sleep: async (ms: number) => { now += ms; }, prepare: async () => {}, openGrant: async () => ({}),
    typePassword: async () => ({ sent: true }), calibration: () => null,
    act: async (action: string) => {
      actions.push({ action, t: now });
      if (action === 'stop-viewer' || action === 'revoke') stopAt = now;
      if (action === 'logout-proof-user') { logoutAt = now; now += 1_000; return { departed: true, departedAt: now, producersGone: true }; }
      return {};
    },
    askPerson: async (text: string) => { cueAt = now; cues.push({ text, t: now }); },
    snapshot: async () => {
      now += 10; // Each read is genuinely later than the cue/action it follows.
      const elapsed = cueAt === undefined ? -1 : now - cueAt;
      let owner = 'instarproof';
      if (id === '12.12' && elapsed >= (options.away ?? 1_000) && elapsed < (options.back ?? 40_000)) owner = 'operator';
      if (id === '12.12' && options.unknown && elapsed >= options.unknown[0] && elapsed < options.unknown[1]) owner = '';
      if (id === '12.12' && options.transit && elapsed >= options.transit[0] && elapsed < options.transit[1]) owner = 'loginwindow';
      if (id === '12.13' && logoutAt !== undefined && elapsed < (options.back ?? 5_000)) owner = 'root';
      let state = stopAt === undefined ? 'owed' : now < watchStart() ? 'executing' : now < watchStart() + 120_000 ? 'watching' : 'relocked';
      if ((id === '12.12' && elapsed >= (options.away ?? 1_000)) || (id === '12.13' && logoutAt !== undefined)) state = 'closed-not-applicable';
      let lockState = 'locked';
      if (options.preCueUnlock && cueAt === undefined && now >= watchStart() + 30_000) lockState = 'unlocked';
      if (id.startsWith('15.') && cueAt !== undefined && elapsed >= (options.lateUnlock ?? 500)
          && (id === '15.11' || elapsed < (options.lateUnlock ?? 500) + 1_500)) lockState = 'unlocked';
      const marker = { state, enterPendingAt: BASE - 100, ...(stopAt !== undefined && !options.noWatch && now >= watchStart() ? { watchStart: watchStart() } : {}) };
      const snap = { now, consoleOwner: owner, lockState, dirty: false, markers: { [KEY]: marker },
        events: owner === 'instarproof' ? ['proof-user-console'] : [], processesGone: true };
      samples.push(snap);
      return snap;
    },
    settled: (snap: any) => ['closed-not-applicable', 'relocked'].includes(snap.markers[KEY].state),
    extraEvidence: async () => ({}), // No invented lock-call measurement, even in successful human timelines.
    recover: async () => [],
  };
  return { target, actions, cues, samples, run: () => runCase(byId(id), target, { pollMs: 500 }) };
}

describe('human proof timelines', () => {
  it('waits through the other account and its return, while keeping no-lock-call evidence unmeasured', async () => {
    const w = world('12.12');
    const ev = await w.run();
    expect(ev.person.returnedAt - ev.person.awayAt).toBeGreaterThanOrEqual(30_000);
    expect(ev.person.doneAt).toBeGreaterThanOrEqual(w.cues[0].t + 40_000);
    expect(ev.verdict.pass).toBe(false);
    expect(ev.verdict.reasons).toContain('not measured: lock calls against another session (no observable source yet)');
  });
  it('cannot finish at a closed marker while the person is still away', async () => {
    const ev = await world('12.12', { back: Infinity }).run();
    expect(ev.person.doneAt).toBeUndefined();
    expect(ev.verdict.pass).toBe(false);
  });
  it('rejects returning before the 30 second dwell', async () => {
    const ev = await world('12.12', { back: 10_000 }).run();
    expect(ev.error).toContain('returned before');
  });
  it('does not count unknown console readings as time confirmed away', async () => {
    const ev = await world('12.12', { back: 40_000, unknown: [15_000, 25_000] }).run();
    expect(ev.error).toContain('returned before');
  });
  it('preserves completed thirty-second dwell through loginwindow on the return path', async () => {
    const ev = await world('12.12', { back: 45_000, transit: [35_000, 45_000] }).run();
    expect(ev.person.dwellCompletedAt - ev.person.awayAt).toBeGreaterThanOrEqual(30_000);
    expect(ev.person.returnedAt).toBeGreaterThan(ev.person.dwellCompletedAt);
    expect(ev.person.doneAt).toBe(ev.person.returnedAt);
  });
  it('rejects a return between logout completion and the login cue', async () => {
    const w = world('12.13');
    const snapshot = w.target.snapshot;
    let loggedOut = false;
    const act = w.target.act;
    w.target.act = async action => { const result = await act(action); if (action === 'logout-proof-user') loggedOut = true; return result; };
    w.target.snapshot = async () => { const s = await snapshot(); if (loggedOut) s.consoleOwner = 'instarproof'; return s; };
    const ev = await w.run();
    expect(ev.error).toContain('before the login cue');
    expect(w.cues).toHaveLength(0);
  });
  it('stops the grant before waiting for watch and logout, then requires a fresh return', async () => {
    const w = world('12.13');
    const ev = await w.run();
    expect(w.actions.map(a => a.action)).toEqual(['stop-viewer', 'logout-proof-user']);
    expect(ev.person.returnedAt).toBeGreaterThanOrEqual(w.cues[0].t + 5_000);
    expect(ev.person.doneAt).toBe(ev.person.returnedAt);
    expect(ev.verdict.pass).toBe(false); // Still lacks native lock-call observation.
  });
  it('cannot count the pre-logout console event as a return', async () => {
    const ev = await world('12.13', { back: Infinity }).run();
    expect(ev.person.doneAt).toBeUndefined();
    expect(ev.verdict.pass).toBe(false);
  });
  it('does not cue login when logout departure or old producer exit was not proved', async () => {
    const w = world('12.13');
    const act = w.target.act;
    w.target.act = async action => action === 'logout-proof-user' ? { departed: true, departedAt: BASE, producersGone: false } : act(action);
    const ev = await w.run();
    expect(ev.error).toContain('old producer exit');
    expect(w.cues).toHaveLength(0);
  });
  it.each([['15.10', 30_000], ['15.11', 130_000]] as const)('cues %s from observed watch start, not from Stop, then observes an unlock', async (id, delay) => {
    const w = world(id, { watchDelay: 20_000 });
    const ev = await w.run();
    expect(ev.person.cuedAt - ev.person.watchStart).toBeGreaterThanOrEqual(delay);
    expect(ev.person.cuedAt - ev.person.watchStart).toBeLessThan(delay + 1_000);
    expect(ev.person.unlockAt).toBeGreaterThan(ev.person.cueCompletedAt);
    expect(w.cues).toHaveLength(1);
    expect(w.cues[0].text).toContain('now');
    expect(w.cues[0].text).not.toContain('when I say so');
    expect(ev.verdict).toEqual({ pass: true, reasons: [] });
  });
  it('never cues a delayed unlock without an observed watch start', async () => {
    const w = world('15.10', { noWatch: true });
    const ev = await w.run();
    expect(w.cues).toHaveLength(0);
    expect(ev.verdict.pass).toBe(false);
  });
  it('rejects an already-unlocked Mac instead of treating it as a response to the cue', async () => {
    const w = world('15.10', { preCueUnlock: true });
    const ev = await w.run();
    expect(ev.error).toContain('not confirmed locked');
    expect(w.cues).toHaveLength(0);
  });
  it('rejects an inside-watch unlock that actually arrives after the watch', async () => {
    const ev = await world('15.10', { lateUnlock: 100_000 }).run();
    expect(ev.verdict.pass).toBe(false);
    expect(ev.verdict.reasons.join(' ')).toContain('required side of the watch');
  });
  it('the verdict independently rejects removed departure or delayed-unlock evidence', async () => {
    const ev = await world('15.11').run();
    delete ev.person.watchStart;
    expect(judge(byId('15.11'), ev).pass).toBe(false);
    const roundTrip = await world('12.12').run();
    delete roundTrip.person.returnedAt;
    expect(judge(byId('12.12'), roundTrip).reasons.join(' ')).toContain('dwell and return');
  });
});

describe('real logout action without desktop actions', () => {
  it('observes a real live process identity, a reused identity and an absent PID distinctly', () => {
    const t = Object.create(RealTarget.prototype);
    const start = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    const seconds = Date.parse(start) / 1_000;
    expect(t.recordedProducerGone(process.pid, `${seconds}.0`)).toBe(false);
    expect(t.recordedProducerGone(process.pid, `${seconds - 1}.0`)).toBe(true);
    const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    expect(exited.status).toBe(0);
    expect(t.recordedProducerGone(exited.pid, '100.1')).toBe(true);
  });

  function logout(owner: (time: number) => string, gone: (time: number) => boolean) {
    let now = BASE;
    const t = Object.assign(Object.create(RealTarget.prototype), {
      now: () => now, sleep: async (ms: number) => { now += ms; },
      consoleOwner: () => owner(now - BASE), events: new Set(['proof-user-console']),
      caseMarkers: () => ({ [KEY]: { guardPid: 42, guardStart: '100.1' } }),
      bootoutProofUser: () => {}, recordedProducerGone: () => gone(now - BASE),
    });
    return t;
  }
  it.each([undefined, 0, -1])('refuses a missing/transition guard %s even with a valid typist', async guardPid => {
    const t = logout(() => 'instarproof', () => true);
    let booted = false;
    t.bootoutProofUser = () => { booted = true; };
    t.caseMarkers = () => ({ [KEY]: { guardPid, guardStart: '100.1', typistPid: 43, typistStart: '100.2' } });
    await expect(t.logoutProofUser()).rejects.toThrow('guard identity');
    expect(booted).toBe(false);
  });
  it.each([
    { guardPid: 42, guardStart: '' },
    { guardPid: 42, guardStart: 'unknown' },
    { guardPid: 42, guardStart: '100.1', typistPid: 0, typistStart: '100.2' },
    { guardPid: 42, guardStart: '100.1', typistPid: 43 },
  ])('refuses malformed recorded producer identities', async marker => {
    const t = logout(() => 'instarproof', () => true);
    t.caseMarkers = () => ({ [KEY]: marker });
    await expect(t.logoutProofUser()).rejects.toThrow(/identity/);
  });
  it('fails when logout never leaves, even if bootout returned', async () => {
    await expect(logout(() => 'instarproof', () => true).logoutProofUser()).rejects.toThrow('did not confirm departure');
  });
  it('fails when an old guard remains alive, even after console departure', async () => {
    await expect(logout(t => t ? 'root' : 'instarproof', () => false).logoutProofUser()).rejects.toThrow('old producer exit');
  });
  it('rejects a return while still waiting for old producers to exit', async () => {
    const t = logout(t => t >= 500 && t < 1_500 ? 'root' : 'instarproof', t => t >= 2_000);
    await expect(t.logoutProofUser()).rejects.toThrow('returned before the login cue');
  });
  it('waits for both positive departure and old producer exit', async () => {
    const t = logout(t => t >= 500 ? 'root' : 'instarproof', t => t >= 2_000);
    expect(await t.logoutProofUser()).toMatchObject({ departed: true, departedAt: BASE + 500, producersGone: true });
    expect(t.now()).toBe(BASE + 2_000);
    expect(t.events.has('proof-user-console')).toBe(false);
  });
  it('does not call unreadable console identity a departure', async () => {
    await expect(logout(t => t ? '' : 'instarproof', () => true).logoutProofUser()).rejects.toThrow('did not confirm departure');
  });
});
