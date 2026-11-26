/**
 * Console Accounts page (docs/specs/console-features/capacity.md, "Accounts"):
 * one row per account with its tightest window, machines as chips, sign-ins that
 * need the operator, honest partial and failure states, and the shipped sign-in
 * flow in jsdom: the body PIN is sent once and never kept.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { buildAccountsPage, tightest, cellState, resetWords, usageWindows, untilWords } from '../../dashboard/console/accounts-model.js';

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
  it('puts ordinary sign-in gaps and stopped repairs in the agent status area', () => {
    const p = buildAccountsPage(ok({ accounts: [row({}), row({ machineId: 'm2', machineNickname: 'Mac Mini', status: 'needs-reauth' })] }), NOW, {
      episodes: [{ id: 'e1', accountId: 'luna', machineId: 'm2', state: 'failed', updatedAt: iso(-10) }] });
    expect(p.headline).toBe('Account usage');
    expect(p.needs).toEqual([]);
    expect(p.repairs).toEqual([expect.objectContaining({ machine: 'Mac Mini', rows: [
      expect.objectContaining({ status: 'Last repair stopped. Waiting for the agent to review it.', ownerAction: null }),
    ] })]);
    const q = buildAccountsPage(ok({ accounts: [row({ status: 'needs-reauth' })] }), NOW);
    expect(q.needs).toEqual([]);
    expect(q.repairs[0].rows[0].status).toBe('Sign-in needs checking by the agent');
  });
  it('keeps usage-only cards and distinguishes an empty machine from a failed read', () => {
    const p = buildAccountsPage(ok({
      accounts: [row({}), row({ id: 'repair', nickname: 'Repair account', status: 'needs-reauth', lastQuota: null })],
      pool: { answeredMachines: [{ machineId: 'm2', nickname: 'Empty Mini' }, { machineId: 'm3', nickname: 'Offline Laptop' }],
        failed: [{ machineId: 'm3', nickname: 'Offline Laptop' }] },
    }), NOW);
    expect(p.usageAccounts.map(a => a.name)).toEqual(['Luna']);
    expect(p.repairs.map(group => group.machine)).toEqual(['Empty Mini', 'Mac Studio']);
    expect(p.repairs[0].rows.map(row => row.status)).toEqual([
      'Waiting for the agent to set up this account', 'Waiting for the agent to set up this account',
    ]);
    expect(p.partial).toContain('Offline Laptop');
    expect(p.needs).toEqual([]);
  });
  it('summarizes a large machine roster and collects all-ready machines', () => {
    const accounts = Array.from({ length: 14 }, (_, index) => {
      const account = { id: `fixture-${index}`, nickname: `Account ${index}` };
      const ready = ['Studio', 'Laptop', 'Spare', 'Bench'].map(machine => row({ ...account, machineId: `fixture-${machine.toLowerCase()}`, machineNickname: machine }));
      return index < 10 ? [...ready, row({ ...account, machineId: 'mini', machineNickname: 'Mini' })] : ready;
    }).flat();
    const p = buildAccountsPage(ok({ accounts }), NOW);
    expect(p.repairs).toEqual([expect.objectContaining({ machine: 'Mini', total: 14, signedIn: 10, rows: expect.any(Array) })]);
    expect(p.repairs[0].rows).toHaveLength(4);
    expect(p.signedInMachines).toEqual(['Bench', 'Laptop', 'Spare', 'Studio']);
  });
  it('keeps an active but unchecked login outside the all-signed-in summary', () => {
    const p = buildAccountsPage(ok({ accounts: [row({ loginCheck: 'unavailable' })] }), NOW);
    expect(p.signedInMachines).toEqual([]);
    expect(p.repairs[0]).toMatchObject({ total: 1, signedIn: 0,
      rows: [{ status: 'Waiting for the agent to recheck the sign-in', ownerAction: null }] });
  });
  it('an unconfirmed or blocked sign-in is shown but is not "needs you"', () => {
    const noIncident = buildAccountsPage(ok({ accounts: [row({ status: 'needs-reauth', loginCheck: 'unavailable' })] }), NOW, {
      blockers: [{ accountId: 'luna', machineId: 'm1', reason: 'no-open-incident' }],
      episodes: [{ id: 'old', accountId: 'luna', machineId: 'm1', state: 'failed', updatedAt: iso(-90000) }] });
    expect(noIncident.needs).toHaveLength(0);
    expect(noIncident.headline).not.toContain('needs you');
    expect(noIncident.accounts[0].cells[0]).toMatchObject({ state: 'waiting', label: 'sign-in not confirmed; still checking' });
    // Shown on its row only; no "nothing for you to do" line at the top.
    expect(noIncident.repairs[0].rows[0].ownerAction).toBeNull();
    expect(noIncident.notices).toEqual([]);
    const blocked = buildAccountsPage(ok({ accounts: [row({ status: 'needs-reauth' })] }), NOW, { blockers: [{ accountId: 'luna', machineId: 'm1', reason: 'profile-unresolved' }] });
    expect(blocked.needs).toHaveLength(0);
    expect(blocked.accounts[0].cells[0].label).toBe("automatic repair can't start yet");
  });
  it('only an exact device-limit decision is presented as an owner step', () => {
    const other = buildAccountsPage(ok({ accounts: [row({ status: 'needs-reauth' })] }), NOW, { blockers: [{ accountId: 'luna', machineId: 'm2', reason: 'no-open-incident' }] });
    expect(other.needs).toHaveLength(0);
    const device = buildAccountsPage(ok({ accounts: [row({ status: 'needs-reauth' })] }), NOW, { blockers: [{ accountId: 'luna', machineId: 'm1', reason: 'device-limit-benched' }] });
    expect(device.needs).toHaveLength(1);
  });
  it('a slot stuck on another login remains agent work even though the account reads active', () => {
    const p = buildAccountsPage(ok({ accounts: [row({ identityDrifted: true, loginCheck: 'unavailable',
      identityDrift: { actualAccountId: 'sagemind-echo', actualEmail: 'echo@x.io', repairState: 'planned', detectedAt: iso(-60 * 24 * 10) } })] }), NOW, {
      episodes: [{ id: 'old', accountId: 'luna', machineId: 'm1', state: 'failed', updatedAt: iso(-90000) }] });
    expect(p.headline).toBe('Account usage');
    expect(p.needs).toEqual([]);
    expect(p.repairs[0].rows[0]).toMatchObject({ ownerAction: null, status: 'Last repair stopped. Waiting for the agent to review it.' });
  });
  it('a fresh or repairing wrong login may correct itself, so it is shown but not counted', () => {
    const drift = (over: Record<string, unknown>) => buildAccountsPage(ok({ accounts: [row({ identityDrifted: true,
      identityDrift: { actualAccountId: 'sagemind-echo', actualEmail: 'echo@x.io', repairState: 'planned', ...over } })] }), NOW);
    expect(drift({ detectedAt: iso(-30) }).needs).toHaveLength(0);
    expect(drift({ detectedAt: iso(-30) }).accounts[0].cells[0].state).toBe('waiting');
    expect(drift({ detectedAt: iso(-60 * 24 * 10), repairState: 'repairing' }).needs).toHaveLength(0);
    // An undated drift cannot be called fresh.
    expect(drift({}).repairs[0].rows[0].ownerAction).toBeNull();
  });
  it('ordinary missing logins are agent work; explicit owner-only recovery stays actionable', () => {
    const gone = buildAccountsPage(ok({ accounts: [row({ identityDrifted: true, identityDrift: { actualAccountId: 'missing-local-login', detectedAt: iso(-1) } })] }), NOW);
    expect(gone.needs).toHaveLength(0);
    expect(gone.accounts[0].cells[0].label).toBe('needs sign-in');
    const owner = buildAccountsPage(ok({ accounts: [row({ identityDrifted: true, identityDrift: { actualAccountId: 'x', repairState: 'owner-relogin-required', detectedAt: iso(-1) } })] }), NOW);
    expect(owner.needs).toHaveLength(1);
  });
  describe('a machine that answered but lacks an account (rebuilt or offline when it was added)', () => {
    const two = (over: Record<string, unknown> = {}) => [
      row({}),
      row({ machineId: 'm2', machineNickname: 'Mac Mini' }),
      row({ id: 'gear', nickname: 'Gear', email: 'gear@x.io', machineId: 'm2', machineNickname: 'Mac Mini', ...over }),
    ];
    it('shows a missing cell with a quiet Set up, never as needs-you', () => {
      const p = buildAccountsPage(ok({ accounts: two(), pool: { failed: [] } }), NOW);
      const gear = p.accounts.find((a: any) => a.id === 'gear');
      const studio = gear.cells.find((c: any) => c.machineId === 'm1');
      expect(studio).toMatchObject({ state: 'missing', label: 'not on this machine', missing: true, machine: 'Mac Studio', actionable: true });
      expect(p.needs).toHaveLength(0);
      expect(p.headline).toBe('Account usage');
    });
    it('a missing cell does not make an account "not ready" or a machine "empty"', () => {
      const p = buildAccountsPage(ok({ accounts: two(), pool: { failed: [] } }), NOW);
      expect(p.facts[0]).toEqual({ n: '2', label: 'accounts with usage data' });
      expect(p.notices).toEqual([]);
    });
    it('a machine that did not answer is unknown, not missing', () => {
      const p = buildAccountsPage(ok({ accounts: two(), pool: { failed: [{ machineId: 'm1' }] } }), NOW);
      const gear = p.accounts.find((a: any) => a.id === 'gear');
      expect(gear.cells.map((c: any) => c.machineId)).toEqual(['m2']);
    });
    it('a sign-in already running for the missing machine shows as signing in', () => {
      const p = buildAccountsPage(ok({ accounts: two(), pool: { failed: [] } }), NOW, {
        episodes: [{ id: 'e1', accountId: 'gear', machineId: 'm1', state: 'running', updatedAt: iso(-1) }],
      });
      const studio = p.accounts.find((a: any) => a.id === 'gear').cells.find((c: any) => c.machineId === 'm1');
      expect(studio).toMatchObject({ state: 'working', label: 'signing in', missing: true });
    });
    it('no missing cell when every answered machine holds the account', () => {
      const p = buildAccountsPage(ok({ accounts: [row({}), row({ machineId: 'm2', machineNickname: 'Mac Mini' })], pool: { failed: [] } }), NOW);
      expect(p.accounts[0].cells.every((c: any) => !c.missing)).toBe(true);
    });
  });

  it('withholds sign-in actions when account or machine names cannot identify one target', () => {
    const unnamed = buildAccountsPage(ok({ accounts: [row({ id: 'acct1', nickname: 'acct1', email: null, status: 'needs-reauth' })] }), NOW);
    expect(unnamed.needs).toHaveLength(0);
    expect(unnamed.headline).not.toContain('needs you');
    expect(unnamed.accounts[0].name).not.toContain('acct1');
    const duplicateMachine = buildAccountsPage(ok({ accounts: [
      row({ status: 'needs-reauth' }),
      row({ id: 'other', nickname: 'Other', email: 'other@x.io', machineId: 'm2', machineNickname: 'Mac Studio', status: 'needs-reauth' }),
    ] }), NOW);
    expect(duplicateMachine.needs).toHaveLength(0);
  });
  describe('notices: only what needs the person or changes what they can do', () => {
    const at = (id: string, pct: number, over: Record<string, unknown> = {}, reset = 60) => row({ id, nickname: id, email: `${id}@x.io`, lastQuota: { measuredAt: iso(-5), fiveHour: { utilizationPct: pct, resetsAt: iso(reset) } }, ...over });
    const page = (rows: unknown[], extra: Record<string, unknown> = {}) => buildAccountsPage(ok({ accounts: rows, ...extra }), NOW);
    it('the reported case: two accounts full, others with room, is no notice and no warning title', () => {
      const p = page([at('Adriana', 100), at('Echo', 100), at('Dawn', 89), at('Luna', 73)]);
      expect(p.notices).toEqual([]);
      expect(p.headline).toBe('Account usage');
      expect(p.tone).toBe('ok');
      expect(p.sub).toContain('when it resets');
      expect(p.facts.every((f: { tone?: string }) => !f.tone)).toBe(true);
    });
    it('every account full: one notice with when room returns and an ask', () => {
      const p = page([at('A', 100, {}, 300), at('B', 95, {}, 30)]);
      expect(p.notices).toEqual([{ key: 'room:Claude', tone: 'attn', title: 'All 2 Claude accounts are nearly out.', returnsAt: iso(30), action: { kind: 'ask', about: 'All 2 Claude accounts are nearly out.' } }]);
      expect(page([at('A', 100)]).notices[0]).toMatchObject({ tone: 'bad', title: 'The only Claude account is used up.' });
    });
    it('one framework out while another has room names that framework only', () => {
      const p = page([at('A', 20), at('X', 100, { framework: 'codex-cli', lastQuota: { measuredAt: iso(-5), primary: { usedPercent: 100, resetsAtIso: iso(40) } } })]);
      expect(p.notices.map((n: { title: string }) => n.title)).toEqual(['The only Codex account is used up.']);
      expect(p.notices[0].returnsAt).toBe(iso(40));
    });
    it('an unread account may have room, so no conclusion', () => {
      expect(page([at('A', 100), row({ id: 'B', nickname: 'B', email: 'b@x.io', lastQuota: null })]).notices).toEqual([]);
    });
    it('sign-in gaps appear separately from usage notices', () => {
      const p = page([at('A', 10), at('A', 10, { machineId: 'm2', machineNickname: 'Mac Mini', status: 'needs-reauth' })]);
      expect(p.notices).toEqual([]);
      expect(p.repairs[0]).toMatchObject({ machine: 'Mac Mini', rows: [{ ownerAction: null }] });
      expect(p.headline).toBe('Account usage');
      expect(page([at('A', 10), at('A', 10, { machineId: 'm2', machineNickname: 'Mac Mini', status: 'warming' })]).notices).toEqual([]);
      expect(page([at('A', 10, { machineId: 'm2', machineNickname: 'Mac Mini' }), at('B', 10, { machineId: 'm2', machineNickname: 'Mac Mini', status: 'needs-reauth' })]).notices).toEqual([]);
    });
    it('a partial read scopes its conclusion', () => {
      expect(page([at('A', 100)], { pool: { failed: [{ machineId: 'm9' }] } }).notices[0].title).toBe('The only Claude account is used up (on the machines that answered).');
    });
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
  it('shows each limit on its own line with its own reset, 5-hour only when the account has one', () => {
    const p = buildAccountsPage(ok({ accounts: [row({ lastQuota: { measuredAt: iso(-1), fiveHour: { utilizationPct: 100, resetsAt: iso(3) }, sevenDay: { utilizationPct: 49, resetsAt: iso(2000) }, fable: { utilizationPct: 24, resetsAt: iso(2000) } } })] }), NOW);
    const w = p.accounts[0].windows;
    expect(w.map((x: { label: string }) => x.label)).toEqual(['5-hour', 'weekly', 'Fable weekly']);
    expect(w[0].pctText).toBe('100%');
    expect(w[0].tone).toBe('bad');
    expect(w[0].reset).toMatch(/^resets .*\(in 3m\)$/);
    expect(w[1].reset).toMatch(/^resets \w{3} /);
    expect(w[1].reset).not.toContain('(in');
    expect(p.accounts[0].windowsText[0]).toMatch(/^5-hour: 100% used, resets /);
    const weeklyOnly = buildAccountsPage(ok({ accounts: [row({ lastQuota: { measuredAt: iso(-1), sevenDay: { utilizationPct: 70, resetsAt: iso(2000) } } })] }), NOW);
    expect(weeklyOnly.accounts[0].windows.map((x: { label: string }) => x.label)).toEqual(['weekly']);
  });
  it('a window whose reset passed after the reading no longer counts as full', () => {
    const q = { fiveHour: { utilizationPct: 100, resetsAt: iso(-2) }, sevenDay: { utilizationPct: 49, resetsAt: iso(2000) } };
    expect(usageWindows(q, NOW)[0].rolledOver).toBe(true);
    expect(tightest(q, NOW)!.label).toBe('weekly');
    const p = buildAccountsPage(ok({ accounts: [row({ lastQuota: { measuredAt: iso(-10), ...q } })] }), NOW);
    expect(p.accounts[0].tight.pct).toBe(49);
    expect(p.accounts[0].windows[0].reset).toBe('reset since the last reading');
  });
  it('time until a reset, within a day only', () => {
    expect(untilWords(iso(25), NOW)).toBe('in 25m');
    expect(untilWords(iso(190), NOW)).toBe('in 3h 10m');
    expect(untilWords(iso(180), NOW)).toBe('in 3h');
    expect(untilWords(iso(2000), NOW)).toBeNull();
    expect(untilWords(iso(-1), NOW)).toBeNull();
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
  it('sets up an account on a machine that lacks it: the sheet offers Set up, which asks the PIN and starts that cell', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/capacity/accounts' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const table: Record<string, unknown> = {
      '/sessions': { sessions: [] }, '/health': { project: { name: 'echo' } },
      '/subscription-pool?scope=pool': { enabled: true, accounts: [
        row({}),
        row({ machineId: 'm2', machineNickname: 'Mac Mini' }),
        row({ id: 'gear', nickname: 'Gear', email: 'gear@x.io', machineId: 'm2', machineNickname: 'Mac Mini' }),
      ], pool: { failed: [] } },
      '/subscription-relogin?scope=pool&retryTimeout=1': { enabled: true, episodes: [{ id: 'owner', accountId: 'luna', machineId: 'm2', state: 'waiting-operator-only' }] },
      '/subscription-pool/in-use': { enabled: true, activeAccountId: 'luna' },
      '/pool': { machines: [] },
    };
    g.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
      if (opts && opts.method === 'POST') {
        posts.push({ url, body: JSON.parse(opts.body || '{}') });
        if (url === '/subscription-pool/matrix/start-cell') return { ok: true, status: 200, json: async () => ({ verificationUrl: 'https://claude.ai/oauth/x', loginId: 'L1', expectedEmail: 'gear@x.io' }) };
      }
      const b = table[url];
      return b === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(b)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 15)); };
    await tick(15);
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('Account usage'); // a missing cell is not "needs you"
    expect(doc.querySelector('#sec-needs')?.textContent).toContain('Waiting for the agent to set up this account');
    expect(doc.querySelector('.acct-list .mchip')).toBeNull();
    const gearRow = [...doc.querySelectorAll('button.acct-row')].find((b) => b.textContent!.includes('Gear')) as HTMLButtonElement;
    gearRow.click();
    await tick(3);
    const setUp = [...doc.querySelectorAll('button.btn-quiet')].find((b) => b.textContent === 'Set up') as HTMLButtonElement;
    expect(setUp).toBeTruthy();
    setUp.click();
    await tick(3);
    (doc.querySelector('.pin-input') as HTMLInputElement).value = '123456';
    (doc.querySelector('.pin-form') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await tick(5);
    expect(posts[0]).toEqual({ url: '/subscription-pool/matrix/start-cell', body: { accountId: 'gear', machineId: 'm1', pin: '123456' } });
  });
  it('signs in a cell: asks the PIN, sends it once, shows the sign-in page link, sends the code', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/capacity/accounts' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const table: Record<string, unknown> = {
      '/sessions': { sessions: [] }, '/health': { project: { name: 'echo' } },
      '/subscription-pool?scope=pool': { enabled: true, accounts: [row({ status: 'needs-reauth', machineId: 'm2', machineNickname: 'Mac Mini' })], pool: { failed: [] } },
      '/subscription-relogin?scope=pool&retryTimeout=1': { enabled: true, episodes: [{ id: 'owner', accountId: 'luna', machineId: 'm2', state: 'waiting-operator-only' }] },
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
    expect(doc.querySelector('.page-title')!.textContent).toBe('Account usage');
    expect(doc.querySelector('#sec-notices')).toBeNull();
    expect(doc.querySelector('#sec-needs')?.textContent).toContain('This repair needs you to complete sign-in.');

    (doc.querySelector('#sec-needs button.btn-quiet') as HTMLButtonElement).click();
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
    // The form is gone: one clear result and one button.
    expect(doc.querySelector('.signin-steps')).toBeNull();
    expect(doc.querySelector('.signin-progress.done .signin-progress-title')!.textContent).toBe('Signed in on Mac Mini.');
    expect(doc.querySelector('.signin-progress input')).toBeNull();
    expect([...doc.querySelectorAll('.sheet button:not(.sheet-close)')].map((b) => b.textContent)).toEqual(['Done']);
  });

  // Operator report 2026-11-10 (topic 33890): after Send the dialog kept the live form and a
  // faint "code sent; finishing sign-in" line, and looked stalled.
  const openSignIn = async (submitAnswer: Record<string, unknown>, completions: Array<Record<string, unknown>>) => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const gets: string[] = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/capacity/accounts' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const table: Record<string, unknown> = {
      '/sessions': { sessions: [] }, '/health': { project: { name: 'echo' } },
      '/subscription-pool?scope=pool': { enabled: true, accounts: [row({ status: 'needs-reauth', machineId: 'm2', machineNickname: 'Mac Studio' })], pool: { failed: [] } },
      '/subscription-relogin?scope=pool&retryTimeout=1': { enabled: true, episodes: [{ id: 'owner', accountId: 'luna', machineId: 'm2', state: 'waiting-operator-only' }] }, '/subscription-pool/in-use': { enabled: true }, '/pool': { machines: [] },
    };
    g.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
      if (opts && opts.method === 'POST') {
        posts.push({ url, body: JSON.parse(opts.body || '{}') });
        if (url === '/subscription-pool/matrix/start-cell') return { ok: true, status: 200, json: async () => ({ verificationUrl: 'https://claude.ai/oauth/x', loginId: 'L1', expectedEmail: 'luna@x.io' }) };
        if (url === '/subscription-pool/follow-me/submit-code') return { ok: true, status: 200, json: async () => submitAnswer };
      }
      if (url.startsWith('/subscription-pool/follow-me/completion?')) {
        gets.push(url);
        const c = completions.length > 1 ? completions.shift() : completions[0];
        return { ok: true, status: 200, json: async () => ({ enabled: true, completion: c }) };
      }
      const b = table[url];
      return b === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(b)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 15)); };
    await tick(15);
    const doc = dom.window.document;
    (doc.querySelector('#sec-needs button.btn-quiet') as HTMLButtonElement).click();
    await tick(3);
    (doc.querySelector('.pin-input') as HTMLInputElement).value = '123456';
    (doc.querySelector('.pin-form') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await tick(5);
    (doc.querySelector('.signin-steps .reason-input') as HTMLInputElement).value = 'abc-123';
    ([...doc.querySelectorAll('.signin-steps button')].find((b) => b.textContent === 'Send the code') as HTMLButtonElement).click();
    await tick(3);
    return { doc, posts, gets, tick };
  };

  it('a sent code replaces the form with a prominent in-progress view, then says who signed in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
    try {
      const { doc, gets } = await openSignIn({ outcome: 'submitted', message: 'code sent; finishing sign-in', completion: { state: 'finishing' } },
        [{ state: 'finishing' }, { state: 'done', email: 'gearfinity3d@gmail.com' }]);
      expect(doc.querySelector('.signin-steps')).toBeNull();
      expect(doc.querySelector('.signin-progress[aria-busy="true"] .signin-spinner')).not.toBeNull();
      expect(doc.querySelector('.signin-progress-title')!.textContent).toBe('Finishing the sign-in on Mac Studio…');
      expect(doc.querySelectorAll('.sheet input')).toHaveLength(0);
      expect(doc.querySelectorAll('.sheet button:not(.sheet-close)')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(4_500);
      expect(gets[0]).toBe('/subscription-pool/follow-me/completion?machineId=m2&id=L1');
      expect(doc.querySelector('.signin-progress.done .signin-progress-title')!.textContent).toBe('Signed in as gearfinity3d@gmail.com on Mac Studio.');
      expect([...doc.querySelectorAll('.sheet button:not(.sheet-close)')].map((b) => b.textContent)).toEqual(['Done']);
    } finally { vi.useRealTimers(); }
  });

  it('a sign-in that fails after the code shows the reason and one retry action', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
    try {
      const { doc } = await openSignIn({ outcome: 'submitted', completion: { state: 'finishing' } },
        [{ state: 'failed', reason: 'window-closed', message: 'x' }]);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(doc.querySelector('.signin-progress.failed .signin-progress-title')!.textContent).toBe('The sign-in did not finish.');
      expect(doc.querySelector('.signin-progress.failed .row-sub')!.textContent).toBe('The sign-in window closed before the sign-in finished.');
      expect([...doc.querySelectorAll('.sheet button:not(.sheet-close)')].map((b) => b.textContent)).toEqual(['Start the sign-in again']);
    } finally { vi.useRealTimers(); }
  });

  it('a code the machine refused brings the form back with what went wrong', async () => {
    const { doc } = await openSignIn({ error: 'that does not look like a sign-in code — paste only the code the page gave you' }, []);
    expect(doc.querySelector('.signin-steps .reason-input')).not.toBeNull();
    expect(doc.querySelector('.signin-steps .action-status')!.textContent).toMatch(/does not look like a sign-in code/);
  });

  const render = async (accounts: unknown[]) => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/capacity/accounts' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    const table: Record<string, unknown> = {
      '/sessions': { sessions: [] }, '/health': { project: { name: 'echo' } },
      '/subscription-pool?scope=pool': { enabled: true, accounts, pool: { failed: [] } },
      '/subscription-relogin?scope=pool&retryTimeout=1': { enabled: true, episodes: [{ id: 'owner', accountId: 'luna', machineId: 'm2', state: 'waiting-operator-only' }] }, '/subscription-pool/in-use': { enabled: true }, '/pool': { machines: [] },
    };
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string) => (table[url] === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(table[url])) });
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 15));
    return dom.window.document;
  };
  const full = (id: string, pct: number) => row({ id, nickname: id, email: `${id}@x.io`, lastQuota: { measuredAt: iso(-5), sevenDay: { utilizationPct: pct, resetsAt: new Date(Date.now() + 600 * 60_000).toISOString() } } }); // the page reads the real clock

  it('a routine pool shows no notice spot and no warning title', async () => {
    const doc = await render([full('Adriana', 100), full('Echo', 100), full('Dawn', 89)]);
    expect(doc.querySelector('.page-title')!.textContent).toBe('Account usage');
    expect(doc.querySelector('#sec-notices')).toBeNull();
    expect(doc.querySelector('.hero-ask')).toBeNull();
    expect(doc.querySelectorAll('.acct-row')).toHaveLength(3);
  });

  it('a pool with no room shows one notice, when room returns, and a way to ask', async () => {
    const doc = await render([full('Adriana', 100), full('Echo', 100)]);
    expect(doc.querySelector('#sec-notices .need-title')!.textContent).toBe('All 2 Claude accounts are used up.');
    expect(doc.querySelector('#sec-notices .row-sub')!.textContent).toMatch(/^Room returns: /);
    expect(doc.querySelector('#sec-notices .hero-ask a')).not.toBeNull();
  });
});

describe('needs-you card styling', () => {
  it('shows the whole reason: a row in a need card never cuts its explanation off', () => {
    const css = readFileSync(new URL('../../dashboard/console/console.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.need-card \.row-sub \{ white-space: normal; \}/);
  });
});
