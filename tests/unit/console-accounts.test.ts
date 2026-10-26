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
  it('an expired sign-in is the agent’s chore (never "needs you"); only a repair waiting on a tap is', () => {
    // A repair that stopped: expired, mine to restart — listed under expired with a Try-again, not counted as needing the operator.
    const p = buildAccountsPage(ok({ accounts: [row({}), row({ machineId: 'm2', machineNickname: 'Mac Mini', status: 'needs-reauth' })] }), NOW, {
      episodes: [{ id: 'e1', accountId: 'luna', machineId: 'm2', state: 'failed', updatedAt: iso(-10) }] });
    expect(p.headline).toBe('1 sign-in expired on Mac Mini — mine to repair; none needs your tap.');
    expect(p.needs).toEqual([]);
    expect(p.expired[0]).toMatchObject({ machine: 'Mac Mini', action: 'retry', episodeId: 'e1' });
    expect(p.facts.map((f) => f.label)).toContain('expired, mine to repair');
    // A repair offered for approval (approval mode, `suggested`) is the one tap that is the operator's.
    const t = buildAccountsPage(ok({ accounts: [row({}), row({ machineId: 'm2', machineNickname: 'Mac Mini', status: 'needs-reauth' })] }), NOW, {
      episodes: [{ id: 'e2', accountId: 'luna', machineId: 'm2', state: 'suggested', mode: 'approval', updatedAt: iso(-1) }] });
    expect(t.headline).toBe('1 sign-in needs you.');
    expect(t.needs[0]).toMatchObject({ machine: 'Mac Mini', action: 'approve', episodeId: 'e2' });
    expect(t.expired).toEqual([]);
    // No repair at all: expired, mine to fix; a Sign-in button is still offered.
    const q = buildAccountsPage(ok({ accounts: [row({ status: 'needs-reauth' })] }), NOW);
    expect(q.needs).toEqual([]);
    expect(q.expired[0].action).toBe('start');
    // A promise of the agent's about a sign-in that waits on the operator shows here too.
    const s = buildAccountsPage(ok({ accounts: [row({})] }), NOW, { promises: [{ id: 'CMT-1', status: 'pending', owner: 'user', blockedOn: 'user-authorization', createdAt: iso(-60), agentResponse: 'Sign the Claude login luna@x.io back in on the Laptop once you say go' }] });
    expect(s.headline).toBe('1 sign-in needs you.');
    expect(s.needs[0]).toMatchObject({ kind: 'promise', action: 'promise' });
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
    expect(cellState({ status: 'needs-reauth' }).state).toBe('attn');
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
    // An expired login is the agent's chore: it sits under the expired fold (with its button), never under "Needs you".
    expect(doc.querySelector('.page-title')!.textContent).toBe('1 sign-in expired on Mac Mini — mine to repair; none needs your tap.');
    expect(doc.querySelector('#sec-needs')).toBeNull();
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
