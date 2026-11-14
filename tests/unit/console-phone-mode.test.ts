/**
 * Console phone mode: the Instar iPhone app loads
 *   /dashboard/console/?phone=1#/<page>   (or #/<page>?phone=1)
 * and shows only that page inside its own frame: no top bar, no nav, no Legacy
 * chip or link. Without phone=1 nothing changes. The mode decision is a pure
 * model (nav-model.js); the shell is checked by booting the SHIPPED console.js
 * in jsdom.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { isPhoneMode, pagePath, PHONE_PAGE_ALIASES, PHONE_ONLY_PAGES } from '../../dashboard/console/nav-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_JS = fs.readFileSync(path.resolve(__dirname, '../../dashboard/console/console.js'), 'utf-8');

describe('isPhoneMode', () => {
  it('is on for phone=1 in the page query', () => {
    expect(isPhoneMode('?phone=1', '#/accounts')).toBe(true);
    expect(isPhoneMode('?x=2&phone=1', '')).toBe(true);
    expect(isPhoneMode('phone=1', '')).toBe(true);
  });
  it('is on for phone=1 in the hash query', () => {
    expect(isPhoneMode('', '#/accounts?phone=1')).toBe(true);
    expect(isPhoneMode('', '#/work/plans?s=in-the-way&phone=1')).toBe(true);
  });
  it('is off without phone=1', () => {
    expect(isPhoneMode('', '')).toBe(false);
    expect(isPhoneMode('', '#/accounts')).toBe(false);
    expect(isPhoneMode('?phone=0', '#/accounts?phone=true')).toBe(false);
    expect(isPhoneMode('?telephone=1', '#/phone=1')).toBe(false);
    expect(isPhoneMode(undefined as unknown as string, null as unknown as string)).toBe(false);
  });
});

describe('pagePath', () => {
  it('resolves the short page names only in phone mode', () => {
    expect(pagePath('accounts', true)).toBe('capacity/accounts');
    expect(pagePath('files', true)).toBe('settings/files');
    expect(pagePath('pace', true)).toBe('work/pace');
    expect(pagePath('accounts', false)).toBe('accounts');
  });
  it('leaves full paths and unknown names alone', () => {
    expect(pagePath('capacity/accounts', true)).toBe('capacity/accounts');
    expect(pagePath('home', true)).toBe('home');
    expect(pagePath('toString', true)).toBe('toString');
  });
  it('every short name points at a page the console actually renders', () => {
    for (const [alias, full] of Object.entries(PHONE_PAGE_ALIASES)) {
      const native = CONSOLE_JS.includes(`'${full}': render`);
      const phoneOnly = PHONE_ONLY_PAGES.includes(full) && CONSOLE_JS.includes(`'${full}': (main`);
      expect(native || phoneOnly, `${alias} → ${full}`).toBe(true);
    }
  });
});

// ── the shipped shell in jsdom ─────────────────────────────────────────────
const NOW = new Date().toISOString();
const ROUTES: Record<string, unknown> = {
  '/sessions': { sessions: [] },
  '/health': { project: { name: 'echo' } },
  '/queue-pace?scope=pool': { queues: [{ machine: 'm1', queue: 'prs', inflowPerDay: 3, outflowPerDay: 2, open: 4 }] },
  '/attention?scope=pool&status=OPEN': { items: [], pool: { failed: [] } },
  '/commitments?scope=mesh': { enabled: true, scope: 'mesh', commitments: [] },
  '/sessions?scope=pool': { sessions: [{ name: 'Fix it', status: 'running', startedAt: NOW }], pool: { failed: [] } },
  '/telegram/topics?scope=pool': { topics: [], pool: { failed: [], unresolved: [] } },
  '/pool': { machines: [] },
  '/guards': { guards: [] },
  '/mandate': { mandates: [] },
};

let dom: JSDOM;
const flush = () => new Promise((r) => setTimeout(r, 30));

async function boot(url: string) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage });
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);
  dom.window.localStorage.setItem('instar_token', 't');
  g.fetch = async (u: string) => {
    const body = ROUTES[u];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) } as unknown as Response;
  };
  vi.resetModules();
  await import('../../dashboard/console/console.js');
  for (let i = 0; i < 10; i++) await flush();
  return dom.window.document;
}

function hasNoChrome(doc: Document) {
  expect(doc.querySelector('.topbar')).toBeNull();
  expect(doc.querySelector('nav.nav')).toBeNull();
  expect(doc.querySelector('.chip-legacy')).toBeNull();
  expect(doc.querySelector('.brand')).toBeNull();
  expect(doc.querySelector('a[href="/dashboard/legacy"]')).toBeNull();
  expect(doc.documentElement.hasAttribute('data-phone')).toBe(true);
}

afterEach(() => { dom?.window.close(); });

describe('console phone mode (jsdom)', () => {
  it('?phone=1#/pace shows only the Pace page', async () => {
    const doc = await boot('http://localhost:4040/dashboard/console/?phone=1#/pace');
    hasNoChrome(doc);
    expect(doc.querySelector('#main h1')?.textContent).toBe('Pace');
    const card = doc.querySelector('.pace-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.hidden).toBe(false);
  });

  it('?phone=1#/accounts shows the Accounts page without the bars', async () => {
    const doc = await boot('http://localhost:4040/dashboard/console/?phone=1#/accounts');
    hasNoChrome(doc);
    expect(doc.querySelector('#card-needs')).toBeNull(); // not Home: the short name resolved
    expect(doc.querySelector('#main')!.textContent!.length).toBeGreaterThan(0);
  });

  it('phone=1 in the hash query works too, and the mode stays on across hash changes', async () => {
    const doc = await boot('http://localhost:4040/dashboard/console/#/work?phone=1');
    hasNoChrome(doc);
    expect(doc.querySelector('.tiles')).not.toBeNull(); // the Work page content is there
    expect(doc.querySelector('.foot-note')).toBeNull(); // its "open the legacy dashboard" note is not
    dom.window.location.hash = '#/home';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    for (let i = 0; i < 5; i++) await flush();
    hasNoChrome(doc);
    expect(doc.querySelector('#card-needs')).not.toBeNull();
  });

  it('without phone=1 nothing changes: the bars are there and short names do not resolve', async () => {
    const doc = await boot('http://localhost:4040/dashboard/console/#/work');
    expect(doc.querySelector('.topbar')).not.toBeNull();
    expect(doc.querySelector('nav.nav')).not.toBeNull();
    expect(doc.querySelector('.chip-legacy')).not.toBeNull();
    expect(doc.querySelector('.foot-note')).not.toBeNull();
    expect(doc.documentElement.hasAttribute('data-phone')).toBe(false);
    dom.window.location.hash = '#/pace';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    for (let i = 0; i < 5; i++) await flush();
    expect(doc.querySelector('.topbar')).not.toBeNull();
    expect(doc.querySelector('.pace-card')).toBeNull(); // #/pace is not a page outside phone mode
  });
});
