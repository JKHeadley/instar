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

  // ── Quick actions (docs/specs/health-quick-actions.md) ──

  const says = 'I’ll stop recording this problem.';
  const withChoices = (over = {}) => issue({ keys: ['iMessage'], choices: ['snooze', 'hide', 'ignore'], ignoreSays: says, ...over });
  const buttons = (root) => [...root.querySelectorAll('button')].map((b) => b.textContent);
  const click = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text).click();
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it('a problem offers what the answer says: one tap for each duration, and an older agent shows no buttons', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const main = document.querySelector('main');
    await renderHealth(main, { get: vi.fn(async () => answer('attention', [withChoices()])), post: vi.fn() });
    expect(buttons(main)).toEqual(['1 hour', '1 day', '1 week', 'Hide from me', 'Ignore completely']);
    await renderHealth(main, { get: vi.fn(async () => answer('attention', [issue()])), post: vi.fn() });
    expect(buttons(main)).toEqual([]);
    await renderHealth(main, { get: vi.fn(async () => answer('attention', [issue({ keys: ['x'], choices: ['snooze'], choiceNote: 'This one involves security or your data.' })])), post: vi.fn() });
    expect(buttons(main)).toEqual(['1 hour', '1 day', '1 week']);
    expect(main.textContent).toContain('This one involves security or your data.');
    await renderHealth(main, { get: vi.fn(async () => answer('unsure', [issue({ impact: 'unclassified', choices: [], choiceNote: 'This one has no name I can follow.' })])), post: vi.fn() });
    expect(buttons(main)).toEqual([]);
    expect(main.textContent).toContain('This one has no name I can follow.');
  });

  it('a duration is one tap, and the page reads again', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const main = document.querySelector('main');
    const get = vi.fn(async () => answer('attention', [withChoices()]));
    const post = vi.fn(async () => ({ ok: true, data: { note: null } }));
    await renderHealth(main, { get, post });
    click(main, '1 day');
    await settle();
    expect(post).toHaveBeenCalledWith('/mobile/health-issues/choices', { id: 'iMessage', keys: ['iMessage'], choice: 'snooze', hours: 24 });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('Ignore asks once, in its own sentence, with nothing to type', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const main = document.querySelector('main');
    const post = vi.fn(async () => ({ ok: true, data: {} }));
    await renderHealth(main, { get: vi.fn(async () => answer('attention', [withChoices()])), post });
    click(main, 'Ignore completely');
    expect(post).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain(says);
    expect(dialog.querySelector('input')).toBeNull();
    click(dialog, 'Ignore it');
    await settle();
    expect(post).toHaveBeenCalledWith('/mobile/health-issues/choices', { id: 'iMessage', keys: ['iMessage'], choice: 'ignore' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('a refused choice says why in plain words and changes nothing', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const main = document.querySelector('main');
    const get = vi.fn(async () => answer('attention', [withChoices()]));
    await renderHealth(main, { get, post: vi.fn(async () => ({ ok: false, reason: 'issue-gone' })) });
    click(main, 'Hide from me');
    await settle();
    expect(main.textContent).toContain('This has stopped happening');
    expect(main.textContent).not.toContain('issue-gone');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('a machine that didn’t answer is said on the page', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const main = document.querySelector('main');
    await renderHealth(main, { get: vi.fn(async () => answer('attention', [withChoices()])), post: vi.fn(async () => ({ ok: true, data: { note: 'Saved. One machine didn’t answer.' } })) });
    click(main, 'Hide from me');
    await settle();
    expect(main.textContent).toContain('Saved. One machine didn’t answer.');
  });

  const hiddenRow = (over = {}) => ({ key: 'Slack', title: 'Slack isn’t connected', mode: 'snooze', until: new Date(Date.now() + 3 * 3600_000).toISOString(), by: 'phone', happening: true, line: 'It’s happening now.', ...over });
  const withHidden = (hidden) => ({ ok: true, status: 200, data: { verdict: 'running', headline: 'Running, with one thing you’ve hidden.', issues: [], truncated: false, hidden } });

  it('the Hidden list brings one back, says when and who, and never counts on Home', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const { healthNeedRows } = await model();
    const main = document.querySelector('main');
    const post = vi.fn(async () => ({ ok: true, data: {} }));
    await renderHealth(main, { get: vi.fn(async () => withHidden([hiddenRow()])), post });
    expect(main.querySelector('details.list-section summary').textContent).toBe('Hidden (1)');
    expect(main.textContent).toContain('Comes back in 3 hours');
    expect(main.textContent).toContain('Hidden from your phone');
    expect([...main.querySelectorAll('a')].map((a) => a.textContent)).toContain('Ask the agent about this');
    expect(main.querySelector('[data-operator-need]')).toBeNull();
    expect(healthNeedRows(withHidden([hiddenRow()]))).toEqual([]);
    click(main, 'Bring back');
    await settle();
    expect(post).toHaveBeenCalledWith('/mobile/health-issues/choices/undo', { key: 'Slack' });
  });

  it('a row says who when it wasn’t the phone, and when it can’t be read, says so', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const main = document.querySelector('main');
    await renderHealth(main, { get: vi.fn(async () => withHidden([hiddenRow({ mode: 'ignore', until: null, by: 'dashboard-or-agent', happening: null })])), post: vi.fn() });
    expect(main.textContent).toContain('Ignored');
    expect(main.textContent).toContain('Hidden from the dashboard, or by the agent');
    const unread = withHidden([]);
    unread.data.hiddenUnreadable = true;
    await renderHealth(main, { get: vi.fn(async () => unread), post: vi.fn() });
    expect(main.textContent).toContain('couldn’t read what you’ve hidden');
  });

  it('a problem that came back says it was hidden before', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const main = document.querySelector('main');
    await renderHealth(main, { get: vi.fn(async () => answer('attention', [withChoices({ returnNote: 'You hid this earlier. It stopped, and then it came back.' })])), post: vi.fn() });
    expect(main.textContent).toContain('It stopped, and then it came back.');
  });

  it('a failed read says so', async () => {
    const { renderHealth } = await import(path.join(CONSOLE, 'health.js'));
    const main = document.querySelector('main');
    await renderHealth(main, { get: vi.fn(async () => ({ ok: false, reason: 'the server answered 500' })) });
    expect(main.textContent).toContain('Couldn’t read my health'.replace('’', "'"));
  });
});
