/**
 * Machine care page (machine-self-maintenance Part F surfaces, CMT-1203). Both sides of each
 * decision in the model: signed up or not (and why not), skipped or not, controls only for the
 * machine serving the page, a failed read never shown as "all fine", and every server answer in
 * plain words. Then the shipped page in jsdom: Skip asks for the PIN and sends the unlock proof,
 * Restart now only asks for the Telegram card, and a remote machine shows no buttons.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildMachineCarePage, careRow, controlAnswer, ago } from '../../dashboard/console/machine-care-model.js';
import { NATIVE_PAGES, NATIVE_PATHS, PHONE_PAGE_ALIASES, tabHref } from '../../dashboard/console/nav-model.js';

const NOW = new Date(2026, 10, 17, 9, 0).getTime();
const H = 3600 * 1000;
const enrolled = { enrolled: true, offerable: false, refusal: null, readiness: { mode: 'unattended', ownerStep: null } };
const notEnrolled = { enrolled: false, offerable: true, refusal: null, readiness: { mode: 'unattended', ownerStep: null } };
const base = { enabled: true, mode: 'watch-only', settings: { window: { start: '03:00', end: '06:00' } }, lastBootAt: NOW - 3 * 24 * H, controls: { skipUntil: null, skipped: false, window: null }, restartNow: null };

describe('careRow', () => {
  it('a signed-up machine says when it restarts, that it is practising only, and when it last started', () => {
    const r = careRow({ ...base, enrolment: enrolled }, { self: true, name: 'Mac Studio', now: NOW });
    expect(r.sentence).toBe('Weekly restart between 03:00 and 06:00 is practising only: nothing restarts on its own yet. Last start 3 days ago.');
    expect(r.controls).toEqual({ signUp: false, skip: true, unskip: false, window: true, restartNow: true, off: true });
  });

  it('a machine not signed up offers Sign up, not Restart now', () => {
    const r = careRow({ ...base, enrolment: notEnrolled }, { self: true, now: NOW });
    expect(r.sentence).toMatch(/^Not signed up, so nothing restarts here\./);
    expect(r.controls).toMatchObject({ signUp: true, restartNow: false, off: false });
  });

  it('says why sign-up waits: someone else signed in, or a login screen after restart', () => {
    expect(careRow({ ...base, enrolment: { ...notEnrolled, offerable: false, refusal: 'other-user-active' } }, { self: true, now: NOW }).sentence).toContain('Someone else is signed in');
    const attended = careRow({ ...base, enrolment: { ...notEnrolled, offerable: false, readiness: { mode: 'attended', ownerStep: 'On this Mac: turn on automatic login.' } } }, { self: true, now: NOW });
    expect(attended.sentence).toContain('stop at the login screen. To fix: On this Mac: turn on automatic login.');
    expect(attended.controls!.signUp).toBe(false);
  });

  it('a skip shows until when, and offers Undo instead of Skip', () => {
    const r = careRow({ ...base, enrolment: enrolled, controls: { skipUntil: NOW + 72 * H, skipped: true, window: null } }, { self: true, now: NOW });
    expect(r.sentence).toContain('Skipped until Friday 09:00.');
    expect(r.controls).toMatchObject({ skip: false, unskip: true });
  });

  it('a countdown running hides Restart now and says so', () => {
    const r = careRow({ ...base, enrolment: enrolled, restartNow: { phase: 'countdown' } }, { self: true, now: NOW });
    expect(r.sentence).toContain('A restart countdown is running now.');
    expect(r.controls!.restartNow).toBe(false);
  });

  it('switched off, or another machine: a sentence and no controls', () => {
    expect(careRow({ ...base, enabled: false, enrolment: enrolled }, { self: true, now: NOW })).toMatchObject({ controls: null, sentence: expect.stringContaining('switched off') });
    expect(careRow({ ...base, enrolment: enrolled }, { self: false, now: NOW }).controls).toBeNull();
  });

  it('no enrolment reading is "can’t tell", never "not signed up"', () => {
    expect(careRow({ ...base, enrolment: null }, { self: true, now: NOW }).sentence).toMatch(/^I can’t tell whether/);
  });

  it('ago reads hours and days', () => {
    expect(ago(NOW - 2 * H, NOW)).toBe('2 hours ago');
    expect(ago(NOW - 30 * 60000, NOW)).toBe('less than an hour ago');
    expect(ago(NOW + H, NOW)).toBeNull();
  });
});

describe('buildMachineCarePage', () => {
  it('a failed read is a reason, never an empty all-fine page', () => {
    expect(buildMachineCarePage({ ok: false, reason: 'the server answered 500' })).toEqual({ ok: false, reason: 'the server answered 500' });
  });

  it('this machine first, others after, and unreachable ones named', () => {
    const p = buildMachineCarePage({ ok: true, data: { machines: [
      { machineId: 'b', machineNickname: 'Mac Mini', self: false, state: { ...base, enrolment: notEnrolled } },
      { machineId: 'a', machineNickname: 'Mac Studio', self: true, state: { ...base, enrolment: enrolled } },
    ], pool: { failed: [{ machineId: 'c', machineNickname: 'Laptop', reason: 'peer-unreachable' }] } } }, { now: NOW });
    expect(p.ok && p.rows.map((r) => r.name)).toEqual(['Mac Studio', 'Mac Mini']);
    expect(p.ok && p.headline).toBe('1 machine is signed up');
    expect(p.ok && p.missing).toEqual(['Laptop: can’t tell, it did not answer.']);
  });

  it('an older server answering only for itself is this machine', () => {
    const p = buildMachineCarePage({ ok: true, data: { ...base, enrolment: notEnrolled } }, { now: NOW });
    expect(p.ok && p.rows[0]).toMatchObject({ self: true, name: 'This machine' });
    expect(p.ok && p.headline).toBe('No machine is signed up for restarts yet');
  });
});

describe('older servers: offer only what the server can do', () => {
  // The watch-only server (before Part F, e.g. caf469876) sends no controls, enrolment or restartNow
  // and has none of those routes. Absent controls must not read as "not skipped".
  const { controls: _c, restartNow: _r, ...watchOnly } = base;

  it('a watch-only answer offers no button at all', () => {
    const r = buildMachineCarePage({ ok: true, data: { enabled: true } }, { now: NOW });
    expect(r.ok && r.rows[0].controls).toEqual({ signUp: false, skip: false, unskip: false, window: false, restartNow: false, off: false });
    expect(careRow(watchOnly, { self: true, now: NOW }).controls).toEqual({ signUp: false, skip: false, unskip: false, window: false, restartNow: false, off: false });
  });

  it('an enrolment-era answer offers sign-up and Off, but not skip, hours or Restart now', () => {
    expect(careRow({ ...watchOnly, enrolment: notEnrolled }, { self: true, now: NOW }).controls).toMatchObject({ signUp: true, skip: false, window: false, restartNow: false });
    expect(careRow({ ...watchOnly, enrolment: enrolled }, { self: true, now: NOW }).controls).toMatchObject({ off: true, skip: false, window: false, restartNow: false });
  });

  it('a route the server does not have answers in plain words', () => {
    expect(controlAnswer('off', { ok: false, status: 404, data: {} }).message).toMatch(/older version/);
  });
});

describe('controlAnswer', () => {
  it('turns every server answer into plain words', () => {
    expect(controlAnswer('skip', { ok: false, status: 401, data: {} }).message).toContain('PIN');
    expect(controlAnswer('window', { ok: false, status: 400, data: { error: 'window-invalid' } }).message).toContain('2 hours');
    expect(controlAnswer('skip', { ok: false, status: 409, data: { error: 'host-store-busy' } }).message).toContain('Try again');
    expect(controlAnswer('restart', { ok: false, status: 409, data: { result: 'refused', reason: 'An OS update is running.' } }).message).toBe('An OS update is running.');
    expect(controlAnswer('restart', { ok: true, status: 200, data: { result: 'offered' } })).toMatchObject({ ok: true, message: expect.stringContaining('Telegram') });
    expect(controlAnswer('window', { ok: true, status: 200, data: { effectiveWindow: { start: '01:00', end: '04:00' } } }).message).toContain('between 01:00 and 04:00');
    expect(controlAnswer('sign-up', { ok: true, status: 200, data: { outcome: 'already-offered' } }).ok).toBe(true);
    expect(controlAnswer('sign-up', { ok: true, status: 200, data: { outcome: 'not-offerable' } }).ok).toBe(false);
    expect(controlAnswer('off', { ok: true, status: 200, data: { ok: true, wasEnrolled: true, ruleRemoved: true } }).message).toMatch(/^Turned off\..*permission is removed/);
    expect(controlAnswer('off', { ok: true, status: 200, data: { ok: true, wasEnrolled: true, ruleRemoved: false, reason: 'needs-admin' } }).message).toMatch(/still installed but unused/);
    expect(controlAnswer('off', { ok: true, status: 200, data: { ok: true, wasEnrolled: false } }).message).toMatch(/was not signed up/);
  });
});

describe('nav', () => {
  it('Machine care is a native console page, reachable from the Capacity tiles and the phone app', () => {
    expect(tabHref('machine-care')).toBe('#/capacity/machine-care');
    expect(NATIVE_PAGES['machine-care']).toBe('#/capacity/machine-care');
    expect(NATIVE_PATHS).toContain('capacity/machine-care');
    expect(PHONE_PAGE_ALIASES['machine-care']).toBe('capacity/machine-care');
  });
});

describe('Machine care page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('Skip asks for the PIN and sends the unlock proof; Restart now only asks for the card; a remote machine has no buttons', async () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/capacity/machine-care' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const posts: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const table: Record<string, unknown> = {
      '/health': { project: { name: 'echo' } },
      '/sessions': { sessions: [] },
      '/machine-maintenance?scope=pool': { machines: [
        { machineId: 'a', machineNickname: 'Mac Studio', self: true, state: { ...base, lastBootAt: Date.now() - 2 * H, enrolment: enrolled } },
        { machineId: 'b', machineNickname: 'Mac Mini', self: false, state: { ...base, enrolment: notEnrolled } },
      ], pool: { failed: [] } },
    };
    g.fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      if (init?.method === 'POST') {
        posts.push({ url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
        if (url === '/dashboard/unlock') return { ok: true, status: 200, json: async () => ({ operatorSessionToken: 'op-1', operatorSessionExpiresAt: new Date(Date.now() + 600000).toISOString() }) };
        if (url === '/machine-maintenance/skip') return { ok: true, status: 200, json: async () => ({ ok: true, controls: { skipUntil: Date.now() + 72 * H } }) };
        if (url === '/machine-maintenance/remove') return { ok: true, status: 200, json: async () => ({ ok: true, wasEnrolled: true, ruleRemoved: true }) };
        if (url === '/machine-maintenance/restart-now/offer') return { ok: true, status: 200, json: async () => ({ result: 'offered', named: [], recentBoot: false }) };
      }
      const b = table[url];
      return b === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(b)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20)); };
    await tick(15);
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('1 machine is signed up');
    const cards = [...doc.querySelectorAll('.machine-care-card')];
    expect(cards.map((c) => c.querySelector('.need-title')!.textContent)).toEqual(['Mac Studio (this machine)', 'Mac Mini']);
    expect(cards[0].textContent).toContain('Last start 2 hours ago.');
    expect(cards[1].querySelectorAll('button')).toHaveLength(0);
    expect(cards[1].textContent).toContain('To change Mac Mini, open its own dashboard.');
    expect(doc.querySelector('#main')!.textContent).not.toContain('null');

    const btn = (label: string) => [...cards[0].querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
    btn('Restart now').click();
    await tick();
    const offer = posts.find((p) => p.url === '/machine-maintenance/restart-now/offer')!;
    expect(offer.headers['X-Instar-Operator-Session']).toBeUndefined();
    expect(cards[0].querySelector('.care-status')!.textContent).toContain('Telegram');

    btn('Skip once').click();
    await tick();
    const pin = doc.querySelector('.pin-input') as HTMLInputElement;
    expect(pin).not.toBeNull();
    pin.value = '123456';
    doc.querySelector('.pin-form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await tick();
    const skip = posts.find((p) => p.url === '/machine-maintenance/skip')!;
    expect(skip.headers['X-Instar-Operator-Session']).toBe('op-1');
    expect(cards[0].querySelector('.care-status')!.textContent).toMatch(/^Skipped\. The next restart is after /);

    // Turn off: a confirm naming the machine, then the held PIN unlock goes with the request.
    const offBtn = btn('Turn off');
    offBtn.click();
    expect(cards[0].querySelector('.confirm-text')!.textContent).toContain('Stop restarting Mac Studio?');
    ([...cards[0].querySelectorAll('.confirm-row button')].find((b) => b.textContent === 'Turn off') as HTMLButtonElement).click();
    await tick();
    const removed = posts.find((p) => p.url === '/machine-maintenance/remove')!;
    expect(removed.headers['X-Instar-Operator-Session']).toBe('op-1');
    expect(cards[0].textContent).toContain('Turned off.');
  });
});
