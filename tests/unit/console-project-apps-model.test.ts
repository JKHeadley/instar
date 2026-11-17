/**
 * Project apps in the console (docs/specs/project-apps.md §3.5): the pure model for a Work row's
 * apps (Open buttons up to three then More apps, the headline / as-of line, unreadable with its
 * action, offers, Add app with its notes, recent answers, the pin states), the conversation strip
 * lookup by conversation key, and the Needs-you exemption. The second half renders the shipped
 * Projects section in jsdom and drives Attach through the dashboard unlock against a mocked server.
 */
// @ts-nocheck — the modules are browser-native ESM (.js), no types.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  appsView, summaryLine, pinLine, appStripFor, conversationRefOf, safeHash, safeAppHref, appNavigation, appPath, projectsView,
} from '../../dashboard/console/projects-model.js';
import { NEED_EXEMPT } from '../../dashboard/console/needs-model.js';

const NOW = Date.parse('2026-11-16T20:00:00Z');
const app = (over = {}) => ({
  appRef: 'builtin:maturation-board', title: 'Feature maturation board', openHref: '#/work/maturation', nativeScreen: 'maturation',
  summary: { headline: '40 features: 12 live, 5 stalled, regressed or blind', counts: [{ label: 'Live', value: 12, tone: 'ok' }], asOf: '2026-11-16T19:30:00Z' },
  summaryState: 'ok', ...over,
});
const row = (over = {}) => ({ key: 'telegram:128732', conversationKey: 'telegram:128732', title: 'Maturation', state: 'moving', apps: [], offers: [], answers: [], addable: [], ...over });

describe('appsView: the Work row', () => {
  it('a row without app fields (feature off) has nothing', () => {
    const v = appsView({ key: 'telegram:1' }, NOW);
    expect(v.has).toBe(false);
    expect(v.buttons).toEqual([]);
    expect(v.headline).toBeNull();
    expect(v.hint).toBeNull();
  });

  it('one Open button per app, up to three, then More apps counts the rest', () => {
    const apps = [1, 2, 3, 4, 5].map((i) => app({ appRef: `builtin:a${i}`, title: `App ${i}`, openHref: `#/work/a${i}` }));
    const v = appsView(row({ apps }), NOW);
    expect(v.buttons.map((b) => b.label)).toEqual(['Open App 1', 'Open App 2', 'Open App 3']);
    expect(v.more).toBe(2);
    expect(appsView(row({ apps: apps.slice(0, 3) }), NOW).more).toBe(0);
  });

  it('an address that is not a console route never becomes a button', () => {
    const v = appsView(row({ apps: [app({ openHref: 'javascript:alert(1)' }), app({ appRef: 'builtin:b', title: 'B', openHref: 'https://evil.example/' })] }), NOW);
    expect(v.buttons).toEqual([]);
    expect(safeHash('#/work/maturation')).toBe('#/work/maturation');
    expect(safeHash('javascript:x')).toBeNull();
  });

  it('a custom app opens the shared wrapper page, and only that exact path shape is accepted', () => {
    const W = '/dashboard/project-app/?app=pa_0123456789abcdef';
    const v = appsView(row({ apps: [app({ appRef: 'custom:pa_0123456789abcdef', title: 'Sales pipeline', openHref: W })] }), NOW);
    expect(v.buttons.map((b) => b.href)).toEqual([W]);
    expect(appNavigation(W)).toEqual({ kind: 'page', href: W });
    expect(appNavigation('#/work/maturation')).toEqual({ kind: 'hash', href: '#/work/maturation' });
    for (const bad of [
      '/dashboard/project-app/?app=pa_0123456789ABCDEF', '/dashboard/project-app/?app=pa_0123456789abcde',
      '/dashboard/project-app/?app=pa_0123456789abcdef&x=1', '//evil.example/dashboard/project-app/?app=pa_0123456789abcdef',
      '/dashboard/project-app/?app=pa_0123456789abcdef#x', 'https://evil.example/dashboard/project-app/?app=pa_0123456789abcdef',
      '/dashboard/project-app/../?app=pa_0123456789abcdef', '/dashboard/other/?app=pa_0123456789abcdef', 'javascript:alert(1)',
    ]) { expect(safeAppHref(bad)).toBeNull(); expect(appNavigation(bad)).toBeNull(); }
    // A summary action stays console-hash only.
    expect(summaryLine(app({ summaryState: 'unreadable', summaryWhy: 'x', summaryAction: { label: 'Open', href: W } }), NOW).action).toBeUndefined();
  });

  it('the first app headline is the second line, "as of HH:MM" when fresh', () => {
    const v = appsView(row({ apps: [app(), app({ appRef: 'builtin:b', title: 'B', summary: { headline: 'other', counts: [], asOf: '2026-11-16T19:00:00Z' } })] }), NOW);
    expect(v.headline.state).toBe('ok');
    expect(v.headline.text).toMatch(/^40 features: 12 live, 5 stalled, regressed or blind · as of \d{2}:\d{2}$/);
  });

  it('a summary older than a day says "last updated <date>"', () => {
    const l = summaryLine(app({ summary: { headline: 'H', counts: [], asOf: '2026-11-10T10:00:00Z' } }), NOW);
    expect(l.text).toMatch(/^H · last updated /);
    expect(l.text).not.toMatch(/as of/);
  });

  it('pending reads as "Reading the board…", never zeros', () => {
    expect(summaryLine(app({ summary: null, summaryState: 'pending' }), NOW)).toEqual({ text: 'Reading the board…', state: 'pending' });
  });

  it('unreadable shows the reason and its action link; an unsafe action href is dropped', () => {
    const l = summaryLine(app({ summary: null, summaryState: 'unreadable', summaryWhy: 'The board is switched off on this agent.', summaryAction: { label: 'Turn it on', href: '#/settings/features' } }), NOW);
    expect(l).toEqual({ text: 'The board is switched off on this agent.', state: 'unreadable', action: { label: 'Turn it on', href: '#/settings/features' } });
    const bad = summaryLine(app({ summary: null, summaryState: 'unreadable', summaryWhy: 'x', summaryAction: { label: 'Go', href: 'javascript:x' } }), NOW);
    expect(bad.action).toBeUndefined();
    expect(summaryLine(app({ summary: null, summaryState: 'unreadable' }), NOW).text).toBe('The summary could not be read.');
  });

  it('open offers: "Your agent suggests", the reason split into first line and rest, and a hint for the collapsed line', () => {
    const v = appsView(row({ offers: [{ appRef: 'builtin:maturation-board', title: 'Feature maturation board', why: 'The board shows this project better than chat.\nIt has 40 features and their dates.', at: '2026-11-16T18:00:00Z' }] }), NOW);
    expect(v.offers).toHaveLength(1);
    expect(v.offers[0].label).toBe('Your agent suggests: Feature maturation board');
    expect(v.offers[0].whyFirst).toBe('The board shows this project better than chat.');
    expect(v.offers[0].whyRest).toBe('It has 40 features and their dates.');
    expect(v.hint).toBe('Your agent has a suggestion');
    expect(appsView(row({ offers: [{ appRef: 'builtin:a', title: 'A', why: 'w' }, { appRef: 'builtin:b', title: 'B', why: 'w' }] }), NOW).hint).toBe('Your agent has 2 suggestions');
    expect(appsView(row(), NOW).hint).toBeNull();
  });

  it('Add app lists every addable entry with its note (declined and withdrawn included)', () => {
    const v = appsView(row({ addable: [
      { appRef: 'builtin:maturation-board', title: 'Feature maturation board', note: 'you said no on 2026-11-15' },
      { appRef: 'builtin:other', title: 'Other' },
    ] }), NOW);
    expect(v.addable).toEqual([
      { appRef: 'builtin:maturation-board', title: 'Feature maturation board', note: 'you said no on 2026-11-15' },
      { appRef: 'builtin:other', title: 'Other', note: null },
    ]);
  });

  it('recent answers say who answered and how', () => {
    const v = appsView(row({ apps: [app()], answers: [
      { appRef: 'builtin:maturation-board', answer: 'attach', by: 'owner', via: 'console', at: '2026-11-16T18:00:00Z' },
      { appRef: 'builtin:maturation-board', answer: 'withdraw', by: 'agent', via: 'bearer', at: '2026-11-15T18:00:00Z' },
      { appRef: 'builtin:maturation-board', answer: 'detach', by: 'owner', via: 'phone', at: '2026-11-14T18:00:00Z' },
      { appRef: 'builtin:maturation-board', answer: 'decline', by: 'owner', via: 'desktop', at: '2026-11-13T18:00:00Z' },
    ] }), NOW);
    expect(v.answers.map((a) => a.text)).toEqual([
      expect.stringMatching(/^You attached Feature maturation board on .+ \(console\)$/),
      expect.stringMatching(/^Your agent withdrew Feature maturation board on /),
      expect.stringMatching(/^You removed Feature maturation board on .+ \(phone\)$/),
      expect.stringMatching(/^You said no to Feature maturation board on .+ \(desktop app\)$/),
    ]);
  });
});

describe('pin states', () => {
  it('failed: the reason and Try again', () => {
    expect(pinLine({ platform: 'telegram', state: 'failed', reason: 'no-public-address' })).toEqual({ text: "Couldn't pin the link in Telegram: no-public-address", tone: 'bad', action: { label: 'Try again', act: 'retry' } });
    expect(pinLine({ platform: 'slack', state: 'failed' }).text).toBe("Couldn't pin the link in Slack: no reason was given");
  });
  it('out-of-date: Update link', () => {
    expect(pinLine({ platform: 'telegram', state: 'out-of-date' })).toMatchObject({ text: 'The pinned link is out of date', action: { label: 'Update link', act: 'update-link' } });
  });
  it('uncertain: check the conversation, Post the link again', () => {
    expect(pinLine({ platform: 'telegram', state: 'uncertain' })).toMatchObject({ text: 'I may have posted the link already; check the conversation', action: { label: 'Post the link again', act: 'post-again' } });
  });
  it('pending says it is pinning with no button; pinned and none say nothing', () => {
    expect(pinLine({ platform: 'telegram', state: 'pending' })).toEqual({ text: 'Pinning the link in Telegram…', tone: 'quiet', action: null });
    expect(pinLine({ platform: 'telegram', state: 'pinned' })).toBeNull();
    expect(pinLine({ platform: 'telegram', state: 'none' })).toBeNull();
    expect(pinLine(undefined)).toBeNull();
  });
  it('appsView carries each app pin with its app', () => {
    const v = appsView(row({ apps: [app({ pin: { platform: 'telegram', state: 'failed', reason: 'x' } }), app({ appRef: 'builtin:b', title: 'B', pin: { platform: 'telegram', state: 'pinned' } })] }), NOW);
    expect(v.pins).toHaveLength(1);
    expect(v.pins[0]).toMatchObject({ appRef: 'builtin:maturation-board', title: 'Feature maturation board', action: { act: 'retry' } });
  });
});

describe('the conversation strip', () => {
  const data = { projects: [row({ apps: [app()] }), row({ key: 'f0e1d2c3-aaaa-bbbb-cccc-000000000000', conversationKey: 'f0e1d2c3-aaaa-bbbb-cccc-000000000000', apps: [app({ summary: null, summaryState: 'pending' })] }), row({ key: 'telegram:5', conversationKey: 'telegram:5', apps: [] })] };
  it('found by the conversation key', () => {
    const s = appStripFor(data, 'telegram:128732', NOW);
    expect(s).toMatchObject({ projectKey: 'telegram:128732', appRef: 'builtin:maturation-board', title: 'Feature maturation board', label: 'Open', href: '#/work/maturation' });
    expect(s.line.text).toMatch(/^40 features/);
  });
  it('a bare app conversation id matches its app: ref, as the chat link maps it', () => {
    expect(conversationRefOf('f0e1d2c3-aaaa-bbbb-cccc-000000000000')).toBe('app:f0e1d2c3-aaaa-bbbb-cccc-000000000000');
    expect(appStripFor(data, 'app:f0e1d2c3-aaaa-bbbb-cccc-000000000000', NOW).line.text).toBe('Reading the board…');
  });
  it('no strip for a project without apps, an unknown conversation, or a failed read', () => {
    expect(appStripFor(data, 'telegram:5', NOW)).toBeNull();
    expect(appStripFor(data, 'telegram:999', NOW)).toBeNull();
    expect(appStripFor(null, 'telegram:128732', NOW)).toBeNull();
    expect(appStripFor({ error: 'x' }, 'telegram:128732', NOW)).toBeNull();
  });
});

describe('routes and the Needs-you exemption', () => {
  it('write paths encode the key and the app ref', () => {
    expect(appPath('telegram:128732', 'builtin:maturation-board', 'answer')).toBe('/work/projects/telegram%3A128732/apps/builtin%3Amaturation-board/answer');
  });
  it('offers are listed in NEED_EXEMPT with a reason, so they are never a Needs-you row', () => {
    const e = NEED_EXEMPT.find((x) => x.file === 'projects.js');
    expect(e).toBeTruthy();
    expect(e.phrase).toBe('Your agent suggests');
    expect(e.why).toMatch(/optional/);
  });
  it('projectsView hands each row its apps', () => {
    const v = projectsView({ projects: [row({ apps: [app()] })], couldNotCheck: [] }, NOW);
    expect(v.active[0].apps.buttons[0].label).toBe('Open Feature maturation board');
  });
});

describe('the rendered Projects section (jsdom)', () => {
  let dom;
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body><main></main></body>', { url: 'http://localhost/dashboard/console/#/work/board' });
    for (const k of ['window', 'document', 'location', 'localStorage', 'sessionStorage', 'Event', 'HTMLElement', 'Node']) vi.stubGlobal(k, dom.window[k]);
    vi.stubGlobal('requestAnimationFrame', (f) => setTimeout(f, 0));
    dom.window.localStorage.setItem('instar_token', 'tok');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('draws Open buttons, the headline, the hint, the offer, Add app, the pin line; Attach unlocks first, then sends the owner session', async () => {
    const calls = [];
    const fresh = { projects: [row({ apps: [app()], offers: [] })], couldNotCheck: [] };
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url) === '/dashboard/unlock-check') return { ok: true, json: async () => ({ accepted: true }) };
      if (String(url) === '/dashboard/unlock') return { ok: true, status: 200, json: async () => ({ operatorSessionToken: 'op-1', operatorSessionExpiresAt: new Date(Date.now() + 600000).toISOString() }) };
      if (String(url).endsWith('/answer')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (String(url) === '/work/projects') return { ok: true, status: 200, json: async () => fresh };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }));
    const { projectsSection } = await import('../../dashboard/console/projects.js');
    const data = { couldNotCheck: [], projects: [row({
      apps: [app({ pin: { platform: 'telegram', state: 'failed', reason: 'no-public-address' } })],
      offers: [{ appRef: 'builtin:other', title: 'Other', why: 'Why line', at: '2026-11-16T18:00:00Z' }],
      addable: [{ appRef: 'builtin:other', title: 'Other', note: 'your agent withdrew this on 2026-11-14' }],
    })] };
    const sec = projectsSection(data);
    document.querySelector('main').append(sec);
    const summary = sec.querySelector('.project-summary');
    expect(summary.querySelector('.project-open').textContent).toBe('Open Feature maturation board');
    expect(summary.querySelector('.project-app-line').textContent).toMatch(/^40 features/);
    expect(summary.querySelector('.project-app-hint').textContent).toBe('Your agent has a suggestion');
    expect(sec.querySelector('.project-offer-title').textContent).toBe('Your agent suggests: Other');
    expect(sec.querySelector('.project-app-pin').textContent).toContain("Couldn't pin the link in Telegram: no-public-address");
    expect([...sec.querySelectorAll('.project-app-pin button')].map((b) => b.textContent)).toEqual(['Try again']);
    expect(sec.querySelector('.project-add-app').textContent).toContain('your agent withdrew this on 2026-11-14');

    // Open: reports the tap and goes to the app page.
    summary.querySelector('.project-open').click();
    expect(location.hash).toBe('#/work/maturation');
    expect(calls.some((c) => c.url.endsWith('/apps/builtin%3Amaturation-board/opened'))).toBe(true);

    // Attach: no operator session yet, so the PIN sheet opens first.
    const attach = [...sec.querySelectorAll('.project-offer button')].find((b) => b.textContent === 'Attach');
    attach.click();
    await vi.waitFor(() => expect(document.querySelector('.pin-input')).toBeTruthy());
    document.querySelector('.pin-input').value = '123456';
    document.querySelector('.pin-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/answer'))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith('/answer'));
    expect(sent.url).toBe('/work/projects/telegram%3A128732/apps/builtin%3Aother/answer');
    expect(sent.init.headers['X-Instar-Operator-Session']).toBe('op-1');
    const body = JSON.parse(sent.init.body);
    expect(body.answer).toBe('attach');
    expect(body.requestId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    // The section re-reads the projects and redraws in place.
    await vi.waitFor(() => expect(document.querySelector('.project-offer')).toBeNull());
  });

  it('a row without app fields draws exactly as before (no apps block, no buttons)', async () => {
    const { projectsSection } = await import('../../dashboard/console/projects.js');
    const sec = projectsSection({ couldNotCheck: [], projects: [{ key: 'telegram:1', title: 'P', state: 'moving' }] });
    expect(sec.querySelector('.project-apps-detail')).toBeNull();
    expect(sec.querySelector('.project-open')).toBeNull();
  });

  it('"Open project" from the conversation list (?project=<key>) opens that row, finished ones too; other rows stay closed', async () => {
    const { projectsSection } = await import('../../dashboard/console/projects.js');
    const data = { couldNotCheck: [], projects: [{ key: 'telegram:71', title: 'A', state: 'moving' }, { key: 'telegram:72', title: 'B', state: 'done' }] };
    const sec = projectsSection(data, { openKey: 'telegram:72' });
    const row = (k: string) => sec.querySelector(`details.project-row[data-project="${k}"]`) as HTMLDetailsElement;
    expect(row('telegram:72').open).toBe(true);
    expect((sec.querySelector('details.projects-finished') as HTMLDetailsElement).open).toBe(true);
    expect(row('telegram:71').open).toBe(false);
  });
});
