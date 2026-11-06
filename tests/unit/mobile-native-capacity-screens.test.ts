/**
 * Pure summarizers behind the phone's native Accounts, What thinking costs and Resource usage reads
 * (docs/specs/mobile-native-capacity-screens.md): both sides of every display rule, the field
 * allowlist, and the owner-or-bearer check.
 */
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import {
  summarizeAccounts, accountCellState, usageWindows, accountEmail, kindWord,
  summarizeSpend, summarizeRecorded, summarizeLimits, summarizeConversations, windowOf, basisWord, modelWord, doorWord, routeStatusWord,
  summarizeResources, ownerOrBearer, singleFlight, rowKey,
  READING_STALE_MS, SAMPLE_STALE_MS, MAX_ACCOUNTS, type SpendMachine,
} from '../../src/server/mobileCapacityRoutes.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';

const NOW = Date.parse('2026-11-04T02:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const row = (over: Record<string, unknown>) => ({ id: 'acct-a', nickname: 'Work Max', email: 'work@example.com', framework: 'claude-code', status: 'active', loginCheck: 'ok', machineId: 'm_self', machineNickname: 'Studio', remote: false, configHome: '/Users/x/.claude-a', ...over });
const pool = (accounts: unknown[], failed: unknown[] = []) => ({ enabled: true, accounts, pool: { selfMachineId: 'm_self', failed } });

describe('accounts', () => {
  it('cell state: each status rule on both sides', () => {
    expect(accountCellState({ status: 'needs-reauth' })).toEqual({ state: 'attn', label: 'needs sign-in' });
    for (const s of ['signed-out', 'expired', 'broken']) expect(accountCellState({ status: s }).state).toBe('attn');
    expect(accountCellState({ status: 'active', loginCheck: 'signed-out' })).toEqual({ state: 'attn', label: 'login check failed' });
    expect(accountCellState({ status: 'active', loginCheck: 'ok' })).toEqual({ state: 'ok', label: 'signed in' });
    expect(accountCellState({ status: 'active', loginCheck: 'unavailable' })).toEqual({ state: 'ok', label: 'signed in (not re-checked)' });
    expect(accountCellState({ status: 'rate-limited' })).toEqual({ state: 'unknown', label: 'rate limited' });
    expect(accountCellState({ status: 'Weird Status!' })).toEqual({ state: 'unknown', label: 'unknown' });
    expect(accountCellState({ status: 'needs-reauth' }, true)).toEqual({ state: 'working', label: 'signing in now' });
  });

  it('usage windows: Claude and Codex readings, highest first; non-numbers dropped', () => {
    expect(usageWindows({ fiveHour: { utilizationPct: 20, resetsAt: at(60) }, sevenDay: { utilizationPct: 80.4, resetsAt: at(600) } }))
      .toEqual([{ label: 'weekly', pct: 80, resetsAt: at(600) }, { label: '5-hour', pct: 20, resetsAt: at(60) }]);
    expect(usageWindows({ primary: { usedPercent: 50, resetsAtIso: at(30) }, secondary: { usedPercent: 'x' } })).toEqual([{ label: '5-hour', pct: 50, resetsAt: at(30) }]);
    expect(usageWindows(null)).toEqual([]);
    expect(usageWindows({ fiveHour: { utilizationPct: Number.NaN } })).toEqual([]);
  });

  it('email: the account login email only when it is a real address, not an id', () => {
    expect(accountEmail('a', 'me@example.com')).toBe('me@example.com');
    expect(accountEmail('a', 'a')).toBeNull();
    expect(accountEmail('a', 'not an email')).toBeNull();
    expect(accountEmail('a', `${'x'.repeat(120)}@example.com`)).toBeNull();
    expect(kindWord('codex-cli')).toBe('Codex');
    expect(kindWord('who-knows')).toBe('Other');
  });

  it('a wrong login is attention; an unconfirmed or blocked sign-in is shown but not counted', () => {
    const stuck = accountCellState({ status: 'active', identityDrifted: true, identityDrift: { actualAccountId: 'e', actualEmail: 'echo@x.io', repairState: 'planned', detectedAt: at(-60 * 24 * 10) } }, false, null, NOW);
    expect(stuck).toEqual({ state: 'attn', label: "holds another account's login" });
    expect(accountCellState({ status: 'active', identityDrifted: true, identityDrift: { actualAccountId: 'e', repairState: 'planned', detectedAt: at(-30) } }, false, null, NOW).state).toBe('unknown');
    expect(accountCellState({ status: 'active', identityDrifted: true, identityDrift: { actualAccountId: 'missing-local-login' } }, false, null, NOW)).toEqual({ state: 'attn', label: 'needs sign-in' });
    expect(accountCellState({ status: 'needs-reauth' }, false, 'no-open-incident').state).toBe('unknown');
    expect(accountCellState({ status: 'needs-reauth' }, false, 'profile-unresolved').label).toBe("automatic repair can't start yet");
    expect(accountCellState({ status: 'needs-reauth' }, false, 'device-limit-benched').state).toBe('attn');
    const r = summarizeAccounts(pool([row({ status: 'needs-reauth' })]), { now: NOW, blockers: [{ accountId: String(row({}).id), machineId: String(row({}).machineId), reason: 'no-open-incident' }] });
    expect(r.needsSignIn).toBe(0);
    expect(r.headline).not.toContain('signing in');
  });

  it('one account across machines: freshest reading wins, a future-dated reading never does', () => {
    const r = summarizeAccounts(pool([
      row({ lastQuota: { fiveHour: { utilizationPct: 40, resetsAt: at(100) }, measuredAt: at(-30) } }),
      row({ machineId: 'm_peer', machineNickname: 'Mac Mini', remote: true, lastQuota: { fiveHour: { utilizationPct: 70, resetsAt: at(100) }, measuredAt: at(-5) } }),
      row({ machineId: 'm_far', machineNickname: 'Laptop', remote: true, lastQuota: { fiveHour: { utilizationPct: 1, resetsAt: at(100) }, measuredAt: at(60) } }),
    ]), { now: NOW });
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0].usageLine).toBe('70% of 5-hour');
    expect(r.accounts[0].readingAt).toBe(at(-5));
    expect(r.accounts[0].machines.map((m) => m.name)).toEqual(['Studio', 'Mac Mini', 'Laptop']);
    expect(r.accounts[0].stale).toBe(false);
  });

  it('stale on both sides of 60 minutes; tone at 74/75/89/90', () => {
    const one = (pct: number, minutesAgo: number) => summarizeAccounts(pool([row({ lastQuota: { fiveHour: { utilizationPct: pct, resetsAt: at(10) }, measuredAt: at(-minutesAgo) } })]), { now: NOW }).accounts[0];
    expect(one(10, 59).stale).toBe(false);
    expect(one(10, 61).stale).toBe(true);
    expect(READING_STALE_MS).toBe(3_600_000);
    expect(one(74, 1).tone).toBeNull();
    expect(one(75, 1).tone).toBe('attn');
    expect(one(89, 1).tone).toBe('attn');
    expect(one(90, 1).tone).toBe('bad');
  });

  it('no reading and Grok wording; a reset time in the past is dropped', () => {
    const r = summarizeAccounts(pool([row({ id: 'g', nickname: 'Grok', framework: 'grok-build' }), row({ id: 'n', nickname: 'New' }), row({ id: 'p', nickname: 'Past', lastQuota: { fiveHour: { utilizationPct: 5, resetsAt: at(-10) }, measuredAt: at(-1) } })]), { now: NOW });
    const by = Object.fromEntries(r.accounts.map((a) => [a.name, a]));
    expect(by.Grok.usageLine).toBe("Usage isn't readable for this kind of account.");
    expect(by.New.usageLine).toBe('No reading yet.');
    expect(by.Past.windows[0].resetsAt).toBeNull();
  });

  it('sign-in rollup, ordering and in-use only with a local row', () => {
    const r = summarizeAccounts(pool([
      row({ id: 'ok', nickname: 'Fine' }),
      row({ id: 'unchecked', nickname: 'Unchecked', loginCheck: 'unavailable' }),
      row({ id: 'bad', nickname: 'Broken', machineId: 'm_peer', machineNickname: 'Mac Mini', remote: true, status: 'needs-reauth' }),
      row({ id: 'peer-only', nickname: 'Peer only', machineId: 'm_peer', machineNickname: 'Mac Mini', remote: true }),
    ]), { now: NOW, inUseAccountId: 'peer-only' });
    expect(r.accounts[0]).toMatchObject({ name: 'Broken', signIn: 'needs-sign-in' });
    const by = Object.fromEntries(r.accounts.map((a) => [a.name, a]));
    expect(by.Fine.signIn).toBe('signed-in');
    expect(by.Unchecked.signIn).toBe('signed-in-unchecked');
    // An unknown status with a passed check is never signed in.
    expect(summarizeAccounts(pool([row({ status: 'mystery', loginCheck: 'ok' })]), { now: NOW }).accounts[0].signIn).toBe('unknown');
    expect(by['Peer only'].inUse).toBe(false);
    expect(summarizeAccounts(pool([row({})]), { now: NOW, inUseAccountId: 'acct-a' }).accounts[0].inUse).toBe(true);
    expect(r.needsSignIn).toBe(1);
    expect(r.headline).toBe('1 account needs signing in.');
  });

  it('a local repair shows "signing in now" on this machine only', () => {
    const r = summarizeAccounts(pool([
      row({ status: 'needs-reauth' }),
      row({ machineId: 'm_peer', machineNickname: 'Mac Mini', remote: true, status: 'needs-reauth' }),
    ]), { now: NOW, localRepairs: [{ accountId: 'acct-a', state: 'running' }, { accountId: 'other', state: 'running' }] });
    expect(r.accounts[0].machines).toEqual([
      { name: 'Studio', isSelf: true, state: 'working', label: 'signing in now' },
      { name: 'Mac Mini', isSelf: false, state: 'attn', label: 'needs sign-in' },
    ]);
    const done = summarizeAccounts(pool([row({ status: 'needs-reauth' })]), { now: NOW, localRepairs: [{ accountId: 'acct-a', state: 'failed' }] });
    expect(done.accounts[0].machines[0].state).toBe('attn');
    const only = summarizeAccounts(pool([row({ status: 'needs-reauth' })]), { now: NOW, localRepairs: [{ accountId: 'acct-a', state: 'awaiting-code' }] });
    expect(only.accounts[0].signIn).toBe('signing-in');
  });

  it('headline (older app builds): never names one account as nearly out; counts are right', () => {
    const q = (id: string, pct: number) => row({ id: `id-${id}`, nickname: id, lastQuota: { fiveHour: { utilizationPct: pct, resetsAt: at(10) }, measuredAt: at(-1) } });
    expect(summarizeAccounts(pool([q('A', 40), q('B', 10)]), { now: NOW }).headline).toBe('2 of 2 accounts have room.');
    // The reported case: two accounts full, others with room. Not "A is nearly out".
    const two = summarizeAccounts(pool([q('Adriana', 100), q('Echo', 100), q('Dawn', 89), q('Luna', 73)]), { now: NOW });
    expect(two.headline).toBe('2 of 4 accounts have room.');
    expect(two.notices).toEqual([]);
    expect(summarizeAccounts(pool([q('A', 95), q('B', 91)]), { now: NOW }).headline).toBe('All 2 Claude accounts are nearly out.');
    expect(summarizeAccounts(pool([]), { now: NOW }).headline).toBe('No accounts are set up yet.');
    expect(summarizeAccounts(pool([row({})]), { now: NOW }).headline).toBe('No usage readings yet.');
  });

  describe('notices: only what needs the person or changes what they can do', () => {
    const q = (id: string, pct: number, over: Record<string, unknown> = {}, resetMin = 10) => row({ id: `id-${id}`, nickname: id, lastQuota: { fiveHour: { utilizationPct: pct, resetsAt: at(resetMin) }, measuredAt: at(-1) }, ...over });
    const cx = (id: string, pct: number, resetMin = 30) => row({ id: `cx-${id}`, nickname: id, framework: 'codex-cli', lastQuota: { primary: { usedPercent: pct, resetsAtIso: at(resetMin) }, measuredAt: at(-1) } });
    const notices = (rows: unknown[], failed: unknown[] = []) => summarizeAccounts(pool(rows, failed), { now: NOW }).notices;

    it('a routine state is no notice: one or two full while others have room, or all fine', () => {
      expect(notices([q('A', 100), q('B', 100), q('C', 89)])).toEqual([]);
      expect(notices([q('A', 40), q('B', 10)])).toEqual([]);
      expect(notices([q('A', 89), q('B', 89)])).toEqual([]);
    });

    it('the whole pool at or over 90%: one notice, used up vs nearly out, with when room returns', () => {
      const n = notices([q('A', 95, {}, 300), q('B', 90, {}, 60)]);
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ tone: 'attn', title: 'All 2 Claude accounts are nearly out.', returnsAt: at(60), action: { kind: 'ask' } });
      const up = notices([q('A', 100), q('B', 100, {}, 5)]);
      expect(up[0]).toMatchObject({ tone: 'bad', title: 'All 2 Claude accounts are used up.', returnsAt: at(5) });
      expect(notices([q('A', 100)])[0].title).toBe('The only Claude account is used up.');
    });

    it('room returns only when every full window on an account resets', () => {
      const both = row({ id: 'id-A', nickname: 'A', lastQuota: { fiveHour: { utilizationPct: 100, resetsAt: at(10) }, sevenDay: { utilizationPct: 95, resetsAt: at(900) }, measuredAt: at(-1) } });
      expect(notices([both])[0].returnsAt).toBe(at(900));
      const noTime = row({ id: 'id-A', nickname: 'A', lastQuota: { fiveHour: { utilizationPct: 100 }, measuredAt: at(-1) } });
      expect(notices([noTime])[0].returnsAt).toBeNull();
    });

    it('one framework out while another has room: a notice for that framework only', () => {
      const n = notices([q('A', 40), cx('X', 100), cx('Y', 97)]);
      expect(n.map((x) => x.title)).toEqual(['All 2 Codex accounts are nearly out.']);
      const both = notices([q('A', 99), cx('X', 100)]);
      expect(both.map((x) => x.title)).toEqual(['All 2 accounts are nearly out.']);
    });

    it('an account with no reading, or one needing sign-in, is not counted as out of room', () => {
      expect(notices([q('A', 100), row({ id: 'id-B', nickname: 'B' })])).toEqual([]);
      const n = notices([q('A', 100), q('B', 10, { status: 'needs-reauth' })]);
      expect(n).toHaveLength(2);
      expect(n.find((x) => x.key === 'sign-in')).toMatchObject({ tone: 'attn', title: '1 account needs signing in.', action: { kind: 'sign-in', accounts: [rowKey('account', 'id-B')] } });
      expect(n.find((x) => x.key !== 'sign-in')!.title).toBe('The only Claude account is used up.');
    });

    it('a machine with no signed-in account, and a sign-in that fixes it; not while unknown or signing in', () => {
      const peer = (id: string, over: Record<string, unknown>) => q(id, 10, { machineId: 'm_peer', machineNickname: 'Mac Mini', remote: true, ...over });
      const n = notices([q('A', 10), peer('A', { status: 'needs-reauth' })]);
      expect(n[0]).toMatchObject({ tone: 'bad', title: 'Mac Mini has no signed-in account, so nothing can run there.', action: { kind: 'sign-in', accounts: [rowKey('account', 'id-A')] } });
      expect(n).toHaveLength(1); // the account is not asked for twice
      const more = notices([q('A', 10), peer('A', { status: 'needs-reauth' }), q('B', 10, { status: 'needs-reauth' })]);
      expect(more.map((x) => x.title)).toEqual(['Mac Mini has no signed-in account, so nothing can run there.', '1 more account needs signing in.']);
      expect(notices([q('A', 10), peer('A', { status: 'warming' })])).toEqual([]);
      expect(notices([q('A', 10), peer('A', {}), peer('B', { id: 'id-B', status: 'needs-reauth' })]).map((x) => x.key)).toEqual(['sign-in']);
    });

    it("this machine's list unreadable; a partial read scopes its conclusions", () => {
      const n = notices([], [{ machineId: 'm_self', error: 'peer-pool-unavailable' }]);
      expect(n).toEqual([expect.objectContaining({ key: 'list-unreadable', tone: 'bad', action: expect.objectContaining({ kind: 'ask' }) })]);
      expect(notices([q('A', 100)], [{ machineId: 'm_peer', error: 'timeout' }])[0].title).toBe('The only Claude account is used up (on the machines that answered).');
    });

    it('every notice carries an action', () => {
      const all = notices([q('A', 100), q('B', 100, { status: 'needs-reauth', machineId: 'm_peer', machineNickname: 'Mac Mini', remote: true })]);
      expect(all.length).toBeGreaterThan(0);
      for (const x of all) expect(['sign-in', 'ask']).toContain(x.action.kind);
    });
  });

  it('unread names peers by registry name only; this machine\'s own failed row is localUnreadable', () => {
    const r = summarizeAccounts(pool([], [{ machineId: 'm_self', error: 'peer-pool-unavailable' }, { machineId: 'm_peer', machineNickname: 'Evil Name', error: 'HTTP 500 /Users/x' }, { machineId: 'm_x', error: 'timeout' }]), { now: NOW, nicknameOf: (id) => (id === 'm_peer' ? 'Mac Mini' : null) });
    expect(r.unread).toEqual({ count: 2, names: ['Mac Mini'] });
    expect(r.localUnreadable).toBe(true);
    expect(r.headline).toBe("This machine's account list can't be read right now.");
    const unconfigured = summarizeAccounts(pool([], [{ machineId: 'm_self', error: 'peer-pool-unconfigured' }]), { now: NOW });
    expect(unconfigured.localUnreadable).toBe(false);
    expect(unconfigured.unread.count).toBe(0);
  });

  it('a pool that is not set up, and the allowlist of fields', () => {
    expect(summarizeAccounts({ enabled: false, accounts: [] }, { now: NOW })).toMatchObject({ enabled: false, accounts: [], headline: 'The account pool is not set up on this agent.' });
    const r = summarizeAccounts(pool([row({ identityDrift: { x: 'drift' }, statusCause: 'cause-x', lastRefreshAt: at(-1) })]), { now: NOW });
    expect(Object.keys(r.accounts[0]).sort()).toEqual(['email', 'inUse', 'key', 'kind', 'machines', 'name', 'readingAt', 'signIn', 'stale', 'tone', 'usageLine', 'windows']);
    const text = JSON.stringify(r);
    for (const leak of ['/Users/x', 'acct-a', 'm_self', 'drift', 'cause-x']) expect(text).not.toContain(leak);
    expect(r.accounts[0].key).toBe(rowKey('account', 'acct-a'));
  });

  it('an id-like nickname is not a name; the email stands in', () => {
    const r = summarizeAccounts(pool([row({ nickname: 'acct-a' })]), { now: NOW });
    expect(r.accounts[0].name).toBe('work@example.com');
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_ACCOUNTS + 3 }, (_, i) => row({ id: `a${i}`, nickname: `Acct ${i}` }));
    const r = summarizeAccounts(pool(many), { now: NOW });
    expect(r.accounts).toHaveLength(MAX_ACCOUNTS);
    expect(r.truncated).toBe(true);
  });
});

describe('spend', () => {
  const ledger = (rows: unknown[], totals: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ok: true as const, data: { rows, totals, ...extra } });
  const tok = (claude: number, codex?: number) => ({ ok: true as const, data: { summary: { sessionsActive: 2, totalTokens: claude }, ...(codex !== undefined ? { codex: { sessionCount: 1, totalTokens: codex } } : {}) } });
  const self = (summary: SpendMachine['summary'], tokens: SpendMachine['tokens'] = tok(1000)): SpendMachine => ({ name: 'Studio', isSelf: true, summary, tokens });

  it('words: basis, model, route, status, window', () => {
    expect(basisWord('internal-derived')).toBe('estimated');
    expect(basisWord('internal-derived-provider-tokens')).toBe('estimated');
    expect(basisWord('provider-reported')).toBe('provider-reported');
    expect(basisWord('subscription-zero')).toBe('subscription');
    expect(basisWord('unpriced')).toBe('unpriced');
    expect(basisWord(undefined)).toBe('basis not stated');
    expect(modelWord('claude-opus-4-8-20260115')).toBe('Claude Opus 4.8');
    expect(modelWord('gpt-6-luna')).toBe('GPT-6 Luna');
    expect(doorWord('openrouter')).toBe('OpenRouter');
    expect(doorWord('some_new-door')).toBe('Some New Door');
    expect(routeStatusWord({ frozen: true, goLiveState: 'live' })).toBe('Frozen');
    expect(routeStatusWord({ goLiveState: 'live' })).toBe('Open');
    expect(routeStatusWord({ goLiveState: 'disarmed' })).toBe('Closed');
    expect(routeStatusWord({})).toBe('Not open');
    expect(windowOf('today')).toBe('today');
    expect(windowOf('month')).toBe('month');
    expect(windowOf('year')).toBe('week');
    expect(windowOf(undefined)).toBe('week');
    expect(windowOf('constructor')).toBe('week');
  });

  it('rows keep their basis: unpriced has no dollars, provider-reported uses the provider figure', () => {
    const r = summarizeRecorded([self(ledger([
      { door: 'groq', modelId: 'llama-4', costBasis: 'unpriced', netUsd: 0, tokensIn: 10, tokensOut: 5, unpricedTokensIn: 10, unpricedTokensOut: 5 },
      { door: 'openrouter', modelId: 'gpt-6-luna', costBasis: 'provider-reported', netUsd: 1, providerReportedUsd: 1.5, tokensIn: 100, tokensOut: 50, priceStale: true },
    ], { netUsd: 1.5, tokensIn: 110, tokensOut: 55, unpricedTokensIn: 10, unpricedTokensOut: 5 }))]);
    expect(r.state).toBe('ok');
    const rows = r.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ basis: 'provider-reported', usd: 1.5, priceStale: true });
    expect(rows[1]).toMatchObject({ basis: 'unpriced', usd: null, unpricedTokens: 15 });
    expect(r.unpricedTokens).toBe(15);
  });

  it('merges rows across machines; flags any machine raised stay on; amortized is this machine\'s only', () => {
    const a = ledger([{ door: 'openrouter', modelId: 'm', costBasis: 'internal-derived', netUsd: 1, tokensIn: 10, tokensOut: 0 }], { netUsd: 1, tokensIn: 10, tokensOut: 0, amortizedSubscriptionUsd: 30 });
    const b = ledger([{ door: 'openrouter', modelId: 'm', costBasis: 'internal-derived', netUsd: 2, tokensIn: 20, tokensOut: 0, notLiveYet: true, priceStale: true }], { netUsd: 2, tokensIn: 20, tokensOut: 0, amortizedSubscriptionUsd: 30 });
    const r = summarizeRecorded([self(a), { name: 'Mac Mini', machineId: 'm_peer', isSelf: false, summary: b, tokens: tok(5) }]);
    expect(r.netUsd).toBe(3);
    expect(r.amortizedUsd).toBe(30);
    expect(r.rows).toEqual([expect.objectContaining({ usd: 3, tokens: 30, priceStale: true, notLiveYet: true })]);
    expect(r.machines).toEqual([
      { name: 'Studio', isSelf: true, state: 'ok', netUsd: 1, unpricedTokens: 0 },
      { name: 'Mac Mini', isSelf: false, state: 'ok', netUsd: 2, unpricedTokens: 0 },
    ]);
  });

  it('state precedence: any read is ok; all off is off; otherwise unavailable; machine states named', () => {
    const off = { ok: false as const, off: true };
    const bad = { ok: false as const, off: false };
    expect(summarizeRecorded([self(off)]).state).toBe('off');
    expect(summarizeRecorded([self(bad)]).state).toBe('unavailable');
    expect(summarizeRecorded([self(off), { name: 'X', isSelf: false, summary: bad, tokens: bad }]).state).toBe('unavailable');
    // An offline machine was not asked: a fleet whose asked machines are all off still reads off.
    expect(summarizeRecorded([self(off), { name: 'X', isSelf: false, summary: { ok: false, off: false, offline: true }, tokens: bad }]).state).toBe('off');
    expect(summarizeRecorded([self({ ok: true, data: { rows: 'nope' } })]).state).toBe('unavailable');
    const mixed = summarizeRecorded([self(ledger([], { netUsd: 0 })), { name: 'A', machineId: 'm_a', isSelf: false, summary: { ok: false, off: false, unreached: true }, tokens: bad }, { name: 'B', machineId: 'm_b', isSelf: false, summary: { ok: false, off: false, offline: true }, tokens: bad }, { name: 'm_c', machineId: 'm_c', isSelf: false, summary: off, tokens: off }]);
    expect(mixed.state).toBe('ok');
    expect((mixed.machines as Array<{ name: string; state: string }>).map((m) => [m.name, m.state])).toEqual([['Studio', 'ok'], ['A', 'unreached'], ['B', 'offline'], ['A machine with no name yet', 'off']]);
  });

  it('headline: one machine, all machines, partial; never $0 for unpriced use', () => {
    const okL = (net: number, unpriced = 0) => ledger([], { netUsd: net, unpricedTokensIn: unpriced });
    expect(summarizeSpend('week', { machines: [self(okL(4.2))], caps: { ok: false, off: true }, status: { ok: false, off: true } }).headline).toBe('About $4.20 of pay-per-use cost this week on this machine.');
    expect(summarizeSpend('today', { machines: [self(okL(0))], caps: { ok: false, off: true }, status: { ok: false, off: true } }).headline).toBe('No pay-per-use cost today on this machine.');
    expect(summarizeSpend('today', { machines: [self(okL(0, 12000))], caps: { ok: false, off: true }, status: { ok: false, off: true } }).headline).toBe('No priced pay-per-use cost today on this machine; 12k tokens had no price on file.');
    const peer = (summary: SpendMachine['summary']): SpendMachine => ({ name: 'Mac Mini', machineId: 'm_peer', isSelf: false, summary, tokens: tok(1) });
    expect(summarizeSpend('month', { machines: [self(okL(1)), peer(okL(2))], caps: { ok: false, off: true }, status: { ok: false, off: true } }).headline).toBe('About $3.00 of pay-per-use cost in the last 30 days across 2 machines.');
    expect(summarizeSpend('month', { machines: [self(okL(1)), peer({ ok: false, off: true })], caps: { ok: false, off: true }, status: { ok: false, off: true } }).headline).toBe('About $1.00 of pay-per-use cost in the last 30 days on the machine that answered.');
    expect(summarizeSpend('week', { machines: [self({ ok: false, off: true })], caps: { ok: false, off: true }, status: { ok: false, off: true } }).headline).toBe("Spend figures aren't available on this agent.");
    expect(summarizeSpend('week', { machines: [self({ ok: false, off: false })], caps: { ok: false, off: true }, status: { ok: false, off: true } }).headline).toBe("Can't tell what AI use cost.");
  });

  it('limits: no credential reference or lease id, holder by verified name, store error as a boolean', () => {
    const l = summarizeLimits({ ok: true, data: { keys: [
      { keyRef: 'or-key-REF', provider: 'openrouter', door: 'openrouter', dailyCapUsd: 25, lifetimeCapUsd: 60, committedDayUsd: 3, committedLifetimeUsd: 40, goLiveState: 'live', meteredLeaseHolder: 'm_holder' },
      { keyRef: 'groq-REF', provider: 'groq', door: 'groq', frozen: true, meteredLeaseHolder: 'm_unnamed' },
    ], storeError: 'caps store unreadable: /Users/x/caps.json' } }, { ok: true, data: { lifecycleState: 'enabled', enforcementReady: true, anyKeyFrozen: true, machineId: 'm_self', machineNickname: 'Studio' } }, (id) => (id === 'm_holder' ? 'Studio' : null));
    expect(l.routes).toEqual([
      // Designated to another machine: its committed figures are not this machine's to show.
      { key: rowKey('route', 'or-key-REF'), name: 'OpenRouter · OpenRouter', status: 'Open', committedDayUsd: null, dailyCapUsd: 25, committedLifetimeUsd: null, lifetimeCapUsd: 60, heldBy: 'Studio', committedElsewhere: true },
      expect.objectContaining({ name: 'Groq · Groq', status: 'Frozen', heldBy: 'another machine' }),
    ]);
    const here = summarizeLimits({ ok: true, data: { keys: [{ keyRef: 'k', provider: 'openrouter', door: 'openrouter', committedDayUsd: 3, committedLifetimeUsd: 40, meteredLeaseHolder: 'm_self' }, { keyRef: 'k2', provider: 'groq', door: 'groq', committedDayUsd: 1 }] } }, { ok: false, off: true }, () => null, ['single-machine', 'm_self']);
    expect(here.routes).toEqual([
      expect.objectContaining({ committedDayUsd: 3, committedLifetimeUsd: 40, heldBy: 'this machine', committedElsewhere: false }),
      expect.objectContaining({ committedDayUsd: 1, heldBy: null, committedElsewhere: false }),
    ]);
    // The money layer's own id for a machine without a mesh ('single-machine') is this machine too.
    const solo = summarizeLimits({ ok: true, data: { keys: [{ keyRef: 'k', provider: 'openrouter', door: 'openrouter', committedDayUsd: 2, meteredLeaseHolder: 'single-machine' }] } }, { ok: false, off: true }, () => null, ['single-machine']);
    expect(solo.routes).toEqual([expect.objectContaining({ committedDayUsd: 2, heldBy: 'this machine', committedElsewhere: false })]);
    expect(l).toMatchObject({ storeUnreadable: true, routesState: 'ok', controlsState: 'ok', routesSentence: '1 paid route is open; 1 frozen.', sentence: 'Limits are on and enforcing; a paid route is frozen on this machine.' });
    const text = JSON.stringify(l);
    for (const leak of ['REF', 'm_holder', 'm_unnamed', 'm_self', '/Users/x', 'keyRef', 'meteredLeaseHolder']) expect(text).not.toContain(leak);
  });

  it('limits: every lifecycle sentence, and the two sources stay independent', () => {
    const st = (s: Record<string, unknown>) => summarizeLimits({ ok: false, off: true }, { ok: true, data: s });
    expect(st({ lifecycleState: 'enable-pending-restart' }).sentence).toBe('Limits are turned on but wait for a restart to start enforcing on this machine.');
    expect(st({ lifecycleState: 'probe-failed', failingComponent: 'MeteredSpendLedger' })).toMatchObject({ sentence: 'Limits are turned on but not enforcing (probe failed: MeteredSpendLedger) on this machine.', notEnforcingWhileOn: true, routesState: 'off', controlsState: 'ok' });
    expect(st({ lifecycleState: 'construction-failed', failingComponent: '/Users/x/evil path!' }).sentence).toBe('Limits are turned on but not enforcing (construction failed) on this machine.');
    expect(st({ lifecycleState: 'disabled' }).sentence).toBe('Spending limits are off on this machine.');
    expect(st({}).sentence).toBe('Spending limits are off on this machine.');
    expect(st({ lifecycleState: 'arming' }).sentence).toBe('Limits: arming on this machine.');
    expect(st({ lifecycleState: 'BAD STATE' }).sentence).toBe('Limits: state unknown on this machine.');
    const down = summarizeLimits({ ok: true, data: { keys: [] } }, { ok: false, off: false });
    expect(down).toMatchObject({ routesState: 'ok', routesSentence: 'No paid route is set up.', controlsState: 'unavailable', sentence: "Can't tell whether spending limits are on." });
    expect(summarizeLimits({ ok: false, off: false }, { ok: false, off: true })).toMatchObject({ routesState: 'unavailable', controlsState: 'off' });
  });

  it('conversations: Claude and Codex added across machines, never together', () => {
    const c = summarizeConversations([self(ledger([], {}), tok(1000, 500)), { name: 'Mini', isSelf: false, summary: { ok: false, off: true }, tokens: tok(2000) }], 'this week');
    expect(c.claude).toMatchObject({ count: 4, tokens: 3000 });
    expect(c.codex).toMatchObject({ count: 1, tokens: 500 });
    expect((c.claude as { line: string }).line).toBe('Claude: 4 conversations processed 3,000 tokens this week.');
    expect(summarizeConversations([self(ledger([], {}), { ok: false, off: true })], 'today').state).toBe('off');
    expect(summarizeConversations([self(ledger([], {}), { ok: false, off: false })], 'today').state).toBe('unavailable');
  });
});

describe('resources', () => {
  const src = (source: string, cpu: number, ageMs = 30_000) => ({ source, currentCpuPercent: cpu, currentRssBytes: 1e9, avgCpuPercent: cpu / 2, peakCpuPercent: cpu * 2, peakRssBytes: 2e9, newestTs: NOW - ageMs, pid: 4242 });

  it('running sessions first by CPU, ended sessions named and without a current reading, no ids or pids', () => {
    const r = summarizeResources([src('aggregate', 12), src('agent-server', 2), src('session:s1', 3), src('session:s2', 9), src('session:gone', 50)], new Map([['s1', 'build-one'], ['s2', 'build-two']]), 'Studio', NOW);
    expect(r.sessions.map((s) => s.name)).toEqual(['build-two', 'build-one', 'A session that has ended']);
    expect(r.sessions[2]).toMatchObject({ ended: true, cpuPercent: null, memoryBytes: null, peakCpuPercent: 100 });
    expect(r.headline).toBe('Instar is using 12% CPU and 1.0 GB of memory now (peak 24% in the last hour).');
    const text = JSON.stringify(r);
    for (const leak of ['s1', 'gone', '4242', 'session:']) expect(text).not.toContain(leak);
  });

  it('stale on both sides of 5 minutes, and the stale headline', () => {
    const fresh = summarizeResources([src('aggregate', 12, SAMPLE_STALE_MS - 1000)], new Map(), 'Studio', NOW);
    expect(fresh.total!.stale).toBe(false);
    const old = summarizeResources([src('aggregate', 12, 20 * 60_000)], new Map(), 'Studio', NOW);
    expect(old.total!.stale).toBe(true);
    expect(old.headline).toBe('Last recorded 20 min ago: Instar was using 12% CPU and 1.0 GB of memory (peak 24% in the last hour). No newer reading.');
    expect(summarizeResources([], new Map(), 'Studio', NOW).headline).toBe('No total reading yet.');
  });
});

describe('access and helpers', () => {
  const req = (principal: unknown, person?: unknown) => ({ instarPrincipal: principal, instarDevicePerson: person, headers: {} }) as unknown as Request;
  it('ownerOrBearer: bearer checked explicitly, owner phone passes, everything else fails closed', () => {
    expect(ownerOrBearer(req({ kind: 'token' }), () => true)).toBe(true);
    expect(ownerOrBearer(req({ kind: 'token' }), () => false)).toBe(false);
    expect(ownerOrBearer(req(undefined), () => false)).toBe(false);
    expect(ownerOrBearer(req({ kind: 'device' }, { ok: true, role: 'owner' }), () => false)).toBe(true);
    expect(ownerOrBearer(req({ kind: 'device' }, { ok: true, role: 'msp' }), () => false)).toBe(false);
    expect(ownerOrBearer(req({ kind: 'device' }), () => false)).toBe(false);
    expect(ownerOrBearer(req({ kind: 'device-notify' }, { ok: true, role: 'owner' }), () => true)).toBe(false);
  });

  it('singleFlight shares a read inside its window and never caches a failure', async () => {
    let t = 0; let calls = 0;
    const sf = singleFlight<number>(15_000, () => t);
    const f = async () => ++calls;
    expect(await sf('k', f)).toBe(1);
    expect(await sf('k', f)).toBe(1);
    t = 15_001;
    expect(await sf('k', f)).toBe(2);
    expect(await sf('other', f)).toBe(3);
    await expect(sf('bad', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await new Promise((r) => setTimeout(r, 0));
    expect(await sf('bad', f)).toBe(4);
  });

  it('the allowlist has exactly owner-only GET entries for the three paths and none of the raw routes', () => {
    for (const p of ['/mobile/accounts', '/mobile/spend', '/mobile/resources']) {
      const rules = DEVICE_ALLOWLIST.filter((x) => x.re.test(p));
      expect(rules, p).toHaveLength(1);
      expect(rules[0]).toMatchObject({ method: 'GET', ownerOnly: true, body: 'none', bucket: 'capacity-reads' });
    }
    for (const p of ['/subscription-pool', '/routing-spend/summary', '/routing-spend/caps', '/tokens/summary', '/resources/summary']) expect(DEVICE_ALLOWLIST.some((x) => x.re.test(p)), p).toBe(false);
  });
});
