/**
 * The pairing code page (docs/specs/dashboard-console-default-and-pair-page.md §3.2): no code
 * before a PIN unlock on this page, then the code large with Copy; nothing stored; one reset on a
 * 403, at the session deadline and on return after it; answers from a forgotten session dropped.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { mountPairPage } from '../../dashboard-pair/pair.js';
import { deviceFromHash, shownApprovals, prettyCode, copyText, minutesLeft, waitingHeadline, waitingLine } from '../../dashboard-pair/pair-model.js';

const NOW = Date.parse('2026-11-03T20:00:00Z');
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

const WAITING = {
  deviceId: 'dev-1', deviceName: 'Justin’s iPhone', label: null, fingerprint: 'AB12 CD34', code: 'KITE-4172', codeFormat: 'word',
  expiresAt: '2026-11-03T20:12:00Z', personName: 'Justin', role: 'owner',
};

interface Harness {
  doc: Document; calls: Array<{ url: string; method: string; headers: Record<string, string> }>;
  answers: Record<string, () => Response | Promise<Response>>; clock: { t: number };
  deadlines: Array<() => void>; intervals: Array<() => void>; copied: string[]; clipboardFails: boolean; reqTimers: Array<() => void>;
}

function boot(hash = '', opts: { refused?: boolean; slowCheck?: boolean } = {}): Harness {
  const dom = new JSDOM('<!doctype html><body><div id="pair-root"></div></body>', { url: `https://echo.example.dev/dashboard/pair${hash}` });
  const doc = dom.window.document;
  const h: Harness = { doc, calls: [], answers: {}, clock: { t: NOW }, deadlines: [], intervals: [], copied: [], clipboardFails: false, reqTimers: [] };
  h.answers['GET /dashboard/unlock-check'] = () => opts.slowCheck ? new Promise<Response>(() => {}) : json(200, opts.refused ? { accepted: false, reason: 'Not a secure connection.', secureUrl: 'https://secure.example.dev' } : { accepted: true });
  h.answers['POST /dashboard/unlock'] = () => json(200, { token: 'tok', operatorSessionToken: 'ops', operatorSessionExpiresAt: '2026-11-03T20:15:00Z' });
  h.answers['GET /mobile/pairing-approvals'] = () => json(200, { approval: 'dashboard', approvals: [WAITING] });
  h.answers['GET /mobile/devices'] = () => json(200, { devices: [{ id: 'dev-0', deviceName: 'Old phone', status: 'active' }] });
  mountPairPage(doc, {
    fetchFn: async (url: string, o: { method?: string; headers?: Record<string, string> } = {}) => {
      const method = o.method ?? 'GET';
      h.calls.push({ url, method, headers: o.headers ?? {} });
      const a = h.answers[`${method} ${url}`];
      return a ? a() : json(404, {});
    },
    location: dom.window.location,
    now: () => h.clock.t,
    clipboard: { writeText: async (t: string) => { if (h.clipboardFails) throw new Error('denied'); h.copied.push(t); } },
    confirmFn: () => true,
    setTimer: (fn: () => void) => { h.intervals.push(fn); return h.intervals.length; },
    clearTimer: () => {},
    setDeadline: (fn: () => void) => { h.deadlines.push(fn); return h.deadlines.length; },
    clearDeadline: () => {},
    setRequestTimer: (fn: () => void) => { h.reqTimers.push(fn); return h.reqTimers.length; },
    clearRequestTimer: () => {},
  } as never);
  return h;
}

async function unlock(h: Harness, pin = '123456') {
  await flush();
  const input = h.doc.getElementById('pair-pin-input') as HTMLInputElement;
  input.value = pin;
  h.doc.querySelector('form')!.dispatchEvent(new h.doc.defaultView!.Event('submit', { cancelable: true }));
  await flush();
}
const text = (h: Harness) => h.doc.body.textContent ?? '';

describe('Approve on the code page (mobile-pairing-approve §3.3)', () => {
  const approvals = (canApprove: boolean, row = WAITING) => () => json(200, { approval: 'dashboard', approvals: [{ ...row, canApprove }] });
  const buttons = (h: Harness) => [...h.doc.querySelectorAll('button')];

  it('no new PIN prompt: the one unlock shows Approve, the key condition and the code', async () => {
    const h = boot();
    h.answers['GET /mobile/pairing-approvals'] = approvals(true);
    await unlock(h);
    expect(h.calls.filter((c) => c.url === '/dashboard/unlock')).toHaveLength(1);
    expect(buttons(h).some((b) => b.textContent === 'Approve this phone')).toBe(true);
    expect(text(h)).toContain('the key matches the one the app shows');
    expect(text(h)).toContain('KITE-4172');
  });

  it('a tap posts with the session, draws the phone no more, and leaves the code for an older app', async () => {
    const h = boot();
    h.answers['GET /mobile/pairing-approvals'] = approvals(true);
    h.answers['POST /mobile/pairing-approvals/dev-1/approve'] = () => json(200, { status: 'active', deviceId: 'dev-1' });
    await unlock(h);
    buttons(h).find((b) => b.textContent === 'Approve this phone')!.click();
    await flush();
    const call = h.calls.find((c) => c.url === '/mobile/pairing-approvals/dev-1/approve')!;
    expect(call.method).toBe('POST');
    expect(call.headers['X-Instar-Operator-Session']).toBe('ops');
    // The card is gone; the code stays readable for a shipped app's code box.
    expect(text(h)).toContain('Approved. That phone is paired. If the app still shows a code box, type KITE-4172 to finish.');
    expect(h.doc.querySelector('.pair-card')).toBeNull();
  });

  it('a refusal shows its own reason and the session stays', async () => {
    const h = boot();
    h.answers['GET /mobile/pairing-approvals'] = approvals(true);
    h.answers['POST /mobile/pairing-approvals/dev-1/approve'] = () => json(409, { error: 'another-phone-waiting', detail: 'Another phone is also waiting to pair, so nothing was approved.' });
    await unlock(h);
    buttons(h).find((b) => b.textContent === 'Approve this phone')!.click();
    await flush();
    expect(text(h)).toContain('Another phone is also waiting to pair');
    expect(h.doc.getElementById('pair-pin-input')).toBeNull();
  });

  it('no Approve button when the agent cannot use it: the page reads as it did', async () => {
    const h = boot();
    await unlock(h);
    expect(buttons(h).some((b) => b.textContent === 'Approve this phone')).toBe(false);
    expect(text(h)).toContain('The app shows the same key');
  });
});

describe('pair-model', () => {
  it('reads the device only from a well-formed fragment', () => {
    expect(deviceFromHash('#d=dev-1')).toBe('dev-1');
    expect(deviceFromHash('d=abc_DEF.9:x')).toBe('abc_DEF.9:x');
    expect(deviceFromHash('')).toBeNull();
    expect(deviceFromHash('#d=<script>')).toBeNull();
    expect(deviceFromHash('#x=1')).toBeNull();
  });
  it('shows the named phone only, or says it is no longer waiting', () => {
    expect(shownApprovals([WAITING], 'dev-1')).toEqual({ list: [WAITING], missing: false });
    expect(shownApprovals([WAITING], 'dev-9')).toEqual({ list: [], missing: true });
    expect(shownApprovals([WAITING, null], null)).toEqual({ list: [WAITING], missing: false });
  });
  it('formats and copies both code shapes as the app accepts them', () => {
    expect(prettyCode('KITE-4172')).toBe('KITE-4172');
    expect(prettyCode('123456')).toBe('123 456');
    expect(prettyCode('123 456')).toBe('123 456');
    expect(copyText('KITE-4172')).toBe('KITE-4172');
    expect(copyText('123 456')).toBe('123456');
  });
  it('words for time, the phone and the headline', () => {
    expect(minutesLeft('2026-11-03T20:12:00Z', NOW)).toBe('12 min left');
    expect(minutesLeft('2026-11-03T19:00:00Z', NOW)).toBe('expired');
    expect(waitingLine(WAITING, NOW)).toBe('Justin’s iPhone — Justin (owner) · 12 min left');
    expect(waitingHeadline({ approval: 'telegram', shown: [], missing: false })).toMatch(/private Telegram chat/);
    expect(waitingHeadline({ approval: 'dashboard', shown: [], missing: true })).toMatch(/no longer waiting/);
    expect(waitingHeadline({ approval: 'dashboard', shown: [], missing: false })).toMatch(/No phone is waiting/);
    expect(waitingHeadline({ approval: 'dashboard', shown: [WAITING], missing: false })).toBe('A phone is waiting to pair.');
  });
});

describe('the pairing code page', () => {
  it('shows the address it is on and a PIN box, and asks for no code before the unlock', async () => {
    const h = boot();
    await flush();
    expect(h.doc.querySelector('.pair-host')!.textContent).toBe('echo.example.dev');
    expect(h.doc.getElementById('pair-pin-input')).not.toBeNull();
    expect(h.calls.map((c) => c.url)).toEqual(['/dashboard/unlock-check']);
    expect(text(h)).not.toContain('KITE-4172');
  });

  it('a refused connection gets the secure address for this same page, and no PIN box', async () => {
    const h = boot('#d=dev-1', { refused: true });
    await flush();
    expect(h.doc.getElementById('pair-pin-input')).toBeNull();
    expect(h.doc.querySelector('a.pair-button')!.getAttribute('href')).toBe('https://secure.example.dev/dashboard/pair#d=dev-1');
  });

  it('after the PIN: the code large, Copy, the fingerprint and the never-send line; operator session sent', async () => {
    const h = boot();
    await unlock(h);
    expect(h.doc.querySelector('.pair-code')!.textContent).toBe('KITE-4172');
    expect(text(h)).toContain('Never send it to anyone, including me.');
    expect(text(h)).toContain('AB12 CD34');
    const approvals = h.calls.find((c) => c.url === '/mobile/pairing-approvals')!;
    expect(approvals.headers).toMatchObject({ Authorization: 'Bearer tok', 'X-Instar-Operator-Session': 'ops' });
    expect(text(h)).toContain('Old phone · Paired');
  });

  it('stores nothing: no token or session in localStorage or sessionStorage', async () => {
    const h = boot();
    await unlock(h);
    const w = h.doc.defaultView!;
    expect(w.localStorage.length).toBe(0);
    expect(w.sessionStorage.length).toBe(0);
  });

  it('Copy puts the code on the clipboard; a refused clipboard says how to copy by hand', async () => {
    const h = boot();
    await unlock(h);
    const copy = [...h.doc.querySelectorAll('button')].find((b) => b.textContent === 'Copy')!;
    copy.click(); await flush();
    expect(h.copied).toEqual(['KITE-4172']);
    expect(h.doc.querySelector('.pair-copied')!.textContent).toBe('Copied');
    h.clipboardFails = true;
    copy.click(); await flush();
    expect(h.doc.querySelector('.pair-copied')!.textContent).toMatch(/Press and hold/);
  });

  it('with #d= it shows only that phone, or says that phone is no longer waiting', async () => {
    const h = boot('#d=dev-9');
    await unlock(h);
    expect(text(h)).toContain('That phone is no longer waiting');
    expect(text(h)).not.toContain('KITE-4172');
  });

  it('a 403 runs the reset: codes gone, PIN box back', async () => {
    const h = boot();
    await unlock(h);
    h.answers['GET /mobile/pairing-approvals'] = () => json(403, { error: 'operator-session-required' });
    h.intervals[0]!(); await flush();
    expect(text(h)).not.toContain('KITE-4172');
    expect(h.doc.getElementById('pair-pin-input')).not.toBeNull();
    expect(text(h)).toContain('Your unlock ran out');
  });

  it('a 403 from ANY call runs the reset: the paired-phones read', async () => {
    const h = boot();
    h.answers['GET /mobile/devices'] = () => json(403, { error: 'operator-session-required' });
    await unlock(h);
    expect(text(h)).not.toContain('KITE-4172');
    expect(h.doc.getElementById('pair-pin-input')).not.toBeNull();
  });

  it('a 403 from ANY call runs the reset: decline', async () => {
    const h = boot();
    await unlock(h);
    h.answers['POST /mobile/pairing-approvals/dev-1/decline'] = () => json(403, { error: 'operator-session-required' });
    [...h.doc.querySelectorAll('button')].find((b) => b.textContent === 'Not my phone — decline')!.click();
    await flush();
    expect(text(h)).not.toContain('KITE-4172');
    expect(h.doc.getElementById('pair-pin-input')).not.toBeNull();
    expect(text(h)).not.toContain('Could not reach the agent');
  });

  it('the code shows even when the paired-phones read never answers, and polling is not wedged', async () => {
    const h = boot();
    h.answers['GET /mobile/devices'] = () => new Promise<Response>(() => {});
    await unlock(h);
    expect(h.doc.querySelector('.pair-code')!.textContent).toBe('KITE-4172');
    expect(text(h)).toContain('Reading the paired phones');
  });

  it('the session deadline wipes the code even with no poll and no network answer', async () => {
    const h = boot();
    await unlock(h);
    expect(text(h)).toContain('KITE-4172');
    h.answers['GET /mobile/pairing-approvals'] = () => new Promise<Response>(() => {}); // network never answers
    h.clock.t = Date.parse('2026-11-03T20:15:01Z');
    h.deadlines[h.deadlines.length - 1]!(); await flush();
    expect(text(h)).not.toContain('KITE-4172');
    expect(h.doc.getElementById('pair-pin-input')).not.toBeNull();
  });

  it('Copy after the deadline (a page suspended past it) wipes instead of copying', async () => {
    const h = boot();
    await unlock(h);
    h.clock.t = Date.parse('2026-11-03T20:15:30Z');
    [...h.doc.querySelectorAll('button')].find((b) => b.textContent === 'Copy')!.click(); await flush();
    expect(h.copied).toEqual([]);
    expect(text(h)).not.toContain('KITE-4172');
  });

  it('returning to a hidden page after the deadline wipes it at once', async () => {
    const h = boot();
    await unlock(h);
    h.clock.t = Date.parse('2026-11-03T20:16:00Z');
    h.doc.dispatchEvent(new h.doc.defaultView!.Event('visibilitychange'));
    await flush();
    expect(text(h)).not.toContain('KITE-4172');
  });

  it('an answer that arrives after the session was reset is dropped', async () => {
    const h = boot();
    await unlock(h);
    let release: (r: Response) => void = () => {};
    h.answers['GET /mobile/pairing-approvals'] = () => new Promise<Response>((r) => { release = r; });
    h.intervals[0]!(); await flush();
    h.clock.t = Date.parse('2026-11-03T20:15:01Z');
    h.deadlines[h.deadlines.length - 1]!(); await flush();
    release(json(200, { approval: 'dashboard', approvals: [WAITING] })); await flush();
    expect(text(h)).not.toContain('KITE-4172');
  });

  it('a phone clock 20 minutes fast still shows the code: the deadline is measured on the server clock', async () => {
    const h = boot();
    h.clock.t = NOW + 20 * 60_000; // the phone believes it is 20:20; the server says 20:00
    h.answers['POST /dashboard/unlock'] = () => ({ ok: true, status: 200, headers: { get: (k: string) => (k === 'Date' ? 'Tue, 03 Nov 2026 20:00:00 GMT' : null) },
      json: async () => ({ token: 'tok', operatorSessionToken: 'ops', operatorSessionExpiresAt: '2026-11-03T20:15:00Z' }) }) as unknown as Response;
    await unlock(h);
    expect(h.doc.querySelector('.pair-code')!.textContent).toBe('KITE-4172');
    h.clock.t += 14 * 60_000;
    h.intervals[0]!(); await flush();
    expect(text(h)).toContain('KITE-4172');
    h.clock.t += 2 * 60_000; // past the server's 15 minutes
    h.intervals[0]!(); await flush();
    expect(text(h)).not.toContain('KITE-4172');
  });

  it('"Show every waiting phone" keeps the unlock (no reload, no second PIN)', async () => {
    const h = boot('#d=dev-9');
    await unlock(h);
    const unlocks = h.calls.filter((c) => c.url === '/dashboard/unlock').length;
    [...h.doc.querySelectorAll('button')].find((b) => b.textContent === 'Show every waiting phone')!.click(); await flush();
    expect(h.doc.querySelector('.pair-code')!.textContent).toBe('KITE-4172');
    expect(h.calls.filter((c) => c.url === '/dashboard/unlock').length).toBe(unlocks);
  });

  it('a body that arrives late, across a reset and a new unlock, is never shown, and polling recovers', async () => {
    const h = boot();
    await unlock(h);
    let releaseBody: (v: unknown) => void = () => {};
    // Headers at once, body held back.
    h.answers['GET /mobile/pairing-approvals'] = () => ({ ok: true, status: 200, json: () => new Promise((r) => { releaseBody = r; }) }) as unknown as Response;
    h.intervals[0]!(); await flush();
    h.clock.t = Date.parse('2026-11-03T20:15:01Z');
    h.deadlines[h.deadlines.length - 1]!(); await flush(); // reset
    // A new unlock; its own read answers with a different phone.
    h.answers['GET /mobile/pairing-approvals'] = () => json(200, { approval: 'dashboard', approvals: [{ ...WAITING, deviceId: 'dev-2', code: 'MOTH-1234' }] });
    h.answers['POST /dashboard/unlock'] = () => json(200, { token: 'tok2', operatorSessionToken: 'ops2', operatorSessionExpiresAt: '2026-11-03T20:31:00Z' });
    await unlock(h);
    expect(h.doc.querySelector('.pair-code')!.textContent).toBe('MOTH-1234');
    releaseBody({ approval: 'dashboard', approvals: [WAITING] }); await flush(); // the old body finally arrives
    expect(text(h)).not.toContain('KITE-4172');
    expect(h.doc.querySelector('.pair-code')!.textContent).toBe('MOTH-1234');
    // Polling is not wedged by the old, stalled refresh.
    const before = h.calls.filter((c) => c.url === '/mobile/pairing-approvals').length;
    h.intervals[h.intervals.length - 1]!(); await flush();
    expect(h.calls.filter((c) => c.url === '/mobile/pairing-approvals').length).toBe(before + 1);
  });

  it('a declined phone leaves at once and a read that started before the decline cannot bring it back', async () => {
    const h = boot();
    await unlock(h);
    h.answers['POST /mobile/pairing-approvals/dev-1/decline'] = () => json(200, { declined: true });
    // The server still lists it on the next read (a read racing the decline).
    [...h.doc.querySelectorAll('button')].find((b) => b.textContent === 'Not my phone — decline')!.click();
    await flush();
    expect(text(h)).not.toContain('KITE-4172');
    expect(text(h)).toContain('No phone is waiting');
  });

  it('a slow unlock gives the button back with a plain message', async () => {
    const h = boot();
    h.answers['POST /dashboard/unlock'] = () => new Promise<Response>(() => {});
    await unlock(h);
    expect((h.doc.querySelector('form button') as HTMLButtonElement).disabled).toBe(true);
    h.reqTimers[h.reqTimers.length - 1]!(); await flush(); // the 15-second limit
    expect(text(h)).toContain('The agent did not answer. Try again.');
    expect((h.doc.querySelector('form button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a slow unlock-check still offers the PIN box', async () => {
    const h = boot('', { slowCheck: true });
    await flush();
    expect(h.doc.getElementById('pair-pin-input')).toBeNull();
    h.reqTimers[0]!(); await flush();
    expect(h.doc.getElementById('pair-pin-input')).not.toBeNull();
  });

  it('a wrong PIN shows the server’s words and no code', async () => {
    const h = boot();
    h.answers['POST /dashboard/unlock'] = () => json(403, { error: 'Incorrect PIN', attemptsRemaining: 4 });
    await unlock(h, '000000');
    expect(text(h)).toContain('Incorrect PIN · 4 tries left');
    expect(h.calls.some((c) => c.url === '/mobile/pairing-approvals')).toBe(false);
  });

  it('decline posts for that phone with the operator session', async () => {
    const h = boot();
    await unlock(h);
    h.answers['POST /mobile/pairing-approvals/dev-1/decline'] = () => json(200, { declined: true });
    [...h.doc.querySelectorAll('button')].find((b) => b.textContent === 'Not my phone — decline')!.click();
    await flush();
    const d = h.calls.find((c) => c.method === 'POST' && c.url.endsWith('/decline'))!;
    expect(d.headers['X-Instar-Operator-Session']).toBe('ops');
  });

  it('renders untrusted names as text, never HTML', async () => {
    const h = boot();
    h.answers['GET /mobile/pairing-approvals'] = () => json(200, { approval: 'dashboard', approvals: [{ ...WAITING, deviceName: '<img src=x onerror=alert(1)>' }] });
    await unlock(h);
    expect(h.doc.querySelector('img')).toBeNull();
    expect(text(h)).toContain('<img src=x onerror=alert(1)>');
  });
});
