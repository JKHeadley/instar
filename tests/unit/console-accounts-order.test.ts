import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { accountLayoutPreferences, buildAccountsPage, layoutAccounts } from '../../dashboard/console/accounts-model.js';
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
  it('defaults to provider groups and puts unknown measurements after known values', () => {
    const p = page([
      account('Later', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(90, 95) } }),
      account('Soon', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(10, 20) } }),
      account('No reading', { lastQuota: null }),
      account('Codex', { framework: 'codex-cli' }),
    ]);
    const names = (accounts: typeof p.accounts) => accounts.map(a => a.name);
    const groups = layoutAccounts(p.accounts);
    expect(groups.map(g => [g.name, names(g.accounts)])).toEqual([['Claude', ['Soon', 'Later', 'No reading']], ['Codex', ['Codex']]]);
    expect(names(layoutAccounts(p.accounts, { sort: 'used' })[0].accounts)).toEqual(['Later', 'Soon', 'No reading']);
    expect(names(layoutAccounts(p.accounts, { group: 'none', sort: 'name' })[0].accounts)).toEqual(['Codex', 'Later', 'No reading', 'Soon']);
    expect(accountLayoutPreferences({ group: 'invalid', sort: 'name' })).toEqual({ group: 'provider', sort: 'name' });
  });

  it('includes only present account slots when grouping by machine', () => {
    const p = page([
      account('Shared'),
      account('Shared', { machineId: 'mini', machineNickname: 'Mini' }),
      account('Studio only'),
    ]);
    const groups = layoutAccounts(p.accounts, { group: 'machine' });
    expect(groups.map(g => [g.name, g.accounts.map(a => a.name)])).toEqual([['Mini', ['Shared']], ['Studio', ['Shared', 'Studio only']]]);
    expect(groups[0].accounts[0].cells.map(c => c.machineId)).toEqual(['mini']);
    expect(p.accounts.find(a => a.name === 'Shared')!.cells).toHaveLength(2);
  });

  it('renders provider groups, remembers choices and keeps detail buttons working', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    dom = new JSDOM('<main class="main"></main>', { url: 'https://fixture.invalid/dashboard/console/#/capacity/accounts', pretendToBeVisual: true });
    for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location, localStorage: dom.window.localStorage, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window) })) vi.stubGlobal(k, v);
    const rows = [account('Claude Later', { lastQuota: { measuredAt: iso(-1), sevenDay: windowAt(90) } }), account('Codex Soon', { framework: 'codex-cli', lastQuota: { measuredAt: iso(-1), secondary: windowAt(10) } })];
    const get = vi.fn(async (path: string) => ({ ok: true, data: path.startsWith('/subscription-pool?') ? { enabled: true, accounts: rows, pool: { failed: [] } } : path.startsWith('/subscription-relogin?') ? { enabled: true, episodes: [], blockers: [] } : path === '/pool' ? { machines: [] } : path === '/subscription-pool/in-use' ? { activeAccountId: 'acct-Codex Soon' } : {} }));
    const main = document.querySelector('main')!;
    await renderAccounts(main, { get });
    expect(main.classList.contains('accounts-page')).toBe(true);
    expect([...main.querySelectorAll('.acct-list h3')].map(r => r.textContent)).toEqual(['Claude', 'Codex']);
    const controls = main.querySelectorAll<HTMLSelectElement>('.acct-layout select');
    const group = controls[0];
    expect(group.labels?.[0].textContent).toContain('Group by');
    expect(controls[1].value).toBe('reset');
    expect(main.querySelectorAll('.acct-tag')).toHaveLength(1);
    group.value = 'machine';
    group.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(main.querySelectorAll('.acct-tag')).toHaveLength(0);
    group.focus();
    group.value = 'none';
    const readCount = get.mock.calls.length;
    group.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(get).toHaveBeenCalledTimes(readCount);
    expect(document.activeElement).toBe(group);
    expect(main.querySelectorAll('.acct-list .list-section')).toHaveLength(1);
    expect([...main.querySelectorAll('.acct-row')].map(r => r.getAttribute('data-focus-key'))).toEqual(['a:acct-Codex Soon', 'a:acct-Claude Later']);
    await renderAccounts(main, { get });
    expect(main.querySelector<HTMLSelectElement>('.acct-layout select')?.value).toBe('none');
    expect(JSON.parse(localStorage.getItem('instar.accounts.layout')!)).toEqual({ group: 'none', sort: 'reset' });
    (main.querySelector('.acct-row') as HTMLButtonElement).click();
    expect(document.querySelector('.sheet-title')?.textContent).toBe('Codex Soon');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Codex');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Studio');
    expect(get.mock.calls.every(([path]) => path.startsWith('/'))).toBe(true);
  });
});
