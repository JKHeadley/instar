/**
 * Console "How I'm doing inside" page (docs/specs/console-features/under-the-hood.md:
 * Integrated-Being + Process health + "Checks on my own claims" + Evidence lookup, in one
 * view). Every decision in the model on both sides (counts only within the records shown,
 * a commitment whose later history is not loaded is "unknown" and never "open", the
 * backwards chain, bindings and the exact revoke request; the problems section's week total,
 * "still open among those shown", `before` paging and stale-with-its-time; four verdict words
 * with coverage notes apart; the lookup's inferred kind and its honest empties; the headline
 * worst-first with coverage), and the shipped console in jsdom: the page renders all four
 * sections, filters by chip, opens a commitment sheet, pages older problems by `before`,
 * and revokes a binding only after its confirm, with the intent header and no PIN.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildActivity, commitmentStatus, recentUrl, buildChain, validEntryId, buildStats, buildBindings, revokeRequest, revokeResultWords,
  buildProblems, failuresUrl, insightActive, buildClaims, classifyAudit, buildReviews, inferLookup, lookupUrl, buildLookup,
  insideHeadline, insideFacts, machineNote, clean, counterpartyWords,
} from '../../dashboard/console/inside-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-26T18:00:00Z');
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const off = () => ({ ok: false, status: 503, reason: 'switched off on this agent' });
const fail = (reason = 'the server answered 500') => ({ ok: false, status: 500, reason });
const hoursAgo = (h: number, now = NOW) => new Date(now - h * 3600_000).toISOString();

let seq = 0;
const ent = (over: Record<string, unknown> = {}) => ({
  id: (++seq).toString(16).padStart(12, '0'), t: hoursAgo(2), emittedBy: { subsystem: 'threadline', instance: 'srv' }, kind: 'decision',
  subject: 'Decided to retry on Codex', counterparty: { type: 'self', name: 'self', trustTier: 'trusted' }, provenance: 'subsystem-asserted', dedupKey: 'k', ...over,
});
const commitment = (over: Record<string, unknown> = {}) => ent({
  kind: 'commitment', subject: 'Hand off the review', counterparty: { type: 'agent', name: 'Dawn', trustTier: 'trusted' },
  commitment: { mechanism: { type: 'passive-wait', refResolvedAt: hoursAgo(3), refStatus: 'valid' }, status: 'open', deadline: hoursAgo(1) }, ...over,
});

describe('recent activity: counted within the records shown', () => {
  it('counts kinds only among the loaded records, newest first, and says the window', () => {
    const entries = [ent({ t: hoursAgo(5) }), ent({ kind: 'agreement', subject: 'Agreed with Dawn', counterparty: { type: 'agent', name: 'Dawn' }, t: hoursAgo(1) }),
      ent({ kind: 'thread-opened', t: hoursAgo(3) }), ent({ kind: 'thread-abandoned', subject: 'Thread with PP', t: hoursAgo(30) })];
    const a = buildActivity(ok({ entries }), { now: NOW });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.n).toBe(4);
    expect(a.line).toBe('Among the 4 most recent records: 1 decision, 1 agreement, 1 thread opened, 1 marked abandoned.');
    expect(a.rows.map((r) => r.kind)).toEqual(['agreement', 'thread-opened', 'decision', 'thread-abandoned']);
    expect(a.tiles).toEqual([{ n: 1, label: 'decision' }, { n: 1, label: 'agreement' }, { n: 2, label: 'thread events', tone: 'attn' }]);
    expect(a.tilesNote).toBe('of the last 4');
    expect(a.rows[0].sub).toBe('Agreement · with Dawn');
    expect(a.rows[3].tone).toBe('attn');
    expect(a.groups.map((g) => g.label)[0]).toBe('Today');
  });
  it('chips filter what is shown but never the counts; kind and the counterparty query are the legacy filters', () => {
    const entries = [ent(), ent({ kind: 'agreement', counterparty: { type: 'user', name: 'user' } }), ent({ kind: 'thread-closed' })];
    const a = buildActivity(ok({ entries }), { chip: 'threads', now: NOW });
    expect(a.ok && a.rows.map((r) => r.kind)).toEqual(['thread-closed']);
    expect(a.ok && a.n).toBe(3);
    expect(a.ok && a.chipCounts).toMatchObject({ all: 3, threads: 1, people: 1, agents: 0, decision: 1 });
    const k = buildActivity(ok({ entries }), { kind: 'agreement', now: NOW });
    expect(k.ok && k.rows.map((r) => r.sub)).toEqual(['Agreement · with you']);
    expect(recentUrl()).toBe('/shared-state/recent?limit=40');
    expect(recentUrl({ limit: 999, counterparty: 'agent' })).toBe('/shared-state/recent?limit=200&counterpartyType=agent');
    expect(recentUrl({ counterparty: 'nonsense' })).toBe('/shared-state/recent?limit=40');
  });
  it('Show more is offered only while a full window came back, up to the route’s 200', () => {
    const many = Array.from({ length: 40 }, () => ent());
    expect(buildActivity(ok({ entries: many }), { limit: 40 })).toMatchObject({ canShowMore: true, nextLimit: 80 });
    expect(buildActivity(ok({ entries: many.slice(0, 12) }), { limit: 40 })).toMatchObject({ canShowMore: false });
    expect(buildActivity(ok({ entries: many }), { limit: 200 })).toMatchObject({ canShowMore: false });
  });
  it('off, failed, malformed and empty are each their own state', () => {
    expect(buildActivity(off())).toEqual({ ok: false, off: true, reason: 'This record is off on this agent.' });
    expect(buildActivity(fail())).toMatchObject({ ok: false, off: false, reason: 'Can’t tell what my other conversations have been doing: the server answered 500.' });
    expect(buildActivity(ok({ nope: 1 }))).toMatchObject({ ok: false, off: false });
    expect(buildActivity(ok({ entries: [] }))).toMatchObject({ ok: true, n: 0, line: 'Nothing recorded recently.' });
  });
  it('counterparty words and the sanitizer', () => {
    expect(counterpartyWords({ type: 'agent', name: 'PP' })).toBe('with PP');
    expect(counterpartyWords({ type: 'system', name: 'x' })).toBe('by the system');
    expect(counterpartyWords(null)).toBe('with someone not recorded');
    expect(clean('a‮b\u0007c')).toBe('abc');
  });
});

describe('a commitment’s status is never “open” without its later history', () => {
  it('no superseding entry in the window → unknown; a later note decides; stored non-open wins', () => {
    const c = commitment();
    expect(commitmentStatus(c, [c])).toMatchObject({ key: 'unknown', known: false, words: 'Status unknown: later history isn’t loaded' });
    const exp = ent({ kind: 'note', subject: 'expired: hand off', supersedes: c.id, t: hoursAgo(0.5) });
    expect(commitmentStatus(c, [c, exp])).toMatchObject({ key: 'expired', known: true });
    const res = ent({ kind: 'note', subject: 'Handed off', supersedes: c.id });
    expect(commitmentStatus(c, [c, res])).toMatchObject({ key: 'resolved' });
    expect(commitmentStatus(commitment({ commitment: { mechanism: { type: 'user-driven' }, status: 'cancelled' } }), [])).toMatchObject({ key: 'cancelled' });
  });
  it('the row says overdue and disputed, and tones the unknown as unknown', () => {
    const c = commitment();
    const d1 = ent({ kind: 'note', subject: 'no', disputes: c.id });
    const d2 = ent({ kind: 'note', subject: 'no', disputes: c.id });
    const a = buildActivity(ok({ entries: [c, d1, d2] }), { now: NOW });
    const row = a.ok && a.rows.find((r) => r.id === c.id);
    expect(row && row.sub).toBe('Commitment · with Dawn · Status unknown: later history isn’t loaded · overdue · disputed twice');
    expect(row && row.tone).toBe('attn');
    const plain = buildActivity(ok({ entries: [commitment({ commitment: { mechanism: { type: 'passive-wait' }, status: 'open', deadline: hoursAgo(-5) } })] }), { now: NOW });
    expect(plain.ok && plain.rows[0].tone).toBe('unknown');
  });
});

describe('chain, counters and bindings', () => {
  it('the backwards chain as a short history; the id check is the legacy one', () => {
    const c = buildChain(ok({ chain: [ent({ subject: 'Now' }), ent({ subject: 'Before' })] }), { now: NOW });
    expect(c).toMatchObject({ ok: true, words: 'It replaced 1 earlier record.' });
    expect(c.ok && c.rows.map((r) => r.main)).toEqual(['Now', 'Before']);
    expect(buildChain(ok({ chain: [ent()] }))).toMatchObject({ words: 'It did not replace anything I can find.' });
    expect(buildChain(fail())).toMatchObject({ ok: false });
    expect(validEntryId('0123456789ab')).toBe(true);
    expect(validEntryId('0123456789AB')).toBe(false);
    expect(validEntryId('0123')).toBe(false);
  });
  it('counters are raw, the TTL counter carries its caveat', () => {
    const s = buildStats(ok({ counts: { decision: 3, note: 2 }, classifierFired: 1, rotationCount: 0, unclosedThreadsOverTtl: 0 }));
    expect(s.ok && s.lines[0]).toEqual({ label: 'Records kept (all kinds)', text: '5' });
    expect(s.ok && s.ttlNote).toMatch(/proves nothing/);
    expect(buildStats(off())).toMatchObject({ ok: false, off: true });
  });
  it('bindings: 503 hides the block, a failure says so; revoked rows cannot be revoked again', () => {
    const b = buildBindings(ok({ sessions: [
      { sessionId: '11111111-1111-4111-8111-111111111111', label: 'topic 4120', registeredAt: hoursAgo(5), lastActiveAt: hoursAgo(1), absoluteExpiresAt: hoursAgo(-20), idleExpiresAt: hoursAgo(-2), hasWritten: true, revoked: false },
      { sessionId: '22222222-2222-4222-8222-222222222222', registeredAt: hoursAgo(5), lastActiveAt: hoursAgo(1), absoluteExpiresAt: hoursAgo(-20), idleExpiresAt: hoursAgo(-2), hasWritten: false, revoked: true },
    ] }), { now: NOW });
    expect(b.ok && b.rows.map((r) => [r.main, r.status.key, r.canRevoke])).toEqual([['Session name unavailable', 'active', true], ['Session name unavailable', 'revoked', false]]);
    expect(buildBindings(off())).toEqual({ ok: false, hidden: true });
    expect(buildBindings(fail())).toMatchObject({ ok: false, hidden: false });
    expect(revokeRequest('a b')).toEqual({ method: 'POST', path: '/shared-state/sessions/a%20b/revoke', headers: { 'X-Instar-Request': '1' } });
    expect(revokeResultWords({ ok: true, status: 200, data: { revoked: true } })).toMatchObject({ ok: true });
    expect(revokeResultWords({ ok: false, status: 404, data: {} })).toEqual({ ok: true, message: 'Already gone: that binding is no longer registered.' });
    expect(revokeResultWords({ ok: false, status: 403, data: { error: 'revocation requires X-Instar-Request: 1 header' } }).ok).toBe(false);
  });
});

describe('problems I caught', () => {
  const failure = (over: Record<string, unknown> = {}) => ({ id: `f${++seq}`, category: 'concurrency', summary: 'Two writers raced', status: 'open', detectedAt: hoursAgo(10), occurrenceCount: 1, attribution: 'automatic', detail: { redacted: 'src/x.ts' }, ...over });
  const insight = (over: Record<string, unknown> = {}) => ({ id: `i${++seq}`, summary: 'Timing clashes', status: 'discovered', distinctSessions: 4, distinctCauseCommits: 2, reopenCount: 0, supportingFailureIds: [], discoveredAt: hoursAgo(80), ...over });
  const week = (total: number) => ok({ total, attributed: 0, byCategory: {}, unknownToolchainByAuthor: {}, noFeatureLink: 0, rollout: { stage: 'capture-only' } });
  it('repeating vs nothing repeating, the week’s whole-ledger total, still open among those shown', () => {
    const p = buildProblems({ insights: ok({ insights: [insight()] }), pages: [ok({ failures: [failure(), failure({ status: 'resolved' })] })], week: week(3), all: week(9) }, { now: NOW });
    expect(p.ok && p.line).toBe('One kind of problem keeps coming back: Timing clashes, across 4 changes.');
    expect(p.ok && p.tiles).toEqual([{ n: 1, label: 'repeating', tone: null }, { n: 3, label: 'this week' }, { n: 1, label: 'still open among those shown' }]);
    expect(p.ok && p.stageWords).toBe('Watching quietly (no alerts)');
    const q = buildProblems({ insights: ok({ insights: [insight({ status: 'verified-effective' })] }), pages: [ok({ failures: [failure({ status: 'resolved' })] })], week: week(3), all: week(9) }, { now: NOW });
    expect(q.ok && q.line).toBe('Nothing repeating. 3 one-off problems this week, none still open among those shown.');
    expect(insightActive({ status: 'dismissed' })).toBe(false);
    expect(insightActive({ status: 'verified-ineffective' })).toBe(true);
    const back = buildProblems({ insights: ok({ insights: [insight({ reopenCount: 1 })] }), pages: [ok({ failures: [] })], week: week(0), all: week(0) });
    expect(back.ok && back.tiles[0]).toEqual({ n: 1, label: 'repeating', tone: 'attn' });
  });
  it('a failed insights read is can’t-tell for patterns only, never “nothing repeating”', () => {
    const p = buildProblems({ insights: fail(), pages: [ok({ failures: [] })], week: week(0), all: week(0) });
    expect(p.ok && p.patterns.ok).toBe(false);
    expect(p.ok && p.line).toMatch(/^Can’t tell whether anything is repeating/);
    expect(p.ok && p.tiles[0]).toEqual({ n: '?', label: 'repeating', tone: 'unknown' });
  });
  it('pages older problems by the route’s own `before` timestamp; a failed older page is said', () => {
    const page1 = Array.from({ length: 10 }, (_, i) => failure({ detectedAt: hoursAgo(i + 1) }));
    const p = buildProblems({ insights: ok({ insights: [] }), pages: [ok({ failures: page1 })], week: week(10), all: week(10) });
    expect(p).toMatchObject({ ok: true, canShowOlder: true, oldest: hoursAgo(10) });
    expect(failuresUrl()).toBe('/failures?limit=10');
    expect(failuresUrl('2026-10-25T00:00:00.000Z')).toBe('/failures?limit=10&before=2026-10-25T00%3A00%3A00.000Z');
    const q = buildProblems({ insights: ok({ insights: [] }), pages: [ok({ failures: page1 }), fail()], week: week(10), all: week(10) });
    expect(q).toMatchObject({ ok: true, canShowOlder: false, moreFailed: 'Couldn’t load older problems: the server answered 500.' });
    expect(buildProblems({ insights: ok({ insights: [] }), pages: [ok({ failures: page1.slice(0, 3) })], week: week(3), all: week(3) })).toMatchObject({ canShowOlder: false });
  });
  it('off, failed, and stale with the time it last knew', () => {
    expect(buildProblems({ insights: off(), pages: [off()], week: off(), all: off() })).toEqual({ ok: false, off: true, reason: 'Failure watching is off on this agent.' });
    expect(buildProblems({ insights: fail(), pages: [fail()], week: fail(), all: fail() })).toMatchObject({ ok: false, off: false });
    const good = buildProblems({ insights: ok({ insights: [] }), pages: [ok({ failures: [failure()] })], week: week(1), all: week(1) });
    const stale = buildProblems({ insights: fail(), pages: [fail('no answer within 8 seconds')], week: fail(), all: fail() }, { lastGood: { model: good, at: NOW - 600_000 } });
    expect(stale).toMatchObject({ ok: true, stale: true });
    expect(stale.ok && stale.staleWords).toMatch(/^Showing what I knew at .+; couldn’t refresh since \(no answer within 8 seconds\)\.$/);
  });
});

describe('checks on my own claims', () => {
  it('four verdict words across both vocabularies; events and settlements are coverage notes, never verdicts', () => {
    expect(classifyAudit({ verdict: 'supported', claimId: 'x' })).toBe('supports');
    expect(classifyAudit({ verdict: 'corroborated', evaluated: true })).toBe('supports');
    expect(classifyAudit({ verdict: 'refuted' })).toBe('contradicts');
    expect(classifyAudit({ verdict: 'uncorroborated-contradicted', evaluated: true })).toBe('contradicts');
    expect(classifyAudit({ verdict: 'unverifiable' })).toBe('unverified');
    expect(classifyAudit({ verdict: 'uncorroborated-unknown' })).toBe('unverified');
    expect(classifyAudit({ verdict: 'not-eligible' })).toBe('not-evaluated');
    expect(classifyAudit({ event: 't0-settlement' })).toBe('coverage');
    expect(classifyAudit({ evaluated: false, event: 'coverage-incomplete', reason: 'privacy-boundary' })).toBe('coverage');
    expect(classifyAudit({ weird: 1 })).toBeNull();
  });
  it('a contradiction leads; newest first; every row says advisory only', () => {
    const records = [
      { verdict: 'corroborated', evaluated: true, actionKind: 'merged', ts: hoursAgo(5) },
      { verdict: 'refuted', predicate: 'pull-request.merged', observedAt: hoursAgo(1), eventUuid: 'e2' },
      { event: 'coverage-incomplete', evaluated: false, ts: hoursAgo(2) },
    ];
    const c = buildClaims(ok({ records }), { now: NOW });
    expect(c).toMatchObject({ ok: true, n: 2, contradicted: 1, line: 'Of the last 2 observations, 1 contradicts what I said.' });
    expect(c.ok && c.observations.map((o) => o.main)).toEqual(['Said that a pull request was merged', 'Said a change was merged']);
    expect(c.ok && c.observations[0]).toMatchObject({ tone: 'bad', sub: 'Evidence contradicts it · Advisory only — nothing was blocked.' });
    expect(c.ok && c.coverage.map((x) => x.main)).toEqual(['Part of a message could not be checked (privacy boundary)']);
    expect(buildClaims(ok({ records: [records[0]] }))).toMatchObject({ line: 'Recent claim observations: none contradict what I said.' });
    expect(buildClaims(ok({ records: [] }))).toMatchObject({ line: 'No claims checked yet.' });
    expect(buildClaims(off())).toMatchObject({ ok: false, off: true });
    expect(buildClaims(fail())).toMatchObject({ ok: false, off: false });
  });
  it('class reviews: verdict in words, newest first, off separate from failed', () => {
    const r = buildReviews(ok({ records: [
      { dedupeKey: 'a', fillState: 'filled', standardReview: { verdict: 'needs-upgrade' }, processReview: { verdict: 'process-gap' }, reviewLifecycle: 'open', recurrenceCount: 2, updatedAt: hoursAgo(1) },
      { dedupeKey: 'b', fillState: 'pending', reviewLifecycle: 'open', recurrenceCount: 1, updatedAt: hoursAgo(9) },
    ], count: 2, open: 2 }), { now: NOW });
    expect(r.ok && r.rows.map((x) => x.main)).toEqual(['A standard needs an upgrade; A gap in how I work', 'Review pending']);
    expect(r.ok && r.rows[0].sub).toBe('Open · seen 2 times');
    expect(buildReviews(off())).toMatchObject({ ok: false, off: true });
  });
});

describe('look up a memory’s sources', () => {
  it('infers the kind; the picker only when ambiguous', () => {
    expect(inferLookup('fb_0123abcd')).toMatchObject({ kind: 'feedback', ambiguous: false });
    expect(inferLookup('https://example.com/x')).toMatchObject({ kind: 'external-url', ambiguous: false });
    expect(inferLookup('a1b2c3d')).toMatchObject({ kind: 'commit', ambiguous: false });
    expect(inferLookup('11111111-1111-4111-8111-111111111111')).toMatchObject({ candidates: ['entity', 'session'], ambiguous: true });
    expect(inferLookup('0123456789ab')).toMatchObject({ candidates: ['ledger-entry', 'commit'], ambiguous: true });
    expect(inferLookup('report.md')).toMatchObject({ candidates: [], ambiguous: true });
    expect(inferLookup('  ')).toMatchObject({ empty: true, ambiguous: false });
    expect(lookupUrl({ id: 'u1', kind: 'entity', scope: 'shared-topic' })).toBe('/memory/evidence/by-entity/u1?viewerScope=shared-topic');
    expect(lookupUrl({ id: 'a b', kind: 'commit', scope: 'bogus' })).toBe('/memory/entities/by-evidence?kind=commit&sourceId=a%20b&viewerScope=private');
  });
  it('sources, none (amber), narrowed-and-hidden, citers, off and failure', () => {
    const src = buildLookup(ok({ evidence: [{ kind: 'commit', sourceId: 'a1b2c3d4e5f6', updatedAt: hoursAgo(3) }, { kind: 'message', sourceId: 'm1', note: 'You said so', updatedAt: hoursAgo(40) }] }), { kind: 'entity', now: NOW });
    expect(src).toMatchObject({ ok: true, mode: 'sources', words: 'Based on 2 sources, from this machine’s memory.' });
    expect(src.ok && src.rows.map((r) => r.main)).toEqual(['Commit a1b2c3d4e5f6', 'A message']);
    expect(buildLookup(ok({ evidence: [] }), { kind: 'entity' })).toMatchObject({ words: 'No sources recorded for this, so I can’t show why.', tone: 'attn' });
    expect(buildLookup({ ok: false, status: 404, reason: 'the server answered 404' }, { kind: 'entity', scope: 'shared-topic' })).toMatchObject({ ok: true, words: 'Nothing is visible to people in this topic.' });
    expect(buildLookup(ok({ entities: [{ id: 'e1', name: 'Justin prefers plain summaries', type: 'person', content: 'x' }] }), { kind: 'feedback' })).toMatchObject({ mode: 'citers', words: '1 memory relies on this source, from this machine’s memory.' });
    expect(buildLookup(off(), { kind: 'entity' })).toMatchObject({ ok: false, off: true });
    expect(buildLookup(fail(), { kind: 'commit' })).toMatchObject({ ok: false, off: false, reason: 'Can’t tell: the server answered 500.' });
  });
});

describe('headline and facts', () => {
  const quietProblems = buildProblems({ insights: ok({ insights: [] }), pages: [ok({ failures: [] })], week: ok({ total: 0, rollout: { stage: 'capture-only' } }), all: ok({ total: 0 }) });
  const activity = buildActivity(ok({ entries: [ent()] }), { now: NOW });
  it('a contradicted claim leads; then a problem that came back; quiet otherwise; coverage named', () => {
    const contra = buildClaims(ok({ records: [{ verdict: 'refuted', observedAt: hoursAgo(1) }] }));
    expect(insideHeadline({ activity, problems: quietProblems, claims: contra })).toMatchObject({ text: 'One of my recent claims was contradicted by the evidence.', tone: 'attn' });
    const fine = buildClaims(ok({ records: [{ verdict: 'supported', observedAt: hoursAgo(1) }] }));
    expect(insideHeadline({ activity, problems: quietProblems, claims: fine })).toEqual({ text: 'Nothing repeating, no recent claim contradicted.', tone: 'ok', sub: null });
    const h = insideHeadline({ activity: buildActivity(fail()), problems: quietProblems, claims: fine });
    expect(h).toMatchObject({ tone: 'muted', sub: 'Couldn’t read: conversation history.' });
    expect(insideHeadline({ activity: buildActivity(fail()), problems: buildProblems({ insights: fail(), pages: [fail()], week: fail(), all: fail() }), claims: buildClaims(fail()) }).text).toBe('Can’t tell how I’m doing inside.');
    const offP = buildProblems({ insights: off(), pages: [off()], week: off(), all: off() });
    expect(insideHeadline({ activity, problems: offP, claims: buildClaims(off()) }).sub).toBe('Failure watching is off on this agent.');
  });
  it('facts: at most four, unknown when a source failed, contradicted in red', () => {
    const facts = insideFacts({ activity, problems: quietProblems, claims: buildClaims(ok({ records: [{ verdict: 'refuted' }] })), reviews: buildReviews(ok({ records: [] })) });
    expect(facts.map((f) => [f.n, f.label, f.tone ?? null])).toEqual([[1, 'recent records', null], [0, 'repeating', null], [1, 'contradicted', 'bad'], [0, 'class reviews', null]]);
    expect(insideFacts({ activity: buildActivity(fail()), problems: quietProblems, claims: buildClaims(off()) })[0]).toMatchObject({ n: '?', tone: 'unknown' });
    expect(machineNote(ok({ machines: [{}, {}] }))).toBe('This machine only: other machines keep their own record.');
    expect(machineNote(ok({ enabled: false, machines: [] }))).toBeNull();
  });
  it('the three legacy tiles open this page (and its sections); the old names stay as tile ids', () => {
    expect(NATIVE_PAGES['integrated-being']).toBe('#/settings/inside');
    expect(tabHref('process-health')).toBe('#/settings/inside?s=problems');
    expect(tabHref('evidence')).toBe('#/settings/inside?s=lookup');
    const hood = GROUPS.find((g) => g.id === 'settings')!.hood!;
    expect(hood.find((t) => t.id === 'integrated-being')!.label).toBe('How I’m doing inside');
    expect(hood.find((t) => t.id === 'integrated-being')!.desc).toBe('Conversation history, recurring problems, checks on my claims.');
  });
});

describe('how I’m doing inside, in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('boots the shipped console: four sections, a chip filter, a commitment sheet, older problems by `before`, and a revoke only after its confirm, with the intent header and no PIN', async () => {
    const calls: string[] = [];
    const writes: Array<{ url: string; headers: Record<string, string> }> = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/settings/inside' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const rel = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    const c = { ...commitment({ t: rel(2), commitment: { mechanism: { type: 'scheduled-job', refResolvedAt: rel(3), refStatus: 'valid' }, status: 'open', deadline: rel(-4) } }) };
    const page1 = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, category: 'config-parse', summary: `Bad setting ${i}`, status: i === 0 ? 'open' : 'resolved', detectedAt: rel(i + 1), occurrenceCount: 1, attribution: 'automatic', detail: { redacted: '' } }));
    const oldest = page1[9].detectedAt;
    const sid = '11111111-1111-4111-8111-111111111111';
    const table: Record<string, { status?: number; body: unknown }> = {
      '/sessions': { body: { sessions: [] } },
      '/shared-state/recent?limit=40': { body: { entries: [ent({ t: rel(1), subject: 'Decided to retry on Codex' }), c, ent({ kind: 'thread-opened', subject: 'Thread with PP', t: rel(3) })] } },
      '/shared-state/stats': { body: { counts: { decision: 1, commitment: 1, 'thread-opened': 1 }, classifierFired: 0, rotationCount: 0, unclosedThreadsOverTtl: 0 } },
      '/shared-state/sessions': { body: { sessions: [{ sessionId: sid, label: 'Design conversation', registeredAt: rel(5), lastActiveAt: rel(1), absoluteExpiresAt: rel(-20), idleExpiresAt: rel(-2), hasWritten: true, revoked: false }] } },
      '/pool': { body: { enabled: false, machines: [] } },
      '/failures/insights?limit=50': { body: { insights: [] } },
      '/failures/analysis?sinceDays=7': { body: { total: 10, attributed: 10, byCategory: { 'config-parse': 10 }, unknownToolchainByAuthor: {}, noFeatureLink: 0, rollout: { stage: 'capture-only' } } },
      '/failures/analysis': { body: { total: 12, attributed: 10, byCategory: { 'config-parse': 12 }, unknownToolchainByAuthor: {}, noFeatureLink: 0, rollout: { stage: 'capture-only' } } },
      '/failures?limit=10': { body: { failures: page1 } },
      [`/failures?limit=10&before=${encodeURIComponent(oldest)}`]: { body: { failures: [{ id: 'old1', category: 'wiring', summary: 'Hook not wired', status: 'resolved', detectedAt: rel(40), occurrenceCount: 2, attribution: 'inferred', detail: { redacted: '' } }] } },
      '/completion-claim/audit?limit=20': { body: { records: [{ verdict: 'corroborated', evaluated: true, actionKind: 'pushed', ts: rel(2) }], count: 1 } },
      '/class-reviews?limit=20': { status: 503, body: { error: 'off' } },
    };
    g.fetch = async (url: string, opts?: { method?: string; headers?: Record<string, string> }) => {
      if (opts && opts.method && opts.method !== 'GET') {
        writes.push({ url, headers: opts.headers || {} });
        return { ok: true, status: 200, json: async () => ({ revoked: true, sessionId: sid }) };
      }
      calls.push(url);
      const hit = table[url];
      if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'no such route in the test' }) };
      const status = hit.status || 200;
      return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(hit.body)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 20)); };
    await settle();
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('Nothing repeating, no recent claim contradicted.');
    expect([...doc.querySelectorAll('.page-hero .fact')].map((f) => f.textContent)).toEqual(['3recent records', '0repeating', '0contradicted']);
    expect(['activity', 'problems', 'claims', 'lookup'].every((s) => doc.querySelector(`#sec-${s}`))).toBe(true);
    expect(doc.querySelector('#sec-activity .inside-line')!.textContent).toBe('Among the 3 most recent records: 1 decision, 1 thread opened.');
    expect([...doc.querySelectorAll('#sec-activity .inside-day .row-title')].map((n) => n.textContent)).toEqual(['Decided to retry on Codex', 'Hand off the review', 'Thread with PP']);
    expect(doc.querySelector('#sec-claims')!.textContent).toContain('Reviewing my corrections is off on this agent.');
    expect(doc.querySelector('#sec-problems .inside-line')!.textContent).toBe('Nothing repeating. 10 one-off problems this week.');

    // A chip filters what is shown (the counts stay the window's).
    (doc.querySelector('[data-chip="commitment"]') as HTMLButtonElement).click();
    await settle();
    expect([...doc.querySelectorAll('#sec-activity .inside-day .row-title')].map((n) => n.textContent)).toEqual(['Hand off the review']);
    expect(doc.querySelector('#sec-activity .inside-line')!.textContent).toBe('Among the 3 most recent records: 1 decision, 1 thread opened.');

    // The commitment's sheet: full status, unknown rather than open.
    (doc.querySelector('#sec-activity .inside-day .row') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .sheet-title')!.textContent).toBe('A commitment');
    const storyText = doc.querySelector('.sheet .story')!.textContent!;
    expect(storyText).toContain('A scheduled job will do it');
    expect(storyText).toContain('Status unknown: later history isn’t loaded');
    expect(storyText).not.toMatch(/StatusOpen/);
    (doc.querySelector('.sheet-close') as HTMLButtonElement).click();

    // Older problems by the route's own `before`.
    (doc.querySelector('[data-show-older]') as HTMLButtonElement).click();
    await settle();
    expect(calls).toContain(`/failures?limit=10&before=${encodeURIComponent(oldest)}`);
    expect([...doc.querySelectorAll('#sec-problems .row-title')].map((n) => n.textContent)).toContain('Something that wasn’t hooked up: Hook not wired');

    // Revoke a binding: nothing is sent until the confirm, then bearer + intent header, no PIN.
    const tech = doc.querySelector('#sec-activity details.inside-tech') as HTMLDetailsElement;
    tech.open = true;
    const bindingRow = [...tech.querySelectorAll('.row')].find((r) => r.textContent!.includes('Design conversation')) as HTMLButtonElement;
    bindingRow.click();
    (doc.querySelector('.sheet [data-revoke]') as HTMLButtonElement).click();
    expect(writes).toEqual([]);
    expect(doc.querySelector('.sheet .confirm-text')!.textContent).toBe('Revoke Design conversation? Its future writes to this record will be refused.');
    (doc.querySelector('.sheet [data-revoke-confirm]') as HTMLButtonElement).click();
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toBe(`/shared-state/sessions/${sid}/revoke`);
    expect(writes[0].headers['X-Instar-Request']).toBe('1');
    expect(writes[0].headers.Authorization).toBe('Bearer t');
    expect(JSON.stringify(writes[0].headers)).not.toMatch(/pin/i);
    expect(doc.querySelector('.sheet .action-status')!.textContent).toBe('Revoked. Its future writes will be refused.');
    expect(doc.querySelector('.pin-input')).toBeNull();

    const { _resetInsideState } = await import('../../dashboard/console/inside.js');
    _resetInsideState();
  });
});

describe('agent names on activity rows', () => {
  it('a paired fingerprint reads as its name; an unpaired one as a short id; a failed pairing read names nobody', async () => {
    const m = await import('../../dashboard/console/inside-model.js');
    const fp = '8c7928aa9f04fbda947172a2f9b2d81a';
    const other = 'd5d07ce5f9b199abac3a90ea3c90d269';
    m.setPeerNames({ ok: true, data: { pairings: [{ peerFp: fp.toUpperCase(), peerName: 'Dawn' }, { peerFp: other, peerName: other }] } });
    expect(m.counterpartyWords({ type: 'agent', name: fp })).toBe('with Dawn');
    expect(m.counterpartyWords({ type: 'agent', name: other })).toBe('with an unnamed agent');
    expect(m.counterpartyWords({ type: 'agent', name: 'Scout' })).toBe('with Scout');
    m.setPeerNames({ ok: false, status: 503, data: {} });
    expect(m.counterpartyWords({ type: 'agent', name: fp })).toBe('with an unnamed agent');
  });
});
