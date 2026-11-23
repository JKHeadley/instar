import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { silentComputerReviewModel, silentComputerReview } from '../../dashboard/console/silent-computers.js';

const fingerprint = '0123456789abcdef';
const ok = (over: Record<string, unknown> = {}) => ({ ok: true, data: { enabled: true, show: true, evidenceComplete: true, heldBack: true,
  fingerprint, dismissed: false, rows: [{ machineId: 'm_0123456789abcdef', name: 'Laptop', silentSince: '2026-11-10T12:00:00Z', confirmedGone: false }], ...over } });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('silent computer review model', () => {
  it('distinguishes switched off, hidden and unknown reads without inferring silence', () => {
    expect(silentComputerReviewModel({ ok: false, status: 503 }).state).toBe('off');
    expect(silentComputerReviewModel(ok({ enabled: false })).state).toBe('off');
    expect(silentComputerReviewModel(ok({ show: false })).state).toBe('hidden');
    for (const res of [null, { ok: false, status: 404 }, { ok: false, status: 500 }, { ok: true, data: {} }, ok({ rows: [] }), ok({ fingerprint: 'bad' })]) {
      expect(silentComputerReviewModel(res).state).toBe('unknown');
    }
    expect(silentComputerReviewModel(ok({ show: false, evidenceComplete: false }))).toMatchObject({ state: 'hidden', incomplete: true });
  });
  it('keeps the server show decision, incomplete evidence, all rows and confirmation status', () => {
    const res = ok({ dismissed: true, evidenceComplete: false, rows: [
      { machineId: 'm_0123456789abcdef', name: 'Laptop', confirmedGone: false, silentSince: '2026-11-10T12:00:00Z' },
      { machineId: 'm_fedcba9876543210', name: 'Old Mac', confirmedGone: true, silentSince: null },
    ] });
    expect(silentComputerReviewModel(res)).toMatchObject({ state: 'review', incomplete: true, rows: [{ name: 'Laptop', confirmedGone: false }, { name: 'Old Mac', confirmedGone: true, silentSince: null }] });
  });
  it('never substitutes a raw machine id for a name or decides eligibility from a timestamp', () => {
    const m = silentComputerReviewModel(ok({ rows: [{ machineId: 'm_0123456789abcdef', name: 'm_0123456789abcdef', confirmedGone: false, silentSince: new Date().toISOString() }] }));
    expect(m.state).toBe('review');
    expect(m.rows[0].name).toBe('A computer whose name is unavailable');
  });
});

describe('silent computer review panel', () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM('<main></main>', { url: 'https://example.test/dashboard/console/#/capacity/machines?review=silent' });
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('location', dom.window.location);
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));
  });
  afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
  function mount(res = ok(), overrides: Record<string, unknown> = {}) {
    const post = vi.fn(async () => ({ ok: true, data: { ok: true } }));
    const refresh = vi.fn(async () => {});
    const panel = silentComputerReview(res, { post, refresh, isCurrent: () => true, ...overrides });
    if (panel) document.querySelector('main')!.append(panel);
    return { panel, post, refresh, button: panel?.querySelector('button') as HTMLButtonElement };
  }
  it('shows one marked panel and only the reminder dismissal action; names stay text', () => {
    const { panel } = mount(ok({ evidenceComplete: false, rows: [{ machineId: 'm_0123456789abcdef', name: '<img src=x onerror=alert(1)>', confirmedGone: false, silentSince: '2026-11-10T12:00:00Z' }] }));
    expect(panel?.getAttribute('data-operator-need')).toBe('machine-retirement');
    expect(panel?.textContent).toContain('Some computers could not be checked.');
    expect(panel?.textContent).toContain('Instar app on your phone');
    expect(panel?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(panel?.textContent).not.toContain('m_0123456789abcdef');
    expect(panel?.querySelector('img')).toBeNull();
    expect([...panel!.querySelectorAll('button')].map(x => x.textContent)).toEqual(['Dismiss for now']);
  });
  it('labels confirmed computers and distinguishes a waiting split from reserved allowance', () => {
    const { panel } = mount(ok({ heldBack: false, rows: [{ machineId: 'm_0123456789abcdef', name: 'Old Mac', confirmedGone: true, silentSince: null }] }));
    expect(panel?.textContent).toContain('Confirmed gone for good');
    expect(panel?.textContent).toContain('keeping the PIN guess limit lower');
    expect(panel?.textContent).not.toContain('A change to how the limit is split');
    expect(panel?.textContent).toContain('Use your phone if you want to retire it');
  });
  it('the real Machines page keeps the review when its ordinary pool read fails and delegates dismissal', async () => {
    const { renderMachines } = await import('../../dashboard/console/machines.js');
    let dismissed = false;
    const get = vi.fn(async (url: string) => url === '/pin-budget/silent-machines' ? ok({ show: !dismissed }) : { ok: false, status: 500, reason: 'unavailable' });
    const post = vi.fn(async () => { dismissed = true; return { ok: true, data: { ok: true } }; });
    const main = document.querySelector('main')!;
    await renderMachines(main, { get, post, isCurrent: () => true });
    expect(main.querySelector('[data-operator-need="machine-retirement"]')).not.toBeNull();
    expect(main.querySelectorAll('.machine-card')).toHaveLength(0);
    (main.querySelector('#silent-computer-review button') as HTMLButtonElement).click();
    await flush(); await flush();
    expect(post).toHaveBeenCalledWith('/pin-budget/silent-machines/dismiss', { fingerprint });
    expect(main.querySelector('#silent-computer-review')).toBeNull();
    expect(main.textContent).toContain('reminder was dismissed');
  });
  it('a stale Machines read cannot replace the page after navigation', async () => {
    const { renderMachines } = await import('../../dashboard/console/machines.js');
    let resolve!: (value: unknown) => void;
    let current = true;
    const get = vi.fn((url: string) => url === '/pin-budget/silent-machines' ? new Promise(r => { resolve = r; }) : Promise.resolve({ ok: false, status: 500 }));
    const main = document.querySelector('main')!;
    const render = renderMachines(main, { get, post: vi.fn(), isCurrent: () => current });
    await flush();
    current = false; main.textContent = 'The next page';
    resolve(ok()); await render;
    expect(main.textContent).toBe('The next page');
  });
  it('hides off and settled reminders while retaining incomplete-check information', () => {
    expect(silentComputerReview({ ok: false, status: 503 })).toBeNull();
    expect(silentComputerReview(ok({ show: false }))).toBeNull();
    expect(silentComputerReview(ok({ show: false, evidenceComplete: false }))?.textContent).toContain('Some computers could not be checked.');
    expect(silentComputerReview({ ok: false, status: 404 })?.textContent).toContain('Could not check');
  });
  it('uses only the shown fingerprint to dismiss, never the machine id or either phone choice', async () => {
    const { button, post, refresh } = mount();
    button.click(); await flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/pin-budget/silent-machines/dismiss', { fingerprint });
    expect(refresh).toHaveBeenCalledWith(expect.stringContaining('reminder was dismissed'));
  });
  it('reloads a changed list without claiming it was dismissed', async () => {
    const refresh = vi.fn(async () => {});
    const { button } = mount(ok(), { post: vi.fn(async () => ({ ok: false, reason: 'list-changed' })), refresh });
    button.click(); await flush();
    expect(refresh).toHaveBeenCalledWith('The list changed. Review the current computers before dismissing it.');
  });
  it.each([{ ok: false, reason: 'pin-budget-off' }, { ok: true, data: { pending: true } }])('keeps the reminder on a failed or unrecognized save', async result => {
    const { panel, button, refresh } = mount(ok(), { post: vi.fn(async () => result) });
    button.click(); await flush();
    expect(refresh).not.toHaveBeenCalled();
    expect(panel?.textContent).toContain('could not be dismissed');
    expect(button.disabled).toBe(false);
  });
  it('submits once while busy and ignores a response after navigation', async () => {
    let resolve!: (value: unknown) => void;
    let current = true;
    const post = vi.fn(() => new Promise(r => { resolve = r; }));
    const { button, refresh } = mount(ok(), { post, isCurrent: () => current });
    button.click(); button.click();
    expect(post).toHaveBeenCalledTimes(1);
    current = false;
    resolve({ ok: true, data: { ok: true } }); await flush();
    expect(refresh).not.toHaveBeenCalled();
  });
});
