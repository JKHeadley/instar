/**
 * The console's Health page and Home's health rows (docs/specs/mobile-health-issues.md): one answer shared with
 * the phone, every problem has a next step, internal notes never raise Home's count, and a bad answer never
 * reads as healthy.
 */
// @ts-nocheck — the modules are browser-native ESM (.js), no types.
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const model = () => import(path.join(CONSOLE, 'health-model.js'));
const issue = (over = {}) => ({ id: 'iMessage', impact: 'user-affecting', title: 'iMessage isn’t connected', detail: 'Messages won’t reach me.', evidence: null, count: 1, lastAt: null, action: null, ask: 'What happened to "iMessage"?', ...over });
const answer = (verdict, issues, headline = 'x') => ({ ok: true, status: 200, data: { verdict, headline, uptime: '2h', issues, truncated: false } });

describe('health-model', () => {
  it('sorts a page into problems, unsorted and quiet', async () => {
    const { buildHealthPage } = await model();
    const p = buildHealthPage(answer('attention', [issue(), issue({ id: 'a', impact: 'unclassified' }), issue({ id: 'b', impact: 'internal' })], 'iMessage isn’t connected.'));
    expect(p).toMatchObject({ ok: true, tone: 'attn', headline: 'iMessage isn’t connected.' });
    expect([p.problems.length, p.unsorted.length, p.quiet.length]).toEqual([1, 1, 1]);
  });

  it('a failed read or a wrong shape can’t tell; neither reads as healthy', async () => {
    const { buildHealthPage, healthNeedRows } = await model();
    expect(buildHealthPage({ ok: false, reason: 'no answer' }).ok).toBe(false);
    expect(buildHealthPage({ ok: true, data: { verdict: 'fine' } }).ok).toBe(false);
    expect(buildHealthPage({ ok: true, data: {} }).ok).toBe(false);
    expect(healthNeedRows({ ok: true, data: {} })).toBeNull();
  });

  it('Home gets only what affects the person', async () => {
    const { healthNeedRows } = await model();
    expect(healthNeedRows(answer('running', [issue({ impact: 'internal' })]))).toEqual([]);
    expect(healthNeedRows(answer('unsure', [issue({ impact: 'unclassified' })]))).toEqual([]);
    const rows = healthNeedRows(answer('attention', [issue()]));
    expect(rows).toEqual([{ key: 'iMessage', title: 'iMessage isn’t connected', detail: 'Messages won’t reach me.', href: '#/capacity/health?s=iMessage' }]);
  });

  it('the Ask link carries the question, encoded', async () => {
    const { askHref } = await model();
    const href = askHref(issue());
    expect(decodeURIComponent(href.split('?ask=')[1])).toBe('What happened to "iMessage"?');
  });
});

describe('Home', () => {
  const quiet = { count: 0, rows: [], all: [], state: 'ok', line: 'The queue is clear.' };
  const noPromises = { state: 'ok', count: 0, all: [], rows: [] };
  const known = (res) => ({ health: { results: { issues: res } } });

  it('internal notes leave Home quiet; a real problem counts, with a link to it', async () => {
    const { NEED_SOURCES, surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const { combineNeeds } = await import(path.join(CONSOLE, 'home-model.js'));
    const src = NEED_SOURCES.find((s) => s.id === 'health');
    expect(src.rows({ issues: answer('running', [issue({ impact: 'internal' })]) })).toEqual([]);
    const rows = src.rows({ issues: answer('attention', [issue()]) });
    expect(rows[0].action.href).toBe('#/capacity/health?s=iMessage');
    const m = combineNeeds(quiet, noPromises, { rows, pending: [], failed: [] });
    expect(m.count).toBe(1);
    expect(surfacedNeeds(known({ ok: true, status: 200, data: {} }), Date.now()).failed).toContain('health');
  });
});

describe('the page', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', { url: 'http://localhost/dashboard/console/#/capacity/health?s=GitSync.gitHygiene', pretendToBeVisual: true });
    const w = dom.window;
    for (const k of ['document', 'location', 'history', 'HTMLElement', 'Node', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[k] = w[k];
    globalThis.window = w; globalThis.CSS = { escape: (s) => s.replace(/[^\w-]/g, '\\$&') };
    globalThis.localStorage = w.localStorage; globalThis.sessionStorage = w.sessionStorage;
    w.scrollTo = vi.fn(); w.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('every problem has its fix and Ask; a linked internal note opens; internal notes are folded otherwise', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const main = document.querySelector('main');
    const res = answer('attention', [
      issue({ action: { label: 'Open Accounts', app: 'accounts', console: '#/capacity/accounts' } }),
      issue({ id: 'GitSync.gitHygiene', impact: 'internal', title: 'Background sync hit a snag' }),
    ], 'iMessage isn’t connected.');
    await renderHealth(main, { get: vi.fn(async () => res) });
    const need = main.querySelector('[data-operator-need="health"]');
    expect(need.hasAttribute('open')).toBe(true);
    expect([...need.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Open Accounts', 'Ask the agent about this']);
    expect(main.querySelector('[data-focus-key="h:GitSync.gitHygiene"]').hasAttribute('open')).toBe(true);
    expect(main.querySelector('details.list-section').hasAttribute('open')).toBe(true);
    expect(main.querySelector('h1').textContent).toBe('iMessage isn’t connected.');
  });

  it('a failed read says so', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const main = document.querySelector('main');
    await renderHealth(main, { get: vi.fn(async () => ({ ok: false, reason: 'the server answered 500' })) });
    expect(main.textContent).toContain('Couldn’t read my health'.replace('’', "'"));
  });
});
