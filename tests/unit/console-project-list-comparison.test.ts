// @ts-nocheck: exercise the browser-native modules with the real visit lifecycle.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderWork } from '../../dashboard/console/work.js';
import { projectsSection } from '../../dashboard/console/projects.js';
import { createLifecycle } from '../../dashboard/console/page-lifecycle.js';

let dom, lifecycle, session;
beforeEach(() => {
  dom = new JSDOM('<main></main>', { url: 'http://localhost/dashboard/console/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('location', dom.window.location);
  lifecycle = createLifecycle();
  session = 'dst_first';
});
afterEach(() => { lifecycle.dispose(); dom.window.close(); vi.unstubAllGlobals(); });

function mount(available = true, role = 'owner') {
  const visit = lifecycle.begin('work/board');
  const section = projectsSection({ projects: [], viewer: { role } }, {
    comparisonAvailable: available && role === 'owner',
    comparisonSession: { ...visit, sessionToken: () => session },
  });
  document.querySelector('main').append(section);
  return section;
}

function submit(section, view = 'differences') {
  section.querySelector('select').value = view;
  section.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
}

function reply(rows = [], status = 'partial', code = 200) {
  return { status: code, json: async () => ({
    schemaVersion: 1, status, rows, truncated: false,
    coverage: { projects: { status: 'complete' }, chiefOfStaff: { status: 'unavailable' } },
  }) };
}

const row = { ordinal: 1, state: 'counterpart-unchecked', projects: [
  { title: '<img src=x onerror=alert(1)>', ordinal: 2, titleTruncated: true },
], chiefOfStaff: [] };

describe('private Work Projects comparison', () => {
  it('requires a positive owner-scoped capability and a scoped browser token', () => {
    expect(mount(false).querySelector('form')).toBeNull();
    expect(mount(true, 'member').querySelector('form')).toBeNull();
    session = 'master-token';
    expect(mount().querySelector('form')).toBeNull();
  });

  it('opens the private comparison after older Work reads refuse the scoped token', async () => {
    localStorage.setItem('instar_token', 'dst_first');
    const visit = lifecycle.begin('work/board');
    const get = vi.fn(async () => ({ ok: false, status: 403, reason: 'the server answered 403' }));
    const fetch = vi.fn(async () => ({ status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const main = document.querySelector('main');
    await renderWork(main, { ...visit, get });
    expect(fetch).toHaveBeenCalledWith('/work/projects/compare',
      expect.objectContaining({ method: 'HEAD', headers: { Authorization: 'Bearer dst_first' } }));
    expect(get.mock.calls.map(args => args[0])).toEqual(['/work-board', '/work/projects']);
    const soft403 = get.mock.calls[0][2].soft403;
    expect(await soft403('dst_first')).toBe(true);
    expect(await soft403('dst_other')).toBe(false);
    expect(main.textContent).toContain('The projects could not be read');
    expect(main.textContent).toContain('Compare project lists');
    expect(main.querySelector('[data-comparison-row]')).toBeNull();
  });

  it('starts ordinary Work before a dark capability probe resolves', async () => {
    localStorage.setItem('instar_token', 'dst_first');
    const visit = lifecycle.begin('work/board');
    let finishProbe;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finishProbe = resolve; })));
    const get = vi.fn(async () => ({ ok: false, status: 503, reason: 'switched off on this agent' }));
    const main = document.querySelector('main');
    await renderWork(main, { ...visit, get });
    expect(get).toHaveBeenCalledTimes(2);
    expect(main.textContent).toContain('The projects could not be read');
    expect(main.textContent).not.toContain('Compare project lists');
    finishProbe({ status: 503 });
  });

  it('opens on normal empty Projects, runs manually, and renders only authorized plain text', async () => {
    const fetch = vi.fn(async () => reply([row]));
    vi.stubGlobal('fetch', fetch);
    const section = mount();
    expect(section.textContent).toContain('No projects are being tracked yet.');
    expect(fetch).not.toHaveBeenCalled();
    submit(section, 'all');
    expect(section.textContent).toContain('Checking the project lists');
    await vi.waitFor(() => expect(section.textContent).toContain('Only one list could be checked.'));
    expect(fetch).toHaveBeenCalledWith('/work/projects/compare?view=all',
      expect.objectContaining({ headers: { Authorization: 'Bearer dst_first' }, cache: 'no-store' }));
    const detail = section.querySelector('[data-comparison-row="1"]');
    detail.open = true;
    expect(detail.textContent).toContain('<img src=x onerror=alert(1)> (title shortened)');
    expect(detail.querySelector('img, a')).toBeNull();
    expect(section.textContent).toContain('Chief of Staff could not be checked.');
    expect(fetch).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
    expect(section.querySelector('[data-comparison-row]')).toBeNull();
    expect(section.textContent).not.toContain('onerror');
  });

  it('clears expanded results immediately on cross-tab session replacement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply([row])));
    const section = mount();
    submit(section);
    await vi.waitFor(() => expect(section.querySelector('[data-comparison-row]')).not.toBeNull());
    section.querySelector('[data-comparison-row]').open = true;
    session = 'dst_replacement';
    window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'instar_token', newValue: session }));
    expect(section.querySelector('[data-comparison-row]')).toBeNull();
    expect(section.querySelector('[aria-label="Compare project lists"]').hidden).toBe(true);
  });

  it('aborts on navigation and discards late old-session data even without a storage event', async () => {
    let release;
    const fetch = vi.fn(() => new Promise(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetch);
    let section = mount();
    submit(section);
    lifecycle.dispose();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    release(reply([row]));
    await Promise.resolve();

    section = mount();
    submit(section);
    session = 'dst_next';
    release(reply([row]));
    await vi.waitFor(() => expect(section.querySelector('[aria-label="Compare project lists"]').hidden).toBe(true));
    expect(section.textContent).not.toContain('onerror');
  });

  it('keeps empty matches, denied, busy and neither-checked states distinct', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply())
      .mockResolvedValueOnce(reply([], 'unavailable', 403))
      .mockResolvedValueOnce(reply([], 'unavailable', 429))
      .mockResolvedValueOnce(reply([], 'unavailable', 503)));
    const section = mount();
    for (const phrase of ['No verified matches in the checked rows.', 'cannot compare project lists',
      'comparison is already running', 'Neither list could be checked.']) {
      submit(section, 'matches');
      await vi.waitFor(() => expect(section.textContent).toContain(phrase));
    }
  });

  it('shows mixed coverage and opens all duplicate-title conflict entries without a fetch', async () => {
    const fetch = vi.fn(async () => ({ status: 200, json: async () => ({
      schemaVersion: 1, status: 'partial', truncated: true,
      coverage: { projects: { status: 'complete' }, chiefOfStaff: { status: 'partial' } },
      rows: [{ ordinal: 4, state: 'conflict', projects: [{ ordinal: 5, title: 'Same title' }],
        chiefOfStaff: [{ ordinal: 6, title: 'Same title' }, { ordinal: 7, title: 'Same title' }] }],
    }) }));
    vi.stubGlobal('fetch', fetch);
    const section = mount();
    submit(section);
    await vi.waitFor(() => expect(section.textContent).toContain('Chief of Staff partially checked.'));
    expect(section.textContent).toContain('Projects checked.');
    expect(section.textContent).toContain('Running the comparison again will not show the remaining rows.');
    const detail = section.querySelector('[data-comparison-row="4"]');
    detail.open = true;
    expect([...detail.querySelectorAll('[data-comparison-entry]')].map(entry => entry.dataset.comparisonEntry)).toEqual(['5', '6', '7']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
