/**
 * Console Permission-slips page (docs/specs/console-features/people-settings.md,
 * "Permission slips", legacy tab `mandates`): every decision in the model on both
 * sides (active / expired / revoked grouping, an invalid signature, a broken chain,
 * plain-words bounds, audit rows and their count label, the exact issue / revoke /
 * grant bodies), and the shipped console in jsdom driving one revoke through the
 * shared PIN sheet: the PIN is sent once, in that request's body, and the field is gone.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  mandateState, slipSummary, slipCard, buildSlips, grantRows, buildAudit, auditRow, buildApprovals,
  mandatesHeadline, mandatesFacts, issueRequest, revokeRequest, grantRequest, denyRequest, approveRequest,
  resultWords, parseAuthorities, followMeTarget, whenWords, humanAction, nameMap, agentName, FLOOR_ACTIONS, GRANT_DURATIONS,
} from '../../dashboard/console/mandates-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-25T18:00:00Z');
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const off = () => ({ ok: false, status: 503, reason: 'switched off on this agent' });
const fail = (reason = 'the server answered 500') => ({ ok: false, status: 500, reason });
const hours = (h: number) => new Date(NOW + h * 3600_000).toISOString();
const FP_ECHO = 'a'.repeat(32);
const FP_DAWN = 'b'.repeat(32);
const names = nameMap({ selfFp: FP_ECHO, selfName: 'Echo', peers: [{ fp: FP_DAWN, name: 'Dawn' }] });
const users = [{ slackUserId: 'U1', name: 'Mia', orgRole: 'engineer' }];

const mandate = (over: Record<string, unknown> = {}) => ({
  id: 'm1', scope: 'feedback-migration', agents: [FP_ECHO, FP_DAWN],
  authorities: [{ action: 'sign-code-review', bounds: { artifact: 'migration-port' } }, { action: 'exchange-read-credential', bounds: {} }],
  author: 'justin', createdAt: hours(-24), expiresAt: hours(72), revoked: null, grants: [], authProof: 'x', authorshipValid: true, ...over,
});
const entry = (over: Record<string, unknown> = {}) => ({ ts: hours(-1), mandateId: 'm1', agentFp: FP_DAWN, action: 'sign-code-review', decision: 'allow', reason: 'within bounds', conditionResult: null, prevHash: '', hash: 'h1', ...over });

describe('slip grouping and words', () => {
  it('active / expired / revoked each land in their group; revoked wins over expiry', () => {
    expect(mandateState(mandate(), NOW)).toBe('active');
    expect(mandateState(mandate({ expiresAt: hours(-1) }), NOW)).toBe('expired');
    expect(mandateState(mandate({ expiresAt: hours(-1), revoked: { at: hours(-2), reason: 'done' } }), NOW)).toBe('revoked');
    expect(mandateState(mandate({ expiresAt: 'garbage' }), NOW)).toBe('expired');
    const s = buildSlips(ok({ mandates: [mandate(), mandate({ id: 'm2', expiresAt: hours(-5) }), mandate({ id: 'm3', revoked: { at: hours(-3), reason: 'wrong peer' } })] }), { names, users, now: NOW });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.active.map((c) => c.id)).toEqual(['m1']);
    expect(s.ended.map((c) => c.id)).toEqual(['m3', 'm2']); // most recently ended first
    expect(s.counts).toEqual({ active: 1, ended: 2, people: 0, invalid: 0 });
    expect(s.ended[0].stateWords).toBe('Revoked 3 h ago — wrong peer');
    expect(s.ended[1].stateWords).toBe('Expired 5 h ago');
  });
  it('the bounds read as one plain sentence: names, actions and the end', () => {
    const text = slipSummary(mandate(), names, NOW);
    expect(text).toMatch(/^Echo and Dawn may sign a code review and hand over a read-only credential until /);
    expect(text).not.toMatch(/aaaa|bbbb|sign-code-review/);
    // Unknown agents have a plain label; their fingerprints stay out of the sentence.
    expect(slipSummary(mandate(), {}, NOW)).toMatch(/^an unnamed agent and an unnamed agent may /);
    // The carrier a user-authority approval issues (same agent twice, no authorities, one grant).
    const carrier = mandate({ agents: [FP_ECHO, FP_ECHO], authorities: [], grants: [{ floorAction: 'prod-deploy', grantedTo: 'U1', authorizedBy: 'Justin', expiresAt: hours(1) }] });
    expect(slipSummary(carrier, names, NOW)).toMatch(/^A carrier for one person’s grant, until /);
    expect(slipSummary(mandate({ authorities: [] }), names, NOW)).toMatch(/^Echo and Dawn may do nothing under this slip yet/);
    expect(slipSummary(mandate({ revoked: { at: hours(-1), reason: 'x' } }), names, NOW)).toMatch(/could sign a code review and hand over a read-only credential until it was revoked\.$/);
    expect(humanAction('prod-deploy')).toBe('deploy to production');
    expect(humanAction('some-new-thing')).toBe('some new thing');
    expect(agentName('', names)).toBe('an agent');
  });
  it('whenWords: today / tomorrow / a weekday within the week / a date beyond it', () => {
    // Local noon today, and calendar-day steps: a fixed 24h step is still
    // "today" on a 25-hour DST-end day, and now+60s can cross midnight.
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    const now = noon.getTime();
    const daysOut = (n: number) => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
    expect(whenWords(new Date(now + 60_000).toISOString(), now)).toMatch(/^today /);
    expect(whenWords(daysOut(1).toISOString(), now)).toMatch(/^tomorrow /);
    const inThree = daysOut(3);
    expect(whenWords(inThree.toISOString(), now)).toMatch(new RegExp(`^${inThree.toLocaleDateString([], { weekday: 'long' })} `));
    expect(whenWords(daysOut(20).toISOString(), now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, /);
    expect(whenWords('nope', now)).toBe('an unknown time');
  });
  it('grants read as sentences, live or over; a person with a live grant counts once', () => {
    const m = mandate({ grants: [
      { floorAction: 'prod-deploy', grantedTo: 'U1', authorizedBy: 'operator (dashboard PIN)', expiresAt: hours(1) },
      { floorAction: 'money-movement', grantedTo: 'U1', authorizedBy: 'operator (dashboard PIN)', expiresAt: hours(-1) },
      { floorAction: 'external-send', grantedTo: 'U9', authorizedBy: 'x', expiresAt: hours(2) },
    ] });
    const g = grantRows(m, users, NOW);
    expect(g.map((r) => r.live)).toEqual([true, false, true]);
    expect(g[0].text).toMatch(/^Mia may deploy to production until /);
    expect(g[1].text).toMatch(/^Mia could move money until .* \(over\)\.$/);
    expect(g[2].text).toMatch(/^an unnamed person may send something outside until /);
    const card = slipCard(m, { names, users, now: NOW });
    expect(card.peopleLine).toBe('Also lets Mia and an unnamed person act.');
    expect(buildSlips(ok({ mandates: [m] }), { names, users, now: NOW })).toMatchObject({ counts: { people: 2 } });
    // A grant on an ended slip is over even if its own clock has not passed.
    expect(grantRows(mandate({ ...m, revoked: { at: hours(-1), reason: 'r' } }), users, NOW)[0].live).toBe(false);
  });
  it('authorshipValid:false is a red card with the signature line; true is quiet', () => {
    const bad = slipCard(mandate({ authorshipValid: false }), { names, users, now: NOW });
    expect(bad).toMatchObject({ invalid: true, tone: 'bad' });
    expect(bad.invalidLine).toContain('signature doesn’t check out');
    const good = slipCard(mandate(), { names, users, now: NOW });
    expect(good).toMatchObject({ invalid: false, tone: null, invalidLine: '' });
    const s = buildSlips(ok({ mandates: [mandate({ authorshipValid: false })] }), { names, users, now: NOW });
    expect(s.ok && s.counts.invalid).toBe(1);
    expect(mandatesHeadline({ slips: s, approvals: buildApprovals(off()), audit: buildAudit(ok({ total: 0, chain: { ok: true }, entries: [] }), { now: NOW }) })).toEqual({ text: 'One slip’s signature doesn’t check out.', tone: 'bad' });
  });
  it('a failed or switched-off list is can’t tell, never "No slips"', () => {
    expect(buildSlips(off(), { now: NOW })).toMatchObject({ ok: false, off: true });
    expect(buildSlips(off(), { now: NOW }).reason).toContain('switched off on this agent');
    expect(buildSlips(fail('no answer within 5 seconds'), { now: NOW })).toMatchObject({ ok: false, off: false, reason: 'Can’t read the permission slips: no answer within 5 seconds.' });
    expect(buildSlips(ok({}), { now: NOW }).ok).toBe(false);
    expect(buildSlips(ok({ mandates: [] }), { now: NOW })).toMatchObject({ ok: true, counts: { active: 0, ended: 0 } });
  });
});

describe('decision history', () => {
  it('each decision is one plain row, newest first; grants name the person', () => {
    const a = buildAudit(ok({ total: 3, chain: { ok: true }, entries: [
      entry({ ts: hours(-3), hash: 'h0', decision: 'deny', reason: 'action not in mandate', action: 'execute-cutover' }),
      entry({ ts: hours(-1), hash: 'h1' }),
      entry({ ts: hours(-2), hash: 'h2', action: 'grant-floor:prod-deploy', agentFp: 'U1', reason: 'grant signed by operator (dashboard PIN) until x' }),
    ] }), { names, users, now: NOW });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.rows.map((r) => r.main)).toEqual(['Allowed · Dawn may sign a code review', 'Allowed · Mia was granted “deploy to production”', 'Refused · Dawn tried to run the cutover']);
    expect(a.rows[2]).toMatchObject({ sub: 'action not in mandate', end: '3 h ago', tone: 'attn' });
    expect(a.chain).toEqual({ state: 'intact', words: 'Record intact.' });
    expect(auditRow(entry({ decision: 'deny', action: 'grant-floor:money-movement', agentFp: 'U1' }), { users, now: NOW }).main).toBe('Refused · a grant for Mia to move money was refused');
  });
  it('the count says what it was counted over: "latest N" unless the window is demonstrably covered', () => {
    const tail = buildAudit(ok({ total: 900, chain: { ok: true }, entries: [entry({ ts: hours(-1) }), entry({ ts: hours(-2), hash: 'h2', decision: 'deny' })] }), { now: NOW });
    expect(tail.ok && tail.countLabel).toBe('Among the latest 2 decisions: 1 allowed, 1 refused.');
    // total equals what came back → the whole record is here → a 24 h count is honest.
    const whole = buildAudit(ok({ total: 3, chain: { ok: true }, entries: [entry({ ts: hours(-1) }), entry({ ts: hours(-2), hash: 'h2', decision: 'deny' }), entry({ ts: hours(-30), hash: 'h3' })] }), { now: NOW });
    expect(whole.ok && whole.countLabel).toBe('1 allowed, 1 refused in the last 24 h.');
    // the oldest returned entry is older than 24 h → the day is covered even with a bigger total.
    const old = buildAudit(ok({ total: 500, chain: { ok: true }, entries: [entry({ ts: hours(-1) }), entry({ ts: hours(-26), hash: 'h3' })] }), { now: NOW });
    expect(old.ok && old.countLabel).toBe('1 allowed, 0 refused in the last 24 h.');
    expect(buildAudit(ok({ total: 0, chain: { ok: true }, entries: [] }), { now: NOW })).toMatchObject({ ok: true, countLabel: 'No decisions recorded yet.', rows: [] });
  });
  it('chain.ok:false is broken (an incident, leads the headline); a missing verdict is can’t tell; a failed read is honest', () => {
    const broken = buildAudit(ok({ total: 1, chain: { ok: false, brokenAt: 0 }, entries: [entry()] }), { now: NOW });
    expect(broken.ok && broken.chain.state).toBe('broken');
    expect(broken.ok && broken.chain.words).toBe('The decision record is broken — possible tampering at entry 0. Treat as an incident.');
    const slips = buildSlips(ok({ mandates: [mandate()] }), { names, users, now: NOW });
    expect(mandatesHeadline({ slips, approvals: buildApprovals(off()), audit: broken })).toEqual({ text: 'The decision record is broken — treat this as an incident.', tone: 'bad' });
    expect(mandatesFacts({ slips, approvals: buildApprovals(off()), audit: broken })).toContainEqual({ n: 'broken', label: 'decision record', tone: 'bad' });
    expect(buildAudit(ok({ total: 1, entries: [entry()] }), { now: NOW })).toMatchObject({ ok: true, chain: { state: 'unknown' } });
    expect(buildAudit(off(), { now: NOW })).toMatchObject({ ok: false, off: true, reason: 'The decision history is switched off on this agent.' });
    expect(buildAudit(fail(), { now: NOW })).toMatchObject({ ok: false, off: false });
    expect(buildAudit(ok({ chain: { ok: true } }), { now: NOW }).ok).toBe(false);
  });
});

describe('approvals, headline and facts', () => {
  it('pending requests become cards; held elsewhere is named; 503 hides the block; a failure says can’t tell and keeps the slips', () => {
    const a = buildApprovals(ok({ requests: [
      { id: 'r1', status: 'pending', headline: 'Let Mia deploy to production for 1 hour.', reason: 'hotfix #2412', createdByAgent: 'Echo', createdOnMachine: 'studio', heldOnThisMachine: true },
      { id: 'r2', status: 'pending', headline: 'x', createdByAgent: 'Echo', createdOnMachine: 'mini', heldOnThisMachine: false },
      { id: 'r3', status: 'approved', headline: 'y' },
    ] }));
    expect(a.rows.map((r) => [r.id, r.here, r.machine])).toEqual([['r1', true, 'studio'], ['r2', false, 'mini']]);
    expect(buildApprovals(off())).toMatchObject({ hidden: true, rows: [] });
    const f = buildApprovals(fail('no answer within 5 seconds'));
    expect(f).toMatchObject({ ok: false, hidden: false });
    expect(f.reason).toBe('Can’t tell if anything is waiting for your approval: no answer within 5 seconds.');
    const slips = buildSlips(ok({ mandates: [mandate()] }), { names, users, now: NOW });
    const audit = buildAudit(ok({ total: 0, chain: { ok: true }, entries: [] }), { now: NOW });
    expect(mandatesHeadline({ slips, approvals: a, audit })).toEqual({ text: '2 requests are waiting for your approval.', tone: 'attn' });
    expect(mandatesHeadline({ slips, approvals: { ...a, rows: a.rows.slice(0, 1) }, audit })).toEqual({ text: 'Echo is asking you to approve 1 thing.', tone: 'attn' });
    expect(mandatesHeadline({ slips, approvals: buildApprovals(off()), audit })).toEqual({ text: '1 slip active; nothing waiting.', tone: 'ok' });
    expect(mandatesHeadline({ slips, approvals: f, audit })).toEqual({ text: '1 slip active; can’t tell if anything is waiting.', tone: 'muted' });
    expect(mandatesHeadline({ slips: buildSlips(ok({ mandates: [] }), { now: NOW }), approvals: buildApprovals(off()), audit })).toEqual({ text: 'No slips — every agent-to-agent action is refused until you sign one.', tone: 'ok' });
    expect(mandatesHeadline({ slips: buildSlips(off(), { now: NOW }), approvals: buildApprovals(off()), audit: buildAudit(off(), { now: NOW }) })).toEqual({ text: 'Permission slips are switched off on this agent.', tone: 'muted' });
    expect(mandatesHeadline({ slips: buildSlips(fail(), { now: NOW }), approvals: buildApprovals(off()), audit })).toEqual({ text: 'Can’t tell what you have allowed.', tone: 'muted' });
    expect(mandatesFacts({ slips, approvals: a, audit })).toEqual([
      { n: 2, label: 'waiting on you', tone: 'attn' }, { n: 1, label: 'active slip' }, { n: 0, label: 'people with grants' }, { n: 'intact', label: 'decision record', tone: null },
    ]);
    expect(mandatesFacts({ slips: buildSlips(fail(), { now: NOW }), approvals: buildApprovals(off()), audit: buildAudit(fail(), { now: NOW }) })).toEqual([{ n: '?', label: 'active slips' }, { n: '?', label: 'decision record' }]);
  });
});

describe('request bodies match the routes', () => {
  it('issue: scope, a pair of agents, authorities, a future ISO expiry and the PIN; problems are listed before any PIN is asked', () => {
    const form = { scope: 'feedback-migration', agentA: FP_ECHO, agentB: FP_DAWN, authorities: JSON.stringify([{ action: 'sign-code-review', bounds: {} }]), expiresAt: '2026-11-01T15:00' };
    const r = issueRequest(form, '1234', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe('/mandate/issue');
    expect(r.body).toEqual({ pin: '1234', scope: 'feedback-migration', agents: [FP_ECHO, FP_DAWN], authorities: [{ action: 'sign-code-review', bounds: {} }], expiresAt: new Date('2026-11-01T15:00').toISOString() });
    const bad = issueRequest({ ...form, scope: ' ', agentB: '', authorities: '[', expiresAt: '2020-01-01T00:00' }, '', NOW);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems).toEqual(['Give the slip a short name.', 'Pick or paste the other agent’s fingerprint.', 'Authorities is not valid JSON — it must be an array of { action, bounds }.', 'The expiry is in the past.', 'Your PIN is needed.']);
    expect(parseAuthorities('[]')).toMatchObject({ ok: false });
    expect(parseAuthorities('[{"action":"x"}]')).toMatchObject({ ok: false, problem: 'Each authority needs an action and bounds.' });
    // An account-follow-me authority goes through the one-dashboard issue+deliver route with its bounds, as the legacy form does.
    const fm = issueRequest({ ...form, authorities: JSON.stringify([{ action: 'account-follow-me', bounds: { accountId: 'acc', targetMachineId: 'mini' } }]) }, '1', NOW);
    expect(fm.ok && fm.path).toBe('/mandate/issue-for-machine');
    expect(fm.ok && fm.body).toMatchObject({ pin: '1', accountId: 'acc', targetMachineId: 'mini', agents: [FP_ECHO, FP_DAWN] });
    expect(fm.ok && 'authorities' in fm.body).toBe(false);
    expect(followMeTarget([{ action: 'account-follow-me', bounds: { accountId: 'acc' } }])).toBeNull();
  });
  it('revoke: the PIN, and a reason only when typed (the server defaults it)', () => {
    expect(revokeRequest('1234', '  ')).toEqual({ pin: '1234' });
    expect(revokeRequest('1234', 'wrong peer')).toEqual({ pin: '1234', reason: 'wrong peer' });
  });
  it('grant: one grant with the floor action, the person, the operator as authorizer and an expiry clamped to the slip', () => {
    const r = grantRequest(mandate(), { grantedTo: 'U1', floorAction: 'prod-deploy', minutes: '60' }, '1234', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clamped).toBe(false);
    expect(r.body).toEqual({ pin: '1234', grants: [{ floorAction: 'prod-deploy', grantedTo: 'U1', authorizedBy: 'operator (dashboard PIN)', expiresAt: new Date(NOW + 3600_000).toISOString() }] });
    const c = grantRequest(mandate({ expiresAt: hours(0.5) }), { grantedTo: 'U1', floorAction: 'money-movement', minutes: 1440 }, '1', NOW);
    expect(c.ok && c.clamped).toBe(true);
    expect(c.ok && c.body.grants[0].expiresAt).toBe(hours(0.5));
    const bad = grantRequest(mandate(), { grantedTo: '', floorAction: 'fly', minutes: 'x' }, '', NOW);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems).toEqual(['Pick who the grant is for.', 'Pick what they may do.', 'Pick for how long.', 'Your PIN is needed.']);
    expect(FLOOR_ACTIONS).toEqual(['money-movement', 'prod-deploy', 'credential-access', 'destructive-data', 'external-send', 'grant-authority']);
    expect(GRANT_DURATIONS.map((d) => d.minutes)).toEqual([15, 60, 240, 1440]);
  });
  it('approve carries only the PIN; decline needs a reason (the server’s rule)', () => {
    expect(approveRequest('9')).toEqual({ pin: '9' });
    expect(denyRequest('9', ' ')).toMatchObject({ ok: false });
    expect(denyRequest('9', 'not now')).toEqual({ ok: true, body: { pin: '9', denyReason: 'not now' } });
  });
  it('the server’s answer in words: wrong PIN, too many tries, no PIN configured, engine off, a 400 reason, success per action', () => {
    expect(resultWords('revoke', 403, { error: 'Incorrect PIN', attemptsRemaining: 3 }).text).toBe('That PIN was not accepted · 3 tries left. Nothing has changed.');
    expect(resultWords('revoke', 403, { error: 'Operator PIN required — mandate issuance/revocation is a human action, not an agent action' }).text).toBe('That PIN was not accepted. Nothing has changed.');
    expect(resultWords('grant', 429, { error: 'Too many attempts. Try again later.' }).text).toContain('Too many PIN attempts');
    expect(resultWords('issue', 503, { error: 'PIN authentication not available (no dashboardPin configured)' }).text).toContain('No dashboard PIN is configured');
    expect(resultWords('issue', 503, { error: 'coordination mandate engine unavailable (no stateDir or init failed)' }).text).toBe('This is switched off on this agent: coordination mandate engine unavailable (no stateDir or init failed).');
    expect(resultWords('grant', 400, { error: 'grant expiresAt exceeds mandate expiry' }).text).toBe('Not done: grant expiresAt exceeds mandate expiry. Nothing has changed.');
    expect(resultWords('revoke', 404, {})).toMatchObject({ ok: false });
    expect(resultWords('issue', 502, { issued: true, reason: 'peer offline' })).toMatchObject({ ok: false, issued: true });
    expect(resultWords('issue', 201, { issued: true, delivered: true }).text).toBe('Issued and delivered to the other machine. The slip is active.');
    expect(resultWords('revoke', 200, { revoked: true })).toEqual({ ok: true, text: 'Revoked. Everything this slip allowed is refused from now on.' });
    expect(resultWords('grant', 201, {}).text).toBe('Granted. The slip now carries it.');
    expect(resultWords('approve', 200, { alreadyApproved: true }).text).toBe('This was already approved.');
    expect(resultWords('deny', 200, {}).text).toBe('Declined.');
    expect(resultWords('deny', 0, {}).text).toBe('The server could not be reached. Nothing was sent.');
  });
  it('the tile flips to the native page under its new name; the legacy id stays', () => {
    expect(NATIVE_PAGES.mandates).toBe('#/people/mandates');
    expect(tabHref('mandates')).toBe('#/people/mandates');
    expect(GROUPS.find((g) => g.id === 'people')!.tabs.find((t) => t.id === 'mandates')!.label).toBe('Permission slips');
  });
});

describe('permission slips in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('boots the shipped console and drives a revoke through the PIN sheet: the PIN is sent once, in that body, and the field is gone', async () => {
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/people/mandates' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    // The page reads the real clock, so this fixture's times are relative to it, not to NOW.
    const rel = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    const live = mandate({ expiresAt: rel(72), grants: [{ floorAction: 'prod-deploy', grantedTo: 'U1', authorizedBy: 'operator (dashboard PIN)', expiresAt: rel(1) }] });
    const table: Record<string, { status?: number; body: unknown }> = {
      '/sessions': { body: { sessions: [] } },
      '/health': { body: { project: { name: 'Echo' } } },
      '/mandate': { body: { mandates: [live, mandate({ id: 'm2', scope: 'old-work', expiresAt: rel(-5) }), mandate({ id: 'm3', expiresAt: rel(72), revoked: { at: rel(-3), reason: 'wrong peer' } })] } },
      '/mandate/audit?limit=200': { body: { total: 2, chain: { ok: true }, entries: [entry({ ts: rel(-1) }), entry({ hash: 'h2', ts: rel(-2), decision: 'deny', action: 'execute-cutover', reason: 'action not in mandate' })] } },
      '/authorization-requests?status=pending': { status: 503, body: { error: 'authorization-requests feature not enabled' } },
      '/permissions/users': { body: { users } },
      '/threadline/health': { body: { fingerprint: FP_ECHO } },
      '/threadline/pairing/invites': { body: { invites: [], knownPeers: [{ fp: FP_DAWN, name: 'Dawn', pairingState: 'mutual-verified' }] } },
    };
    g.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
      if (opts && opts.method === 'POST') {
        posted.push({ url, body: JSON.parse(opts.body || '{}') });
        return { ok: true, status: 200, json: async () => ({ revoked: true, mandate: { ...live, revoked: { at: new Date().toISOString(), reason: 'wrong peer' } } }) };
      }
      const hit = table[url];
      if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'no such route in the test' }) };
      const status = hit.status || 200;
      return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(hit.body)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('1 slip active; nothing waiting.');
    expect(doc.querySelector('.incident')).toBeNull();
    expect(doc.querySelector('#sec-waiting')).toBeNull(); // the approvals feature is off here: no block, no false "nothing waiting" card
    expect([...doc.querySelectorAll('.fact')].map((f) => f.textContent)).toEqual(['1active slip', '1person with a grant', 'intactdecision record']);
    const cards = doc.querySelectorAll('.slip-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.slip-summary')!.textContent).toMatch(/^Echo and Dawn may sign a code review and hand over a read-only credential until /);
    expect(cards[0].querySelector('.slip-foot .row-sub')!.textContent).toBe('Also lets Mia act.');
    expect(doc.querySelector('#sec-ended .list-count')!.textContent).toBe('2');
    expect(doc.querySelector('#sec-ended .list-rows')!.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelector('#sec-history .history-line')!.textContent).toBe('1 allowed, 1 refused in the last 24 h.Record intact.');
    (doc.querySelector('#sec-history .list-head') as HTMLButtonElement).click();
    expect([...doc.querySelectorAll('#sec-history .row-title')].map((n) => n.textContent)).toEqual(['Allowed · Dawn may sign a code review', 'Refused · Dawn tried to run the cutover']);
    expect(doc.querySelector('.pin-input')).toBeNull();

    // Open the slip → its sheet carries the grant form and the quiet Revoke at the bottom.
    (cards[0] as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .sheet-title')!.textContent).toBe('Feedback migration');
    expect(doc.querySelector('.sheet select[aria-label="Who"] option')!.textContent).toBe('Mia — engineer');
    expect(doc.querySelector('.sheet .change-list li')!.textContent).toMatch(/^Mia may deploy to production until /);
    (doc.querySelector('.sheet button[data-revoke="m1"]') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .confirm-text')!.textContent).toBe('Ends this slip and the 1 grant it carries, now. Can’t be undone.');
    (doc.querySelector('.sheet textarea.reason-input') as HTMLTextAreaElement).value = 'wrong peer';
    (doc.querySelector('.sheet button[data-revoke-confirm="m1"]') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    const pin = doc.querySelector('.sheet form.pin-form input.pin-input') as HTMLInputElement;
    expect(pin).toBeTruthy();
    expect(doc.querySelector('.sheet .confirm-text')!.textContent).toContain('Ends “Feedback migration” and the 1 grant it carries, now. Can’t be undone.');
    pin.value = '246810';
    pin.form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('/mandate/m1/revoke');
    expect(posted[0].body).toEqual({ pin: '246810', reason: 'wrong peer' });
    expect(doc.querySelector('.pin-input')).toBeNull();
    expect(doc.querySelector('.sheet .action-status')!.textContent).toBe('Revoked. Everything this slip allowed is refused from now on.');
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 20));
    expect(doc.querySelector('.sheet')).toBeNull();
    expect(doc.querySelector('.pin-input')).toBeNull();
    expect(posted).toHaveLength(1); // the refresh never replayed the PIN or the write
  });
});
