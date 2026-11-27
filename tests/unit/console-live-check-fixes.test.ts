/**
 * Five defects a live check of Echo's console found on 2026-11-14, one test block each:
 *  1. Home "What needs you" listed the same thing several times ("Standards delta:
 *     Operator-Surface Quality" four times), listed the headline item again as its first
 *     row, and showed an unexplained "partial" tag.
 *  2. "Remote Desktop needs its Mac permission again" opened a PIN page that said nothing
 *     about the permission.
 *  3. (CSS and tile names; checked in the source below.)
 *  4. Promise rows showed raw ids ("fb-2ea93840-f48", "thread 63567ed2", "CMT-056",
 *     "topic 1000000000143").
 *  5. The Accounts header said "14/14 accounts usable" while three sign-ins needed him.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildNeeds, buildPromised, combineNeeds, collapseRepeats, needsCardList, partialWords, headline, needAction, repeatKey,
} from '../../dashboard/console/home-model.js';
import { desktopPermissionFixes } from '../../dashboard/console/machines-model.js';
import { plainReferenceText } from '../../dashboard/console/display-identity.js';
import { toRow } from '../../dashboard/console/promises-model.js';
import { buildAccountsPage, accountCounts } from '../../dashboard/console/accounts-model.js';

const NOW = Date.parse('2026-11-14T22:00:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const surfacedRow = (key: string, main: string, sub = '', href = '#/work/plans?s=needsYou') => ({ key: `need:${key}`, main, sub, tone: 'attn', refs: [], action: { kind: 'href', href } });
const emptyQueue = () => buildNeeds(ok({ items: [], pool: { failed: [] } }), NOW);
const noPromises = { state: 'ok', count: 0, all: [] };

describe('1. what needs you: one row per real thing', () => {
  it('the live case: four plans with the same title are one row that says how many', () => {
    const rows = [
      surfacedRow('account:a', 'Sign in Claude (echo@x.io) on Mac Mini', 'Ready to retry.', '#/capacity/accounts?s=needs'),
      ...['df5', '208', 'e2e', '16b'].map((k) => surfacedRow(`plan:${k}`, 'Standards delta: Operator-Surface Quality', 'Waiting on you')),
      ...['426', '419', 'e86'].map((k) => surfacedRow(`plan:${k}`, 'Standards delta: Dashboard UX Standard', 'Waiting on you')),
      surfacedRow('plan:other', 'Standards delta: Migration Parity', 'Waiting on you'),
    ];
    const card = combineNeeds(emptyQueue(), noPromises, { rows, pending: [], failed: [] });
    expect(card.all.map((r: { main: string }) => r.main)).toEqual([
      'Sign in Claude (echo@x.io) on Mac Mini',
      'Standards delta: Operator-Surface Quality',
      'Standards delta: Dashboard UX Standard',
      'Standards delta: Migration Parity',
    ]);
    expect(card.count).toBe(4);
    expect(card.all[1].sub).toBe('4 of these · Waiting on you');
    expect(card.all[2].sub).toBe('3 of these · Waiting on you');
    expect(card.all[3].sub).toBe('Waiting on you');
    // The headline counts the same collapsed list.
    expect(headline({ needs: card }).sub).toContain('3 more things need you');
  });

  it('repeats differ only in spacing, case or a trailing full stop', () => {
    expect(repeatKey({ main: '2 fixes need your look before publishing.' })).toBe(repeatKey({ main: '2  Fixes need your look before publishing' }));
    const { rows, counted } = collapseRepeats([{ key: 'a', main: '2 fixes need your look.', sub: 'file a' }, { key: 'b', main: '2 fixes need your look', sub: 'file b' }]);
    expect(rows).toHaveLength(1);
    expect(counted).toBe(1);
    // The words already carry the number, so it is not said twice.
    expect(rows[0].sub).toBe('file a');
  });

  it('distinct things are never merged, and a stale queue item alone does not count', () => {
    const counted = new Set<{ key: string; main: string }>();
    const fresh = { key: 'f', main: 'Approve the deploy' };
    const stale = { key: 's', main: 'An old notice' };
    counted.add(fresh);
    const out = collapseRepeats([fresh, stale], counted);
    expect(out.rows).toHaveLength(2);
    expect(out.counted).toBe(1);
  });

  it('the general "sign-in repair is waiting" notice is dropped when the named sign-in rows are listed', () => {
    const queue = buildNeeds(ok({ items: [{ id: 'q1', title: 'Claude Code sign-in repair is waiting for you', category: 'subscription-relogin', status: 'OPEN', priority: 'HIGH', needsUser: true, createdAt: minsAgo(5), machineNickname: 'Mac Mini' }], pool: { failed: [] } }), NOW);
    expect(queue.count).toBe(1);
    const withAccounts = combineNeeds(queue, noPromises, { rows: [surfacedRow('account:a::m1', 'Sign in Claude (echo@x.io) on Mac Mini', '', '#/capacity/accounts?s=needs')], pending: [], failed: [] });
    expect(withAccounts.all.map((r: { main: string }) => r.main)).toEqual(['Sign in Claude (echo@x.io) on Mac Mini']);
    expect(withAccounts.count).toBe(1);
    // With no named sign-in rows the notice is the only word on it, so it stays.
    const alone = combineNeeds(queue, noPromises, { rows: [], pending: [], failed: [] });
    expect(alone.count).toBe(1);
  });

  it('the headline item is not listed again under it when the headline links to it', () => {
    const rows = [surfacedRow('a', 'Sign in Claude (echo@x.io) on Mac Mini'), surfacedRow('b', 'Engine Optimization'), surfacedRow('c', 'Testing Integrity')];
    const card = combineNeeds(emptyQueue(), noPromises, { rows, pending: [], failed: [] });
    expect(headline({ needs: card }).text).toBe('Sign in Claude (echo@x.io) on Mac Mini');
    const linked = needsCardList(card, true);
    expect(linked.all.map((r: { main: string }) => r.main)).toEqual(['Engine Optimization', 'Testing Integrity']);
    expect(linked.rows.some((r: { main: string }) => r.main.startsWith('Sign in'))).toBe(false);
    // Without a link the card keeps it, so its detail can still be opened.
    expect(needsCardList(card, false).all).toHaveLength(3);
  });

  it('"partial" is said in plain words: which part did not answer', () => {
    expect(partialWords({ unanswered: 1 })).toBe('A machine did not answer');
    expect(partialWords({ unanswered: 2 })).toBe('2 machines did not answer');
    expect(partialWords({ surfacedFailed: true })).toBe('Some pages did not answer');
    expect(partialWords({ promisesUnread: true })).toBe('Promises not checked');
    const needs = buildNeeds(ok({ items: [{ id: 'q', title: 'Approve the deploy', status: 'OPEN', priority: 'URGENT', createdAt: minsAgo(5) }], pool: { failed: [{ machineId: 'm2', error: 'timeout' }] } }), NOW);
    const card = combineNeeds(needs, noPromises, { rows: [], pending: [], failed: [] });
    expect(card.coverage).toBe('partial view');
    expect(card.coverageWords).toBe('A machine did not answer');
    const whole = combineNeeds(emptyQueue(), noPromises, { rows: [surfacedRow('x', 'Something')], pending: [], failed: [] });
    expect(whole.coverageWords).toBeNull();
  });

  it('the card corner prefers the plain words over the old "partial" tag', () => {
    const src = readFileSync('dashboard/console/console.js', 'utf8');
    expect(src).toContain('model.coverageWords ||');
    expect(src).not.toMatch(/partial: 'partial'/);
  });
});

describe('2. remote desktop permission: the link lands on the problem and its fix', () => {
  const item = { id: 'desktop-helper-permission:m_mini:bb', sourceContext: 'desktop-helper-permission', category: 'desktop', status: 'OPEN', machineId: 'm_4cbc0d4a0c557cf7e221882f9b42518f', machineNickname: 'Mac Mini',
    title: 'Mac Mini: Remote Desktop needs its Mac permission again',
    description: 'This Mac reports a locked screen. Remote desktop cannot open a locked Mac yet. Someone at this Mac needs to allow it again: System Settings → Privacy & Security → Screen Recording and Accessibility. Turn instar-desktop-host off and on. If it is not listed or that does not work, remove it with the minus button and add /Users/someone/.instar/desktop-helper/instar-desktop-host with the plus button. Then tap Retry.' };

  it('Home sends the permission notice to that machine on the Machines page, not the PIN page', () => {
    expect(needAction(item)).toEqual({ kind: 'href', href: '#/capacity/machines?m=m_4cbc0d4a0c557cf7e221882f9b42518f&fix=desktop-permission' });
    // Other desktop notices keep the remote desktop page.
    expect(needAction({ category: 'desktop', machineId: 'm1', sourceContext: 'desktop-other' })).toEqual({ kind: 'href', href: '/dashboard/desktop.html?machineId=m1' });
  });

  it('the Machines page names the machine, the permission and the one thing to do', () => {
    const fixes = desktopPermissionFixes(ok({ items: [item, { ...item, id: 'dup' }] }), { m_4cbc0d4a0c557cf7e221882f9b42518f: 'Mac Mini' })!;
    expect(fixes).toHaveLength(1);
    const f = fixes[0];
    expect(f.title).toBe('Remote Desktop on Mac Mini needs its Mac permission again');
    expect(f.action).toContain('Someone at Mac Mini');
    expect(f.action).toContain('Screen Recording');
    expect(f.action).toContain('Accessibility');
    expect(f.action).toContain('instar-desktop-host off and on');
    expect(f.ifMissing).toContain('/Users/someone/.instar/desktop-helper/instar-desktop-host');
    expect(f.locked).toContain('unlock it at the Mac first');
    expect(f.retryHref).toBe('/dashboard/desktop.html?machineId=m_4cbc0d4a0c557cf7e221882f9b42518f');
  });

  it('a failed read is unknown, never "no problem"; a closed notice shows nothing', () => {
    expect(desktopPermissionFixes({ ok: false, reason: 'timeout' })).toBeNull();
    expect(desktopPermissionFixes(ok({}))).toBeNull();
    expect(desktopPermissionFixes(ok({ items: [{ ...item, status: 'DONE' }] }))).toEqual([]);
  });

  it('the Machines page renders the fix cards above the machine list', () => {
    const src = readFileSync('dashboard/console/machines.js', 'utf8');
    expect(src).toContain("get('/attention?scope=pool&status=OPEN'");
    expect(src.indexOf('...fixCards')).toBeGreaterThan(-1);
    expect(src.indexOf('...fixCards')).toBeLessThan(src.indexOf('    cards,\n'));
  });
});

describe('3. work page tiles', () => {
  it('rows of tiles side by side share one height', () => {
    expect(readFileSync('dashboard/console/console.css', 'utf8')).toMatch(/\.tiles \{ grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr; \}/);
  });
  it('the efforts tile is not a second "Conversations"', () => {
    const src = readFileSync('dashboard/console/conversations.js', 'utf8');
    expect(src).toContain("text: 'Groups'");
    expect(src).not.toMatch(/t-name', text: 'Conversations'/);
  });
});

describe('4. promise rows in plain words', () => {
  it('turns the ids from the live check into words', () => {
    const topicNames = { '1000000000143': 'Instar app' };
    expect(plainReferenceText('Repeating failure = one incident. Feedback fb-2ea93840-f48, fb-704cf418-5fb, fb-1a2b3c4d-0e1.', { topicNames }))
      .toBe('Repeating failure = one incident. 3 feedback reports.');
    expect(plainReferenceText('Filed as fb-4a183f12-ee0; retire the map')).toBe('Filed as a feedback report; retire the map');
    expect(plainReferenceText('Report back on thread 63567ed2 when done')).toBe('Report back on an agent thread when done');
    expect(plainReferenceText('Replaces CMT-056 and lands the fix (CMT-1548)')).toBe('Replaces another promise and lands the fix');
    expect(plainReferenceText('Post the result in topic 1000000000143', { topicNames })).toBe('Post the result in the “Instar app” conversation');
    expect(plainReferenceText('Post the result in topic 9984')).toBe('Post the result in a conversation');
    expect(plainReferenceText('send from machine m_4cbc0d4a0c557cf7e221882f9b42518f', { machineNames: { m_4cbc0d4a0c557cf7e221882f9b42518f: 'Mac Mini' } })).toBe('send from Mac Mini');
  });

  it('keeps pull request numbers and ordinary words as they are', () => {
    expect(plainReferenceText('Approve PR 2380 and 2.0 PR 182 by 5 PM')).toBe('Approve PR 2380 and 2.0 PR 182 by 5 PM');
    expect(plainReferenceText('Fix the effect of the cafe deface')).toBe('Fix the effect of the cafe deface');
  });

  it('the Promises page row and the Home row use the plain words; the details keep the full text', () => {
    const c = { id: 'CMT-1', status: 'pending', createdAt: minsAgo(30), hardDeadlineAt: minsAgo(-30), blockedOn: 'user-authorization',
      userRequest: 'Approve the flood breaker (fb-2ea93840-f48) in topic 1000000000143', agentResponse: 'Merge it after approval' };
    const row = toRow(c, NOW, {}, { '1000000000143': 'Instar app' });
    expect(row.main).toBe('Approve the flood breaker (a feedback report) in the “Instar app” conversation');
    expect(row.record.userRequest).toContain('fb-2ea93840-f48');
    const home = buildPromised(ok({ enabled: true, scope: 'local', commitments: [c] }), NOW, 0, { topicNames: { '1000000000143': 'Instar app' } });
    expect(home.all[0].main).toBe(row.main);
  });
});

describe('5. the Accounts header agrees with the rows', () => {
  const iso = (m: number) => new Date(NOW + m * 60_000).toISOString();
  const acct = (id: string, over: Record<string, unknown> = {}) => ({ id, nickname: id, email: `${id}@x.io`, framework: 'claude-code', status: 'active', loginCheck: 'ok', machineId: 'm1', machineNickname: 'Mac Studio',
    lastQuota: { measuredAt: iso(-5), sevenDay: { utilizationPct: 20, resetsAt: iso(3000) } }, ...over });

  it('keeps quota for all accounts when three need repair on one machine', () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 14; i++) {
      rows.push(acct(`a${i}`));
      rows.push(acct(`a${i}`, { machineId: 'm2', machineNickname: 'Mac Mini', ...(i < 3 ? { status: 'needs-reauth', lastQuota: null } : {}) }));
    }
    const page = buildAccountsPage(ok({ accounts: rows }), NOW);
    expect(page.headline).toBe('Account usage');
    expect(page.facts).toContainEqual({ n: '14', label: 'accounts with usage data' });
    expect(page.usageAccounts).toHaveLength(14);
    for (const account of page.usageAccounts) {
      expect(account.windows).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'weekly', pct: 20 })]));
    }
    expect(page.needs).toEqual([]);
    expect(page.repairs).toEqual([expect.objectContaining({ machine: 'Mac Mini', total: 14, signedIn: 11 })]);
    expect(page.repairs[0].rows).toHaveLength(3);
    expect(page.repairs[0].rows.every((row: { ownerAction: unknown }) => row.ownerAction === null)).toBe(true);
  });

  it('counts add up: ready + need a sign-in + not ready yet = all accounts', () => {
    const accounts = [
      { cells: [{ state: 'ok' }, { state: 'ok' }] },
      { cells: [{ state: 'ok' }, { state: 'attn' }] },
      { cells: [{ state: 'ok' }, { state: 'working' }] },
      { cells: [{ state: 'waiting' }] },
    ];
    expect(accountCounts(accounts)).toEqual({ total: 4, ready: 1, needSignIn: 1, inProgress: 2 });
  });

  it('shows usage and no repair rows when every account is signed in', () => {
    const page = buildAccountsPage(ok({ accounts: [acct('a'), acct('b')] }), NOW);
    expect(page.facts).toContainEqual({ n: '2', label: 'accounts with usage data' });
    expect(page.repairs).toEqual([]);
    expect(page.signedInMachines).toEqual(['Mac Studio']);
  });
});

describe('1b. collapsing keeps the way to act', () => {
  it('a merged row takes the link of the first member that has one, in the first one\'s place', () => {
    const { rows } = collapseRepeats([
      { key: 'q', main: 'Approve the deploy', sub: 'queue', tone: 'attn', action: { kind: 'attention' } },
      { key: 'x', main: 'Something else', tone: 'attn' },
      { key: 's', main: 'Approve the deploy', sub: 'page', tone: 'bad', action: { kind: 'href', href: '#/work/plans' } },
    ]);
    expect(rows.map((r: { main: string }) => r.main)).toEqual(['Approve the deploy', 'Something else']);
    expect(rows[0].action).toEqual({ kind: 'href', href: '#/work/plans' });
    expect(rows[0].tone).toBe('bad');
    expect(rows[0].keys).toEqual(['q', 's']);
  });
});

describe('notices read with names, not ids (dashboard makeover, 2026-11-20 audit)', () => {
  it('an unnamed topic with a short number never prints the number, and ordinary "topic 2" prose is left alone', () => {
    expect(plainReferenceText('Reply to topic 0 (name unresolved) is held. My reply to topic 0 (name unresolved) could not be sent.'))
      .toBe('Reply to a conversation is held. My reply to a conversation could not be sent.');
    expect(plainReferenceText('See topic 2 of the guide')).toBe('See topic 2 of the guide');
  });

  it('a held-reply notice names the conversation and machine, and drops the doubled "name unresolved"', () => {
    const text = 'Reply to topic 144319 (name unresolved) is held. My reply to topic 144319 (name unresolved) could not be forwarded to m_a804869356b259820b3236e7c5a2ae7d.';
    const unnamed = plainReferenceText(text, {});
    expect(unnamed).not.toMatch(/144319|m_a804|name unresolved/);
    expect(unnamed).toContain('Reply to a conversation is held');
    const named = plainReferenceText(text, { topicNames: { 144319: 'Apple app rebuild' }, machineNames: { m_a804869356b259820b3236e7c5a2ae7d: 'M5 Pro' } });
    expect(named).toContain('the “Apple app rebuild” conversation');
    expect(named).toContain('forwarded to M5 Pro');
  });
});
