import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildAccountsPage } from '../../dashboard/console/accounts-model.js';
import { renderAccounts } from '../../dashboard/console/accounts.js';
import { closeSheet } from '../../dashboard/console/ui.js';
const NOW = Date.parse('2026-11-23T20:00:00Z');
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const windowAt = (minutes: number, pct = 20) => ({ utilizationPct: pct, resetsAt: iso(minutes) });
const account = (id: string, over: Record<string, any> = {}) => ({ id: `acct-${id}`, nickname: id, email: `${id.toLowerCase().replaceAll(' ', '-')}@example.test`, framework: 'claude-code', status: 'active', loginCheck: 'ok', machineId: 'studio', machineNickname: 'Studio', lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(60) }, ...over });
const page = (rows: any[], now = NOW) => buildAccountsPage({ ok: true, data: { enabled: true, accounts: rows, pool: { failed: [] } } }, now);
let dom: JSDOM;
afterEach(() => { closeSheet(); dom?.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Accounts default reset ordering', () => {
  it('orders across services by reset rather than grouping services or putting highest use first', () => {
    const rows = [account('Claude Later', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(90, 100) } }), account('Codex Soon', { framework: 'codex-cli', lastQuota: { measuredAt: iso(-1), secondary: windowAt(10, 5) } })];
    expect(page(rows).accounts.map(a => a.name)).toEqual(['Codex Soon', 'Claude Later']);
  });
  it('ignores a sooner five-hour reset and orders by the weekly quota deadline', () => {
    const p = page([account('Later', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(30, 80) } }), account('Soon', { lastQuota: { measuredAt: iso(-1), fiveHour: windowAt(5, 10), sevenDay: windowAt(3000, 99) } })]);
    expect(p.accounts.map(a => a.name)).toEqual(['Later', 'Soon']);
    expect(p.accounts[1].weeklyResetAt).toBe(Date.parse(iso(3000)));
    expect(p.accounts[1].tight.pct).toBe(99);
  });
  it('supports both primary/secondary and fiveHour/sevenDay quota formats', () => {
    const p = page([account('Claude', { lastQuota: { measuredAt: iso(-1), fiveHour: windowAt(20), sevenDay: windowAt(90) } }), account('Codex', { framework: 'codex-cli', lastQuota: { measuredAt: iso(-1), primary: { usedPercent: 50, resetsAtIso: iso(10) }, secondary: windowAt(40) } })]);
    expect(p.accounts.map(a => a.name)).toEqual(['Codex', 'Claude']);
  });
  it.each(['missing', 'invalid', 'past', 'exactly now', 'no reading'])('keeps an account with %s reset after known future resets', kind => {
    const q = kind === 'no reading' ? null : { measuredAt: iso(-1), sevenDay: { utilizationPct: 95, ...(kind === 'missing' ? {} : { resetsAt: kind === 'invalid' ? 'invalid-date' : kind === 'past' ? iso(-5) : iso(0) }) } };
    const p = page([account('Unknown', { lastQuota: q }), account('Future', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(100, 1) } })]);
    expect(p.accounts.map(a => a.name)).toEqual(['Future', 'Unknown']);
    expect(p.accounts[1].weeklyResetAt).toBeNull();
  });
  it('ignores a rolled-over window and uses the next future window', () => {
    const p = page([account('Rolled', { lastQuota: { measuredAt: iso(-10), fiveHour: windowAt(-1, 100), sevenDay: windowAt(90, 10) } }), account('First', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(30, 5) } })]);
    expect(p.accounts.map(a => a.name)).toEqual(['First', 'Rolled']);
    expect(p.accounts[1].windows[0].rolledOver).toBe(true);
  });
  it('uses the freshest machine reading and still shows each account once', () => {
    const p = page([account('Shared', { lastQuota: { measuredAt: iso(-30), sevenDay: windowAt(1) } }), account('Shared', { machineId: 'laptop', machineNickname: 'Laptop', lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(90) } }), account('First', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(30) } })]);
    expect(p.accounts.map(a => a.name)).toEqual(['First', 'Shared']);
    expect(p.accounts[1].cells).toHaveLength(2);
  });
  it('keeps equal deadlines and unknown deadlines stable by name then account id', () => {
    const rows = [account('z', { nickname: 'Same' }), account('b', { nickname: 'Beta', lastQuota: null }), account('a', { nickname: 'Alpha', lastQuota: null }), account('a-id', { nickname: 'Same' })];
    expect(page(rows).accounts.map(a => a.id)).toEqual(['acct-a-id', 'acct-z', 'acct-a', 'acct-b']);
    expect(page([...rows].reverse()).accounts.map(a => a.id)).toEqual(['acct-a-id', 'acct-z', 'acct-a', 'acct-b']);
  });
  it('keeps a known weekly reset ahead of a short-window-only or specialist-only account', () => {
    const p = page([account('Short Only', { lastQuota: { measuredAt: iso(-1), fiveHour: windowAt(1, 99) } }), account('Specialist Only', { lastQuota: { measuredAt: iso(-1), fable: windowAt(1, 99) } }), account('Weekly', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(3000, 5) } })]);
    expect(p.accounts.map(a => a.name)).toEqual(['Weekly', 'Short Only', 'Specialist Only']);
    expect(p.accounts[1].windows[0].label).toBe('5-hour');
    expect(p.accounts[1].weeklyResetAt).toBeNull();
  });
  it('keeps an expired weekly account last even while its five-hour reset is still in the future', () => {
    const p = page([account('Expired Weekly', { lastQuota: { measuredAt: iso(-1), fiveHour: windowAt(1), sevenDay: windowAt(-1) } }), account('Weekly', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(3000) } })]);
    expect(p.accounts.map(a => a.name)).toEqual(['Weekly', 'Expired Weekly']);
  });
  it('moves expired timestamps behind future resets as time advances', () => {
    const rows = [account('Soon', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(1) } }), account('Later', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(60) } })];
    expect(page(rows).accounts.map(a => a.name)).toEqual(['Soon', 'Later']);
    expect(page(rows, NOW + 2 * 60_000).accounts.map(a => a.name)).toEqual(['Later', 'Soon']);
  });
  it('renders one global ordered list with service labels and working detail buttons', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    dom = new JSDOM('<main class="main"></main>', { url: 'https://fixture.invalid/dashboard/console/#/capacity/accounts', pretendToBeVisual: true });
    for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location, localStorage: dom.window.localStorage, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window) })) vi.stubGlobal(k, v);
    const rows = [account('Claude Later', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(90) } }), account('Codex Soon', { framework: 'codex-cli', lastQuota: { measuredAt: iso(-1), secondary: windowAt(10) } })];
    const get = vi.fn(async (path: string) => ({ ok: true, data: path.startsWith('/subscription-pool?') ? { enabled: true, accounts: rows, pool: { failed: [] } } : path.startsWith('/subscription-relogin?') ? { enabled: true, episodes: [], blockers: [] } : path === '/pool' ? { machines: [] } : {} }));
    const main = document.querySelector('main')!;
    await renderAccounts(main, { get });
    expect(main.classList.contains('accounts-page')).toBe(true);
    expect(main.querySelectorAll('.acct-list .list-section')).toHaveLength(1);
    expect([...main.querySelectorAll('.acct-row')].map(r => r.getAttribute('data-focus-key'))).toEqual(['a:acct-Codex Soon', 'a:acct-Claude Later']);
    expect([...main.querySelectorAll('.acct-kind')].map(r => r.textContent)).toEqual(['Codex', 'Claude']);
    expect(main.textContent).toContain('Weekly reset, soonest first');
    (main.querySelector('.acct-row') as HTMLButtonElement).click();
    expect(document.querySelector('.sheet-title')?.textContent).toBe('Codex Soon');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Codex');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Studio');
    expect(get.mock.calls.every(([path]) => path.startsWith('/'))).toBe(true);
  });
});
