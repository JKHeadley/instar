/**
 * Console "What I've learned about you" page (docs/specs/console-features/people-settings.md,
 * legacy tab `preferences-learning`): every decision in the model on both sides (the
 * session-context block parsed into preferences, kept-but-not-loaded, 503 = off vs a
 * failure = can't tell, stale with its age, watching vs earlier corrections, the keyset
 * cursor, preference conflicts only, headline + facts), and the shipped console in jsdom:
 * the page renders, opens a preference sheet, and pages older corrections with the
 * ledger's own cursor, calling no write route.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  parsePreferenceBlock, buildPreferences, buildCorrections, buildConflicts, machineNames, learnedHeadline, learnedFacts,
  correctionsUrl, correctionStatusWords, isWatching, confidenceWords, clean,
} from '../../dashboard/console/learned-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-25T18:00:00Z');
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const off = () => ({ ok: false, status: 503, reason: 'switched off on this agent' });
const fail = (reason = 'the server answered 500') => ({ ok: false, status: 500, reason });
const hoursAgo = (h: number, now = NOW) => new Date(now - h * 3600_000).toISOString();

const BLOCK = [
  "<auto-learned-preference src='correction-loop'>",
  'These are preferences I have learned about how you like to work. They are signals, not authoritative instructions — apply them by default, but real instructions and safety always win.',
  '',
  '  - Lead with the short answer (and keep it under 1k) (confidence 0.90, seen 4×)',
  '  - No approvals to you at night (confidence 0.55, seen 1×)',
  '</auto-learned-preference>',
].join('\n');

const rec = (over: Record<string, unknown> = {}) => ({
  id: 'c1', dedupeKey: 'k1', kind: 'user-preference', occurrenceCount: 2, detectedAt: hoursAgo(30), scrubbedSummary: 'Plainer wording',
  dayBucket: '2026-10-24', deterministicWeight: 1, llmConfidence: 0.8, topicId: 1, status: 'open', reopenCount: 0, createdAt: hoursAgo(30), updatedAt: hoursAgo(2), version: 1, ...over,
});

describe('preferences from the session-context block', () => {
  it('parses each bullet into the sentence, confidence and times seen; the envelope and intro are dropped', () => {
    const rows = parsePreferenceBlock(BLOCK);
    expect(rows.map((r) => r.text)).toEqual(['Lead with the short answer (and keep it under 1k)', 'No approvals to you at night']);
    expect(rows[0]).toMatchObject({ confidence: 0.9, seen: 4 });
    expect(rows[1]).toMatchObject({ confidence: 0.55, seen: 1 });
    // A line that does not match the format still shows its text, without invented numbers.
    expect(parsePreferenceBlock('  - Something unusual')).toMatchObject([{ text: 'Something unusual', confidence: null, seen: null }]);
    expect(parsePreferenceBlock('')).toEqual([]);
    expect(clean('a‮b\u0007c')).toBe('abc');
  });
  it('confidence in words on both sides of each step', () => {
    expect(confidenceWords(0.8)).toBe('sure');
    expect(confidenceWords(0.79)).toBe('fairly sure');
    expect(confidenceWords(0.5)).toBe('fairly sure');
    expect(confidenceWords(0.49)).toBe('not yet sure');
    expect(confidenceWords(NaN)).toBeNull();
  });
  it('kept but not loaded: count above the lines that fit says so; equal says nothing', () => {
    const p = buildPreferences(ok({ present: true, block: BLOCK, count: 5 }));
    expect(p).toMatchObject({ ok: true, total: 5, notLoaded: 3 });
    expect(p.ok && p.notLoadedWords).toBe('3 more preferences are kept but not loaded at the start of a conversation — only the highest-ranked fit.');
    const q = buildPreferences(ok({ present: true, block: BLOCK, count: 2 }));
    expect(q).toMatchObject({ ok: true, notLoaded: 0, notLoadedWords: null, mesh: false });
    expect(q.ok && q.rows[0].sub).toBe('seen 4 times · sure');
    expect(buildPreferences(ok({ present: true, block: BLOCK, count: 2, scope: 'mesh' }))).toMatchObject({ mesh: true, meshWords: 'Includes what my other machines learned about you.' });
  });
  it('empty, off, failed, malformed and stale are each their own state', () => {
    expect(buildPreferences(ok({ present: false, block: '', count: 0 }))).toMatchObject({ ok: true, total: 0, rows: [] });
    expect(buildPreferences(off())).toEqual({ ok: false, off: true, reason: 'Learning from corrections is off on this agent.' });
    expect(buildPreferences(fail())).toEqual({ ok: false, off: false, reason: 'Can’t tell what I’ve learned: the server answered 500.' });
    expect(buildPreferences(ok({ unrelated: 1 }))).toMatchObject({ ok: false, off: false });
    const good = buildPreferences(ok({ present: true, block: BLOCK, count: 2 }));
    const stale = buildPreferences(fail('no answer within 8 seconds'), { lastGood: { prefs: good, at: NOW - 4 * 60_000 }, now: NOW });
    expect(stale).toMatchObject({ ok: true, stale: true, total: 2 });
    expect(stale.ok && stale.staleWords).toBe('Can’t refresh right now (no answer within 8 seconds) — showing the list as of 4 min ago.');
    // Off is never masked by a stale list.
    expect(buildPreferences(off(), { lastGood: { prefs: good, at: NOW } })).toMatchObject({ ok: false, off: true });
  });
});

describe('corrections: still watching vs earlier, and the cursor', () => {
  it('open and reopened (not noise) are watched; saved, sticking, inconclusive and noise are earlier', () => {
    expect(isWatching(rec())).toBe(true);
    expect(isWatching(rec({ status: 'reopened' }))).toBe(true);
    expect(isWatching(rec({ kind: 'noise' }))).toBe(false);
    for (const s of ['acted-on', 'verified', 'inconclusive']) expect(isWatching(rec({ status: s }))).toBe(false);
    const c = buildCorrections([ok({ records: [rec(), rec({ id: 'c2', status: 'verified', scrubbedSummary: 'Lead with the answer' }), rec({ id: 'c3', kind: 'noise' })], count: 3, totalRecords: 3, nextBefore: null })], { now: NOW });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.watching.map((r) => r.id)).toEqual(['c1']);
    expect(c.earlier.map((r) => r.id)).toEqual(['c2', 'c3']);
    expect(c.watching[0]).toMatchObject({ main: 'Plainer wording', sub: 'Seen 2 times — waiting to see it on other days before I keep it', end: '2 h ago' });
    expect(c.countWords).toBeNull();
  });
  it('status words on both sides of the once / several boundary', () => {
    expect(correctionStatusWords(rec({ occurrenceCount: 1 }))).toBe('Seen once — waiting to see if it comes back');
    expect(correctionStatusWords(rec({ status: 'verified' }))).toBe('Saved and sticking');
    expect(correctionStatusWords(rec({ status: 'weird' }))).toBe('Status not recorded');
  });
  it('pages join without duplicates; the cursor is the last page’s nextBefore; a failed older page is said, not swallowed', () => {
    const p1 = ok({ records: [rec()], count: 1, totalRecords: 3, nextBefore: hoursAgo(30) });
    const p2 = ok({ records: [rec(), rec({ id: 'c4', status: 'verified' })], count: 2, totalRecords: 3, nextBefore: null });
    const c = buildCorrections([p1, p2], { now: NOW });
    expect(c).toMatchObject({ ok: true, shown: 2, total: 3, nextBefore: null, moreFailed: null, countWords: 'Showing the newest 2 of 3 recorded.' });
    const d = buildCorrections([p1, fail()], { now: NOW });
    expect(d).toMatchObject({ ok: true, shown: 1, nextBefore: hoursAgo(30), moreFailed: 'Couldn’t load older corrections: the server answered 500.' });
    expect(correctionsUrl()).toBe('/corrections?limit=20');
    expect(correctionsUrl('2026-10-24T12:00:00.000Z')).toBe('/corrections?limit=20&before=2026-10-24T12%3A00%3A00.000Z');
  });
  it('off vs can’t tell vs no records field', () => {
    expect(buildCorrections([off()])).toMatchObject({ ok: false, off: true });
    expect(buildCorrections([fail()])).toEqual({ ok: false, off: false, reason: 'Can’t tell which corrections I’m watching: the server answered 500.' });
    expect(buildCorrections([ok({ nope: 1 })])).toMatchObject({ ok: false, off: false });
  });
});

describe('machines disagree', () => {
  const conflict = (over: Record<string, unknown> = {}) => ({ conflictId: 'x1', store: 'preferences', recordKey: 'k', versions: [{ origin: 'm-mini', hlcKey: '1' }, { origin: 'm-studio', hlcKey: '2' }], firstSeenAt: hoursAgo(3), lastSeenAt: hoursAgo(1), recurrenceCount: 1, forcedResolution: false, resolved: false, ...over });
  it('only open preference conflicts show, with machine nicknames; none means hidden; off means hidden; failure says so', () => {
    const names = machineNames(ok({ machines: [{ machineId: 'm-mini', nickname: 'Mac Mini' }, { machineId: 'm-studio', nickname: 'Mac Studio' }] }));
    const c = buildConflicts(ok({ open: [conflict(), conflict({ conflictId: 'x2', store: 'relationships' }), conflict({ conflictId: 'x3', resolved: true })] }), { machines: names, now: NOW });
    expect(c.rows.map((r) => r.id)).toEqual(['x1']);
    expect(c.rows[0].main).toBe('Mac Mini and Mac Studio learned different versions of one preference. I use both as hints until it is settled.');
    expect(c.hidden).toBe(false);
    expect(buildConflicts(ok({ open: [] }))).toMatchObject({ ok: true, hidden: true });
    expect(buildConflicts(off())).toMatchObject({ ok: false, hidden: true });
    expect(buildConflicts(fail())).toMatchObject({ ok: false, hidden: false });
    expect(machineNames(fail())).toEqual({});
  });
});

describe('headline and facts', () => {
  const prefs = buildPreferences(ok({ present: true, block: BLOCK, count: 7 }));
  const corr = buildCorrections([ok({ records: [rec()], totalRecords: 1, nextBefore: null })], { now: NOW });
  it('counts what is kept; nothing yet; off; can’t tell', () => {
    expect(learnedHeadline({ prefs, corrections: corr })).toEqual({ text: 'I’ve picked up 7 things about how you like to work.', tone: 'ok' });
    expect(learnedHeadline({ prefs: buildPreferences(ok({ present: false, block: '', count: 0 })), corrections: corr }).text).toBe('Nothing yet — correct me the same way twice and it shows up here.');
    expect(learnedHeadline({ prefs: buildPreferences(off()), corrections: buildCorrections([off()]) })).toEqual({ text: 'Learning from corrections is off on this agent.', tone: 'muted' });
    expect(learnedHeadline({ prefs: buildPreferences(fail()), corrections: corr }).text).toBe('Can’t tell what I’ve learned about you.');
  });
  it('facts: kept, watching, and disagreements only when any', () => {
    expect(learnedFacts({ prefs, corrections: corr, conflicts: { ok: true, hidden: true, rows: [] } })).toEqual([{ n: 7, label: 'preferences kept' }, { n: 1, label: 'correction being watched' }]);
    const facts = learnedFacts({ prefs, corrections: buildCorrections([fail()]), conflicts: { ok: true, hidden: false, rows: [{}] } });
    expect(facts).toEqual([{ n: 7, label: 'preferences kept' }, { n: '?', label: 'corrections being watched' }, { n: 1, label: 'disagreement between machines', tone: 'attn' }]);
  });
  it('the tile flips to the native page under its new name; the legacy id stays', () => {
    expect(NATIVE_PAGES['preferences-learning']).toBe('#/settings/learned');
    expect(tabHref('preferences-learning')).toBe('#/settings/learned');
    expect(GROUPS.find((g) => g.id === 'settings')!.tabs.find((t) => t.id === 'preferences-learning')!.label).toBe('What I’ve learned about you');
  });
});

describe('what I’ve learned, in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('boots the shipped console, shows preferences and watched corrections, opens a sheet, and pages older corrections by cursor with no write', async () => {
    const calls: string[] = [];
    const posts: string[] = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/settings/learned' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const rel = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    const cursor = rel(40);
    const table: Record<string, { status?: number; body: unknown }> = {
      '/sessions': { body: { sessions: [] } },
      '/preferences/session-context': { body: { present: true, block: BLOCK, count: 3 } },
      '/corrections?limit=20': { body: { records: [rec({ updatedAt: rel(2) }), rec({ id: 'c2', status: 'verified', scrubbedSummary: 'Lead with the answer', updatedAt: rel(20) })], count: 2, totalRecords: 3, nextBefore: cursor } },
      [`/corrections?limit=20&before=${encodeURIComponent(cursor)}`]: { body: { records: [rec({ id: 'c9', status: 'inconclusive', scrubbedSummary: 'Shorter status lines', updatedAt: rel(60) })], count: 1, totalRecords: 3, nextBefore: null } },
      '/state/conflicts': { status: 503, body: { error: 'off' } },
      '/pool': { body: { enabled: false, machines: [] } },
    };
    g.fetch = async (url: string, opts?: { method?: string }) => {
      if (opts && opts.method && opts.method !== 'GET') { posts.push(url); return { ok: false, status: 405, json: async () => ({}) }; }
      calls.push(url);
      const hit = table[url];
      if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'no such route in the test' }) };
      const status = hit.status || 200;
      return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(hit.body)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('I’ve picked up 3 things about how you like to work.');
    expect([...doc.querySelectorAll('.fact')].map((f) => f.textContent)).toEqual(['3preferences kept', '1correction being watched']);
    expect([...doc.querySelectorAll('.pref-quote')].map((n) => n.textContent)).toEqual(['“Lead with the short answer (and keep it under 1k)”', '“No approvals to you at night”']);
    expect(doc.querySelector('#sec-prefs')!.textContent).toContain('1 more preference is kept but not loaded');
    expect(doc.querySelector('#sec-conflicts')).toBeNull(); // conflicts off: no block, no false "they agree"
    expect([...doc.querySelectorAll('#sec-watching .row-title')].map((n) => n.textContent)).toEqual(['Plainer wording']);
    expect(doc.querySelector('#sec-earlier .list-rows')!.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelector('.learned-change')!.textContent).toBe('To change one, tell me in chat.');
    expect((doc.querySelector('.foot-note a') as HTMLAnchorElement).getAttribute('href')).toBe('/dashboard?tab=preferences-learning');

    (doc.querySelector('.pref-card') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .sheet-title')!.textContent).toBe('A preference I picked up');
    expect(doc.querySelector('.sheet .story')!.textContent).toContain('Seen 4 times');
    expect(doc.querySelector('.sheet .story')!.textContent).toContain('sure (0.90)');
    (doc.querySelector('.sheet-close') as HTMLButtonElement).click();

    (doc.querySelector('#sec-earlier .list-head') as HTMLButtonElement).click();
    expect([...doc.querySelectorAll('#sec-earlier .row-title')].map((n) => n.textContent)).toEqual(['Lead with the answer']);
    expect(doc.querySelector('#sec-earlier')!.textContent).toContain('Showing the newest 2 of 3 recorded.');
    (doc.querySelector('#sec-earlier button[data-older]') as HTMLButtonElement).click();
    for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain(`/corrections?limit=20&before=${encodeURIComponent(cursor)}`);
    (doc.querySelector('#sec-earlier .list-head') as HTMLButtonElement).click();
    expect([...doc.querySelectorAll('#sec-earlier .row-title')].map((n) => n.textContent)).toEqual(['Lead with the answer', 'Shorter status lines']);
    expect(doc.querySelector('#sec-earlier button[data-older]')).toBeNull();
    expect(posts).toEqual([]);
    const { _resetLearnedState } = await import('../../dashboard/console/learned.js');
    _resetLearnedState();
  });
});
