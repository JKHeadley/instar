/**
 * Console Accounts page (docs/specs/console-features/capacity.md, "Accounts"):
 * one row per account with its tightest window, machines as chips, sign-ins that
 * need the operator, honest partial and failure states, and the shipped sign-in
 * flow in jsdom: the body PIN is sent once and never kept.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildAccountsPage, tightest, cellState, resetWords } from '../../dashboard/console/accounts-model.js';

const NOW = Date.parse('2026-10-25T23:30:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const iso = (m: number) => new Date(NOW + m * 60_000).toISOString();
const row = (over: Record<string, unknown>) => ({ id: 'luna', nickname: 'Luna', email: 'luna@x.io', framework: 'claude-code', status: 'active', loginCheck: 'ok', machineId: 'm1', machineNickname: 'Mac Studio',
  lastQuota: { measuredAt: iso(-5), fiveHour: { utilizationPct: 30, resetsAt: iso(120) }, sevenDay: { utilizationPct: 60, resetsAt: iso(3000) } }, ...over });

describe('accounts page model', () => {
  it('fails honestly', () => {
    expect(buildAccountsPage({ ok: false, reason: 'x' }, NOW).ok).toBe(false);
    expect(buildAccountsPage(ok({ enabled: false }), NOW).reason).toContain('not set up');
    expect(buildAccountsPage(ok({ enabled: true }), NOW).ok).toBe(false);
  });
  it('shows each account once, with its freshest reading and every machine as a chip', () => {
    const p = buildAccountsPage(ok({ accounts: [row({}), row({ machineId: 'm2', machineNickname: 'Mac Mini', lastQuota: { measuredAt: iso(-1), sevenDay: { utilizationPct: 80, resetsAt: iso(100) } } })] }), NOW);
    expect(p.accounts).toHaveLength(1);
    expect(p.accounts[0].cells.map((c: { machine: string }) => c.machine)).toEqual(['Mac Studio', 'Mac Mini']);
    expect(p.accounts[0].tight.pct).toBe(80);
  });
  it('a cell needing sign-in is one needs-you item with the right action', () => {
    const p = buildAccountsPage(ok({ accounts: [row({}), row({ machineId: 'm2', machineNickname: 'Mac Mini', status: 'needs-reauth' })] }), NOW, {
      episodes: [{ id: 'e1', accountId: 'luna', machineId: 'm2', state: 'failed', updatedAt: iso(-10) }] });
    expect(p.headline).toBe('1 sign-in needs you.');
    expect(p.needs[0]).toMatchObject({ machine: 'Mac Mini', action: 'retry', episodeId: 'e1' });
    // An expired sign-in nothing is repairing is NOT "needs you": it is listed as expired, with a Sign in.
    const q = buildAccountsPage(ok({ accounts: [row({ status: 'needs-reauth' })] }), NOW);
    expect(q.needs).toEqual([]);
    expect(q.expired[0].action).toBe('start');
    expect(q.headline).not.toMatch(/needs you/);
  });
  it('names a machine that did not answer, never by its id', () => {
    const p = buildAccountsPage(ok({ accounts: [row({})], pool: { failed: [{ machineId: 'm9' }] } }), NOW, { names: { m9: 'Laptop' } });
    expect(p.partial).toContain('Laptop');
    expect(p.partial).not.toContain('m9');
  });
  it('reads the tightest window across kinds of reading', () => {
    expect(tightest({ fiveHour: { utilizationPct: 10 }, sevenDay: { utilizationPct: 70 } })!.label).toBe('weekly');
    expect(tightest({ primary: { usedPercent: 40 }, secondary: { usedPercent: 5 } })!.pct).toBe(40);
    expect(tightest(null)).toBeNull();
  });
  it('cell states in words', () => {
    expect(cellState({ status: 'active', loginCheck: 'ok' }).label).toBe('signed in');
    expect(cellState({ status: 'needs-reauth' }).state).toBe('expired');
    expect(cellState({ status: 'needs-reauth' }, { state: 'suggested' })).toMatchObject({ state: 'attn', label: 'repair ready; needs your tap' });
    expect(cellState({ status: 'needs-reauth' }, { state: 'failed' }).state).toBe('attn');
    expect(cellState({ status: 'needs-reauth' }, { state: 'running' }).label).toBe('signing in');
  });
  it('reset times only for the future', () => {
    expect(resetWords(iso(60), NOW)).toMatch(/^resets /);
    expect(resetWords(iso(-60), NOW)).toBeNull();
  });
});

describe('accounts page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());
  it('signs in a cell: asks the PIN, sends it once, shows the sign-in page link, sends the code', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/capacity/accounts' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const table: Record<string, unknown> = {
      '/sessions': { sessions: [] }, '/health': { project: { name: 'echo' } },
      '/subscription-pool?scope=pool': { enabled: true, accounts: [row({ status: 'needs-reauth', machineId: 'm2', machineNickname: 'Mac Mini' })], pool: { failed: [] } },
      '/subscription-relogin?scope=pool': { enabled: true, episodes: [] },
      '/subscription-pool/in-use': { enabled: true, activeAccountId: 'luna' },
      '/pool': { machines: [] },
    };
    g.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
      if (opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body || '{}');
        posts.push({ url, body });
        if (url === '/subscription-pool/matrix/start-cell') return { ok: true, status: 200, json: async () => ({ verificationUrl: 'https://claude.ai/oauth/x', loginId: 'L1', expectedEmail: 'luna@x.io' }) };
        if (url === '/subscription-pool/follow-me/submit-code') return { ok: true, status: 200, json: async () => ({ outcome: 'validated' }) };
      }
      const b = table[url];
      return b === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(b)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 15)); };
    await tick(15);
    const doc = dom.window.document;
    // No repair is running or waiting: the lapsed cell sits behind the Expired fold, never as "needs you".
    expect(doc.querySelector('.page-title')!.textContent).not.toMatch(/needs you/);
    expect(doc.querySelector('#sec-needs')).toBeNull();
    (doc.querySelector('#sec-expired .list-head') as HTMLButtonElement).click();
    (doc.querySelector('#sec-expired button.btn-quiet') as HTMLButtonElement).click();
    await tick(3);
    const pin = doc.querySelector('.pin-input') as HTMLInputElement;
    pin.value = '123456';
    (doc.querySelector('.pin-form') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await tick(5);
    expect(posts[0]).toEqual({ url: '/subscription-pool/matrix/start-cell', body: { accountId: 'luna', machineId: 'm2', pin: '123456' } });
    expect(doc.querySelector('.pin-input')).toBeNull(); // the PIN field is gone, nothing holds it
    expect((doc.querySelector('a.signin-link') as HTMLAnchorElement).getAttribute('href')).toBe('https://claude.ai/oauth/x');
    (doc.querySelector('.signin-steps .reason-input') as HTMLInputElement).value = 'abc-123';
    ([...doc.querySelectorAll('.signin-steps button')].find((b) => b.textContent === 'Send the code') as HTMLButtonElement).click();
    await tick(3);
    expect(posts[1]).toEqual({ url: '/subscription-pool/follow-me/submit-code', body: { machineId: 'm2', id: 'L1', code: 'abc-123' } });
    expect(doc.querySelector('.signin-steps .action-status')!.textContent).toBe('Signed in on Mac Mini.');
  });
});


describe('QA content fixes — Accounts', () => {
  const dawn = (over: Record<string, unknown>) => row({ id: 'dawn', nickname: 'Dawn', email: 'dawn@x.io', ...over });
  const self = { machineId: 'm1', nickname: 'Mac Studio' };
  it('states the scope: usable on THIS machine vs expired elsewhere; a repair waiting on a tap is the only "needs you"', () => {
    const p = buildAccountsPage(ok({ accounts: [
      row({}), row({ machineId: 'm2', machineNickname: 'Mac Mini', status: 'needs-reauth' }), row({ machineId: 'm3', machineNickname: 'Mama PC', status: 'needs-reauth' }),
      dawn({}), dawn({ machineId: 'm3', machineNickname: 'Mama PC', status: 'needs-reauth' }),
    ] }), NOW, { self, episodes: [{ id: 'e1', accountId: 'dawn', machineId: 'm3', state: 'suggested', updatedAt: iso(-10) }] });
    expect(p.headline).toBe('1 sign-in needs you.');
    expect(p.needs.map((n: { accountId: string; machine: string; action: string }) => [n.accountId, n.machine, n.action])).toEqual([['dawn', 'Mama PC', 'approve']]);
    expect(p.expired.map((n: { accountId: string; machine: string }) => [n.accountId, n.machine])).toEqual([['luna', 'Mac Mini'], ['luna', 'Mama PC']]);
    const facts = Object.fromEntries(p.facts.map((f: { label: string; n: unknown }) => [f.label, f.n]));
    expect(facts).toMatchObject({ 'needs your tap': 1, 'usable on Mac Studio': 2, 'expired elsewhere': 3 });
    expect(p.sub).toBe('2 accounts are usable on Mac Studio; 3 sign-ins have expired on other machines, 1 waiting for your tap.');
    // One row per account, naming the machines it waits on.
    expect(p.expiredRows).toHaveLength(1);
    expect(p.expiredRows[0]).toMatchObject({ accountId: 'luna', sub: 'Expired on Mac Mini and Mama PC; no repair is running.', action: 'open', single: null });
    expect(p.needsRows[0]).toMatchObject({ accountId: 'dawn', sub: 'An automatic repair is ready to run on Mama PC.', action: 'approve' });
    expect(p.needsRows[0].single.machine).toBe('Mama PC');
  });
  it('a repair the agent is running is neither needs-you nor expired; with no self machine the scope is "usable somewhere"', () => {
    const p = buildAccountsPage(ok({ accounts: [row({}), row({ machineId: 'm2', machineNickname: 'Mac Mini', status: 'needs-reauth' })] }), NOW, {
      episodes: [{ id: 'e2', accountId: 'luna', machineId: 'm2', state: 'running', updatedAt: iso(-1) }] });
    expect(p.needs).toEqual([]);
    expect(p.expired).toEqual([]);
    expect(p.accounts[0].cells[1]).toMatchObject({ state: 'working', label: 'signing in' });
    expect(p.facts.find((f: { label: string }) => f.label === 'usable somewhere')!.n).toBe(1);
    expect(p.facts.some((f: { label: string }) => /expired/.test(f.label))).toBe(false);
    expect(p.sub).toBe('');
  });
  it('"most used" is said in words, never as a bare percentage label', () => {
    const p = buildAccountsPage(ok({ accounts: [row({ lastQuota: { measuredAt: iso(-5), fable: { utilizationPct: 100, resetsAt: iso(120) }, sevenDay: { utilizationPct: 76 } } })] }), NOW, { self });
    const f = p.facts.find((x: { label: string }) => /most used/.test(x.label))!;
    expect(f).toMatchObject({ n: 'Luna', label: 'most used: all of its Fable weekly limit', tone: 'bad' });
    const q = buildAccountsPage(ok({ accounts: [row({})] }), NOW, { self });
    expect(q.facts.find((x: { label: string }) => /most used/.test(x.label))).toMatchObject({ n: 'Luna', label: 'most used: 60% of its weekly limit' });
    expect(q.facts.some((x: { label: string }) => x.label === 'most used · Luna')).toBe(false);
  });
});
