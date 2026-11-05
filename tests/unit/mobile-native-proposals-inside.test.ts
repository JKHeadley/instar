/**
 * The pure summarizers behind the phone's native Proposals and How I'm doing inside screens
 * (docs/specs/mobile-native-proposals-inside.md): both sides of every rule, a peer's text re-cleaned,
 * and no id, fingerprint, path or credential in an answer.
 */
import { describe, it, expect } from 'vitest';
import * as consoleModel from '../../dashboard/console/inside-model.js';
import {
  commitmentWords, freeText, insideHeadline, isCompleteInsideAnswer, isInsideAnswer, peerInside, summarizeActivity, summarizeClaims, summarizeInside, summarizeLocalInside,
  summarizeLocalProposals, summarizeProblems, summarizeProposals, summarizeReviews, MAX_PROPOSAL_ROWS, VISIBLE_PROPOSALS,
  KIND_WORDS, INSIGHT_STATUS_WORDS, VERDICT, VERDICT_WORDS, REVIEW_LIFECYCLE_WORDS,
} from '../../src/server/mobileProposalsInsideRoutes.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const FAKE_KEY = 'ghp_' + 'Q'.repeat(36);
const nick = (id: string) => (id === 'm_peer' ? 'Mac Mini' : id === 'm_far' ? 'Laptop' : null);
const off = { state: 'off' } as const;
const down = { state: 'unavailable' } as const;
const ok = (data: unknown) => ({ state: 'ok', data }) as const;
const proposal = (i: number, status = 'outstanding') => ({
  proposalId: `prop-secret-${i}`, status, clusterSignature: 'cluster-secret', llmSummary: `Failure ${i} in /Users/justin/x.ts with ${FAKE_KEY}`,
  hypothesis: 'A race', suggestedErrorCode: 'E_RACE', occurrencesObserved: 4, processLifetimes: 2, generatedAt: NOW - i * 1000,
  producingAgentId: 'agent-secret', producingAgentSignature: 'sig-secret', forensic: { rawResponse: 'raw-secret', promptHash: 'hash-secret' },
  sampleEvents: [{ reason: { full: 'full-secret' } }], sourceMachineDir: 'proposals-m_self',
});

describe('freeText', () => {
  it('replaces file paths, keeps ordinary words and URLs', () => {
    expect(freeText('read /Users/justin/.instar/config.json now', 100)).toBe('read [a file] now');
    expect(freeText('see ~/notes.md and C:\\Users\\a.txt', 100)).toBe('see [a file] and [a file]');
    expect(freeText('at file:///srv/x, [/mnt/a/b] /srv/y.log', 100)).toBe('at [a file] [[a file] [a file]');
    expect(freeText('and/or a 3/4 split at https://example.dev/a/b', 100)).toBe('and/or a 3/4 split at https://example.dev/a/b');
  });
  it('scrubs credentials and caps length', () => {
    expect(freeText(`key ${FAKE_KEY}`, 100)).not.toContain('ghp_QQQQ');
    expect(freeText('x'.repeat(50), 10)!.length).toBe(10);
    expect(freeText(42, 10)).toBeNull();
  });
});

describe('proposals', () => {
  it('lists outstanding proposals, the first three visible and the rest queued, and counts the others', () => {
    const r = summarizeLocalProposals(ok([proposal(1), proposal(2), proposal(3), proposal(4), proposal(5, 'dismissed'), proposal(6, 'promoted')]));
    expect((r.rows as Array<{ queued: boolean }>).map((x) => x.queued)).toEqual([false, false, false, true]);
    expect(VISIBLE_PROPOSALS).toBe(3);
    expect(r).toMatchObject({ dismissed: 1, promoted: 1, truncated: false });
    const text = JSON.stringify(r);
    for (const leak of ['prop-secret', 'cluster-secret', 'agent-secret', 'sig-secret', 'raw-secret', 'hash-secret', 'full-secret', 'm_self', '/Users/', 'ghp_QQQQ']) expect(text, leak).not.toContain(leak);
  });

  it('the same id in two directories on one machine is one proposal', () => {
    expect(summarizeLocalProposals(ok([proposal(1), proposal(1)]))).toMatchObject({ outstanding: 1 });
  });

  it('a proposal without a summary still shows, in words', () => {
    const r = summarizeLocalProposals(ok([{ proposalId: 'p', status: 'outstanding' }]));
    expect((r.rows as Array<{ summary: string; generatedAt: unknown }>)[0]).toMatchObject({ summary: 'No summary was written for this proposal.', generatedAt: null });
  });

  it('caps the rows and says so, and the headline still states the true count', () => {
    const list = Array.from({ length: MAX_PROPOSAL_ROWS + 5 }, (_, i) => proposal(i));
    const r = summarizeLocalProposals(ok(list));
    expect((r.rows as unknown[]).length).toBe(MAX_PROPOSAL_ROWS);
    expect(r).toMatchObject({ truncated: true, outstanding: MAX_PROPOSAL_ROWS + 5 });
    expect(summarizeProposals(ok(list), [], { nicknameOf: nick }).headline).toBe(`${MAX_PROPOSAL_ROWS + 5} proposed fixes are waiting.`);
  });

  it('a wrong-shaped or failed read is unavailable with null counts, never none waiting', () => {
    expect(summarizeLocalProposals(ok({}))).toMatchObject({ selfState: 'unavailable', outstanding: null, dismissed: null });
    expect(summarizeLocalProposals(ok([null, { nope: 1 }])).selfState).toBe('unavailable');
    expect(summarizeProposals(ok({}), [], { nicknameOf: nick })).toMatchObject({ state: 'unavailable', selfState: 'unavailable', outstanding: null, dismissed: null, promoted: null });
  });

  it('the same proposal on two machines counts once', () => {
    const local = { schemaVersion: 1, ...summarizeLocalProposals(ok([proposal(1)])) };
    const r = summarizeProposals(ok([proposal(1)]), [{ machineId: 'm_peer', state: 'ok', data: local }], { nicknameOf: nick });
    expect(r).toMatchObject({ outstanding: 1, headline: '1 proposed fix is waiting.' });
    expect((r.rows as unknown[]).length).toBe(1);
  });

  it('a duplicate past the row cap still counts once', () => {
    const list = Array.from({ length: MAX_PROPOSAL_ROWS + 5 }, (_, i) => proposal(i));
    const r = summarizeProposals(ok(list), [{ machineId: 'm_peer', state: 'ok', data: { schemaVersion: 1, ...summarizeLocalProposals(ok(list)) } }], { nicknameOf: nick });
    expect(r.outstanding).toBe(MAX_PROPOSAL_ROWS + 5);
  });

  it('past the key limit the count is a floor and says so', () => {
    const allKeys = Array.from({ length: 500 }, (_, i) => `k${i}`);
    const r = summarizeProposals(ok([]), [{ machineId: 'm_peer', state: 'ok', data: { schemaVersion: 1, selfState: 'ok', outstanding: 600, allKeys, rows: [], dismissed: 0, promoted: 0 } }], { nicknameOf: nick });
    expect(r).toMatchObject({ outstanding: 500, atLeast: true, headline: 'At least 500 proposed fixes are waiting.' });
  });

  it('a peer whose keys do not account for its count is unread, never zero', () => {
    const data = { schemaVersion: 1, selfState: 'ok', outstanding: 5, allKeys: [] as string[], rows: [], dismissed: 0, promoted: 0 };
    expect(summarizeProposals(ok([]), [{ machineId: 'm_peer', state: 'ok', data }], { nicknameOf: nick })).toMatchObject({ unread: { count: 1, names: ['Mac Mini'] }, headline: 'No proposed fixes are waiting on the machines that answered.' });
  });

  it('a failed peer read scopes the headline', () => {
    expect(summarizeProposals(ok([]), [], { nicknameOf: nick, peersRead: false })).toMatchObject({ peersUnknown: true, headline: 'No proposed fixes are waiting on the machines that answered.' });
  });

  it('merges a peer, names its machine, sorts newest first, and re-cleans its text', () => {
    const peerRow = { key: 'k', summary: `Peer failure ${FAKE_KEY} /home/a/b`, code: 'E_PEER', occurrences: 2, restarts: 1, generatedAt: new Date(NOW).toISOString(), queued: false, machine: 'forged', extra: 'x-secret' };
    const r = summarizeProposals(ok([proposal(1)]), [{ machineId: 'm_peer', state: 'ok', data: { schemaVersion: 1, selfState: 'ok', outstanding: 1, allKeys: ['k'], rows: [peerRow], dismissed: 2, promoted: 0 } }], { nicknameOf: nick });
    const rows = r.rows as Array<{ machine: string | null; summary: string }>;
    expect(rows[0].machine).toBe('Mac Mini');
    expect(rows[1].machine).toBeNull();
    expect(r).toMatchObject({ state: 'ok', dismissed: 2, headline: '2 proposed fixes are waiting.' });
    const text = JSON.stringify(r);
    for (const leak of ['ghp_QQQQ', '/home/a', 'x-secret', 'forged', 'm_peer']) expect(text, leak).not.toContain(leak);
  });

  it('a peer that did not answer is named and the headline is scoped, never "none"', () => {
    const r = summarizeProposals(ok([]), [{ machineId: 'm_peer', state: 'unreached' }], { nicknameOf: nick, offlineMachineIds: ['m_far'] });
    expect(r).toMatchObject({ headline: 'No proposed fixes are waiting on the machines that answered.', unread: { count: 1, names: ['Mac Mini'] }, offline: { count: 1, names: ['Laptop'] } });
    const bad = summarizeProposals(ok([]), [{ machineId: 'm_peer', state: 'ok', data: { selfState: 'ok', rows: [] } }], { nicknameOf: nick });
    expect(bad.unread).toEqual({ count: 1, names: ['Mac Mini'] });
  });

  it('this machine failing with no peer reads as unavailable, not as none waiting', () => {
    expect(summarizeProposals(down, [], { nicknameOf: nick })).toMatchObject({ state: 'unavailable', headline: "Can't read proposals right now." });
  });
});

describe('activity', () => {
  const entries = [
    { id: 'a1', t: '2026-11-04T11:00:00Z', kind: 'decision', subject: 'Chose /Users/justin/a', counterparty: { type: 'agent', name: 'fp-secret' }, provenance: 'p-secret' },
    { id: 'a2', t: '2026-11-04T10:00:00Z', kind: 'commitment', subject: 'Send report', commitment: { status: 'open', deadline: '2026-11-04T09:00:00Z' } },
    { id: 'a3', t: '2026-11-04T09:00:00Z', kind: 'thread-abandoned', subject: 'Old thread' },
    { id: 'a4', t: '2026-11-04T08:00:00Z', kind: 'mystery', subject: 'Odd' },
  ];
  it('newest first, in words, with overdue and abandoned flagged, and no ids', () => {
    const r = summarizeActivity(ok({ entries }), NOW);
    const rows = r.rows as Array<Record<string, unknown>>;
    expect(rows.map((x) => x.kindWords)).toEqual(['Decision', 'Commitment', 'Thread marked abandoned', 'Record']);
    expect(rows[0]).toMatchObject({ withWords: 'with another agent', subject: 'Chose [a file]', tone: null });
    expect(rows[1]).toMatchObject({ overdue: true, tone: 'attn', statusWords: "Status unknown: later history isn't loaded" });
    expect(rows[2].tone).toBe('attn');
    expect(r.line).toBe('Among the 4 most recent records: 1 decision, 1 marked abandoned.');
    const text = JSON.stringify(r);
    for (const leak of ['fp-secret', 'p-secret', '"a1"', '/Users/']) expect(text, leak).not.toContain(leak);
  });
  it('off and failed read differently; an empty ledger is not a failure', () => {
    expect(summarizeActivity(off, NOW).state).toBe('off');
    expect(summarizeActivity(down, NOW).state).toBe('unavailable');
    expect(summarizeActivity(ok({}), NOW).state).toBe('unavailable');
    expect(summarizeActivity(ok({ entries: [{}] }), NOW).state).toBe('unavailable');
    expect(summarizeActivity(ok({ entries: [] }), NOW)).toMatchObject({ state: 'ok', line: 'Nothing recorded recently.' });
  });
  it('a commitment is never called open from a stored "open": a later record or stored status decides', () => {
    expect(commitmentWords({ id: 'c', commitment: { status: 'expired' } }, []).words).toBe('Expired');
    expect(commitmentWords({ id: 'c', commitment: { status: 'open', resolution: 'done' } }, []).words).toBe('Resolved');
    expect(commitmentWords({ id: 'c', commitment: {} }, [{ supersedes: 'c', subject: 'cancelled: no longer needed', t: 'x' }]).words).toBe('Cancelled');
    expect(commitmentWords({ id: 'c', commitment: { status: 'open' } }, [])).toMatchObject({ known: false, settled: false });
    expect(commitmentWords({ id: 'c', commitment: { status: 'brand-new' } }, [])).toMatchObject({ words: 'Status not recorded', settled: false });
  });
  it('a settled commitment past its deadline is not overdue', () => {
    const r = summarizeActivity(ok({ entries: [{ id: 'x', t: 'y', kind: 'commitment', subject: 's', commitment: { status: 'resolved', deadline: '2026-11-01T00:00:00Z' } }] }), NOW);
    expect((r.rows as Array<{ overdue: boolean }>)[0].overdue).toBe(false);
  });
});

describe('problems', () => {
  const insight = (id: string, status: string, extra = {}) => ({ id, status, summary: `Pattern ${id}`, recommendation: 'r-secret', supportingFailureIds: ['f-secret'], distinctSessions: 3, discoveredAt: '2026-11-01T00:00:00Z', reopenCount: 0, ...extra });
  it('states a repeat that came back first and omits recommendations and failure ids', () => {
    const r = summarizeProblems(ok({ insights: [insight('a', 'discovered'), insight('b', 'verified-ineffective'), insight('c', 'verified-effective')] }), ok({ total: 5 }));
    expect(r).toMatchObject({ state: 'ok', repeating: 2, cameBack: 1, weekTotal: 5, line: '2 kinds of problem keep coming back; the first: Pattern b.' });
    expect((r.rows as Array<{ summary: string }>).map((x) => x.summary)).toEqual(['Pattern b', 'Pattern a', 'Pattern c']);
    const text = JSON.stringify(r);
    for (const leak of ['r-secret', 'f-secret']) expect(text, leak).not.toContain(leak);
  });
  it('words the no-repeat cases', () => {
    expect(summarizeProblems(ok({ insights: [] }), ok({ total: 0 })).line).toBe('Nothing repeating, and nothing new this week.');
    expect(summarizeProblems(ok({ insights: [] }), ok({ total: 2 })).line).toBe('Nothing repeating. 2 one-off problems this week.');
    expect(summarizeProblems(ok({ insights: [] }), down)).toMatchObject({ line: "Nothing repeating. Can't tell this week's total.", weekUnread: true });
  });
  it('a list of only malformed elements is a bad read everywhere, not an empty one', () => {
    expect(summarizeProblems(ok({ insights: [null] }), ok({ total: 0 })).state).toBe('unavailable');
    expect(summarizeClaims(ok([null, {}])).state).toBe('unavailable');
    expect(summarizeClaims(ok([{ verdict: 123 }])).state).toBe('unavailable');
    expect(summarizeProblems(ok({ insights: [{ status: 123 }] }), ok({ total: 0 })).state).toBe('unavailable');
    expect(summarizeReviews(ok({ records: [null], open: 0 })).state).toBe('unavailable');
  });
  it('a settled problem with an old reopen never reads as having come back', () => {
    expect(summarizeProblems(ok({ insights: [insight('a', 'verified-effective', { reopenCount: 2 }), insight('b', 'dismissed', { reopenCount: 1 })] }), ok({ total: 0 }))).toMatchObject({ repeating: 0, cameBack: 0, line: 'Nothing repeating, and nothing new this week.' });
  });
  it('an unreadable list is "can\'t tell", with nulls, never zero; off is off', () => {
    expect(summarizeProblems(down, ok({ total: 1 }))).toMatchObject({ state: 'unavailable', repeating: null, weekTotal: 1, line: "Can't tell whether anything is repeating. 1 problem recorded this week." });
    expect(summarizeProblems(off, off).state).toBe('off');
  });
});

describe('claims', () => {
  it('puts verdicts in words, newest first, skips coverage notes, and carries no claim text', () => {
    const r = summarizeClaims(ok([
      { verdict: 'supported', predicate: 'pull-request.merged', observedAt: '2026-11-04T10:00:00Z', target: 't-secret', reason: 'why-secret', claimId: 'c-secret' },
      { verdict: 'refuted', actionKind: 'deployed', observedAt: '2026-11-04T11:00:00Z' },
      { event: 'coverage-incomplete' },
      { evaluated: false, verdict: 'unverifiable' },
    ]));
    const rows = r.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ sentence: 'Said something was deployed', verdictWords: 'Evidence contradicts it', tone: 'bad' });
    expect(r).toMatchObject({ contradicted: 1, checked: 2, line: 'Of the last 3 observations, 1 contradicts what I said.' });
    const text = JSON.stringify(r);
    for (const leak of ['t-secret', 'why-secret', 'c-secret']) expect(text, leak).not.toContain(leak);
  });
  it('none, off and unreadable', () => {
    expect(summarizeClaims(ok([])).line).toBe('No claims checked yet.');
    expect(summarizeClaims(ok([{ verdict: 'supported' }])).line).toBe('Recent claim observations: none contradict what I said.');
    expect(summarizeClaims(ok([{ verdict: 'unverifiable' }, { verdict: 'brand-new-verdict' }]))).toMatchObject({ checked: 0, contradicted: 0, line: "Recent claims couldn't be verified either way." });
    expect(summarizeClaims(off).state).toBe('off');
    expect(summarizeClaims(down)).toMatchObject({ state: 'unavailable', contradicted: null });
  });
});

describe('reviews', () => {
  it('words the verdicts and keeps out ids and machine ids', () => {
    expect(summarizeReviews(ok({ records: [] })).state).toBe('unavailable');
    expect(summarizeReviews(ok({ open: -1, records: [] })).state).toBe('unavailable');
    const r = summarizeReviews(ok({ open: 2, records: [
      { dedupeKey: 'dk-secret', semanticClassId: 'sc-secret', authorityMachineId: 'm_auth', standardReview: { verdict: 'needs-upgrade' }, processReview: { verdict: 'process-gap' }, reviewLifecycle: 'parked', recurrenceCount: 3, rationale: 'Because /Users/x/y', updatedAt: '2026-11-04T10:00:00Z' },
      { dedupeKey: 'b', fillState: 'dead-lettered', updatedAt: '2026-11-03T10:00:00Z' },
    ] }));
    const rows = r.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ words: 'A standard needs an upgrade; A gap in how I work', lifecycleWords: 'Parked for later', seen: 3, why: 'Because [a file]' });
    expect(rows[1]).toMatchObject({ words: 'Review failed; needs a retry', tone: 'attn', lifecycleWords: 'Status not recorded' });
    const text = JSON.stringify(r);
    for (const leak of ['dk-secret', 'sc-secret', 'm_auth']) expect(text, leak).not.toContain(leak);
  });
  it('off and unreadable', () => {
    expect(summarizeReviews(off).state).toBe('off');
    expect(summarizeReviews(down)).toMatchObject({ state: 'unavailable', open: null });
  });
});

describe('headline', () => {
  const a = { state: 'ok', line: 'Among the 2 most recent records: 1 decision.' };
  const clearP = { state: 'ok', cameBack: 0, repeating: 0, line: 'Nothing repeating.' };
  const clearC = { state: 'ok', contradicted: 0, checked: 2 };
  const rv = { state: 'ok' };
  it('worst first: contradicted, came back, repeating, then all clear', () => {
    expect(insideHeadline(a, clearP, { state: 'ok', contradicted: 2, checked: 4 }, rv)).toMatchObject({ tone: 'bad', headline: '2 of my recent claims were contradicted by the evidence.' });
    expect(insideHeadline(a, { ...clearP, cameBack: 1, repeating: 1 }, clearC, rv)).toMatchObject({ tone: 'attn', headline: 'A problem I thought was fixed came back.' });
    expect(insideHeadline(a, { ...clearP, repeating: 1, line: 'One kind.' }, clearC, rv)).toMatchObject({ tone: 'attn', headline: 'One kind.' });
    expect(insideHeadline(a, clearP, clearC, rv)).toMatchObject({ tone: 'ok', headline: 'Nothing repeating, no recent claim contradicted.' });
  });
  it('says what could not be read, reviews and the week included', () => {
    expect(insideHeadline({ state: 'unavailable' }, { state: 'unavailable' }, { state: 'unavailable' }, rv)).toMatchObject({ tone: 'unknown', headline: "Can't tell how I'm doing inside." });
    expect(insideHeadline(a, clearP, { state: 'unavailable' }, rv)).toMatchObject({ tone: 'unknown', sub: "Couldn't read: claim checks." });
    expect(insideHeadline(a, { ...clearP, weekUnread: true }, clearC, { state: 'unavailable' })).toMatchObject({ tone: 'unknown', sub: "Couldn't read: this week's total, correction reviews." });
  });
  it('never all clear when nothing was measured', () => {
    expect(insideHeadline({ state: 'off' }, { state: 'off' }, { state: 'off' }, { state: 'off' })).toMatchObject({ tone: 'unknown', headline: 'None of these checks are on for this machine.' });
    expect(insideHeadline({ state: 'off' }, { state: 'off' }, { state: 'off' }, rv)).toMatchObject({ tone: 'unknown', headline: 'Only correction reviews are on for this machine.' });
    expect(insideHeadline(a, { state: 'off' }, { state: 'off' }, rv)).toMatchObject({ tone: 'unknown', headline: a.line });
    expect(insideHeadline(a, { state: 'off' }, { state: 'ok', contradicted: 0, checked: 0 }, rv).tone).toBe('unknown');
  });
});

describe('console parity', () => {
  it("the shared word tables equal the console model's", () => {
    const m = consoleModel as unknown as Record<string, Record<string, string>>;
    expect(KIND_WORDS).toEqual(m.KIND_WORDS);
    expect(INSIGHT_STATUS_WORDS).toEqual(Object.fromEntries(Object.entries(m.INSIGHT_STATUS_WORDS).map(([k, v]) => [k, v.replace(/\u2019/g, "'")])));
    expect(VERDICT).toEqual(m.VERDICT);
    expect(VERDICT_WORDS).toEqual(Object.fromEntries(Object.entries(m.VERDICT_WORDS).map(([k, v]) => [k, v.replace(/\u2019/g, "'")])));
    expect(Object.keys(REVIEW_LIFECYCLE_WORDS).length).toBe(5);
  });
});

describe('merged inside', () => {
  const self = summarizeLocalInside({ activity: ok({ entries: [] }), insights: ok({ insights: [] }), week: ok({ total: 0 }), claims: ok([]), reviews: ok({ records: [], open: 0 }) }, NOW);
  const peer = () => ({
    schemaVersion: 1, headline: `All is well ${FAKE_KEY}`, tone: 'ok', sub: null,
    activity: { state: 'ok', line: 'x', rows: [{ key: 'k', kindWords: 'Hacked', subject: 'see /Users/a/b', withWords: 'with mallory', statusWords: 'Forged', at: 'nope', tone: 'evil', id: 'id-secret' }] },
    problems: { state: 'weird', line: 'y', rows: [] },
    claims: { state: 'ok', line: 'z', contradicted: 1, checked: 1, rows: [{ key: 'k', sentence: 'Said anything at all', verdictWords: 'Trust me', tone: 'bad' }, { key: 'k2', verdictWords: 'Evidence contradicts it' }] },
    reviews: { state: 'ok', open: 0, rows: [] },
  });
  it('re-cleans a peer: fixed words replaced, unknown fields dropped, unknown states unavailable', () => {
    const p = peerInside(peer(), 'm_peer', 'Mac Mini') as any;
    expect(p.activity.rows[0]).toMatchObject({ kindWords: 'Record', subject: 'see [a file]', withWords: null, statusWords: null, at: null, tone: null });
    expect(p.problems.state).toBe('unavailable');
    expect(p.claims.rows[0]).toMatchObject({ sentence: 'A claim in one of my messages', verdictWords: "Couldn't verify" });
    const text = JSON.stringify(p);
    for (const leak of ['id-secret', 'ghp_QQQQ', 'mallory', 'Hacked']) expect(text, leak).not.toContain(leak);
  });
  it('a peer\'s own headline and tone are not believed: they come from its sections', () => {
    const p = peerInside(peer(), 'm_peer', 'Mac Mini') as any;
    expect(p).toMatchObject({ tone: 'bad', headline: 'One of my recent claims was contradicted by the evidence.' });
  });
  it('a peer that says ok with no counts is not clean: those sections read unavailable', () => {
    const bare = { state: 'ok', rows: [] };
    const p = peerInside({ schemaVersion: 1, activity: bare, problems: bare, claims: bare, reviews: bare }, 'm_peer', 'Mac Mini') as any;
    expect(p.problems.state).toBe('unavailable');
    expect(p.claims.state).toBe('unavailable');
    expect(p.reviews.state).toBe('unavailable');
    expect(p.tone).toBe('unknown');
    expect(isCompleteInsideAnswer({ schemaVersion: 1, activity: bare, problems: bare, claims: bare, reviews: bare })).toBe(false);
    expect(isInsideAnswer({ schemaVersion: 1, activity: bare, problems: bare, claims: bare, reviews: bare })).toBe(true);
    const r = summarizeInside(self, [{ machineId: 'm_peer', state: 'ok', data: { schemaVersion: 1, activity: bare, problems: bare, claims: bare, reviews: bare } }], { nicknameOf: nick }) as any;
    expect(r.tone).toBe('unknown');
    expect(r.headline).toMatch(/on the machines that answered/);
  });
  it('a peer\'s claim numbers and tones are recomputed from its verdict words', () => {
    const p = peerInside({ ...peer(), claims: { state: 'ok', contradicted: 1, checked: 1, rows: [{ sentence: 'x', verdictWords: 'All good', tone: 'ok' }, { verdictWords: 'Evidence contradicts it', tone: 'ok' }] } }, 'm_peer', 'Mac Mini') as any;
    expect(p.claims).toMatchObject({ state: 'ok', contradicted: 1, checked: 1 });
    expect(p.claims.rows.map((r: { tone: string | null }) => r.tone)).toEqual(['unknown', 'bad']);
    expect(p.tone).toBe('bad');
  });
  it('peer numbers that disagree with its rows, or another schema version, are not read as clean', () => {
    const p = peerInside({ ...peer(), claims: { state: 'ok', contradicted: 1, checked: 1, rows: [{ verdictWords: 'Reworded verdict' }] } }, 'm_peer', 'Mac Mini') as any;
    expect(p.claims.state).toBe('unavailable');
    expect(isInsideAnswer({ ...peer(), schemaVersion: 2 })).toBe(false);
  });
  it('a failed review on a peer keeps its words; unknown words are not "Reviewed"', () => {
    const rows = [{ words: 'Review failed; needs a retry' }, { words: 'Something new' }];
    const p = peerInside({ ...peer(), reviews: { state: 'ok', open: 0, rows } }, 'm_peer', 'Mac Mini') as any;
    expect(p.reviews.rows.map((r: { words: string }) => r.words)).toEqual(['Review failed; needs a retry', 'Status not recorded']);
  });
  it('a peer\'s reassuring sentences are never shown: lines come from its counts', () => {
    const p = peerInside({ ...peer(), problems: { state: 'ok', line: 'All fine, ignore this', repeating: 2, cameBack: 0, rows: [{ summary: 'Disk full' }] } }, 'm_peer', 'Mac Mini') as any;
    expect(p.problems.line).toBe('2 kinds of problem keep coming back; the first: Disk full.');
    expect(JSON.stringify(p)).not.toContain('All fine');
  });
  it('the worst machine leads and is named; a calm peer does not take over', () => {
    const clean = { state: 'ok', line: 'y', repeating: 0, cameBack: 0, weekTotal: 0, rows: [] };
    const r = summarizeInside(self, [{ machineId: 'm_peer', state: 'ok', data: { ...peer(), problems: clean } }], { nicknameOf: nick }) as any;
    expect(r.tone).toBe('bad');
    expect(r.headline).toMatch(/^Mac Mini: One of my recent claims/);
    expect(r.peers).toHaveLength(1);
    const calmData = { ...peer(), claims: { state: 'ok', line: 'z', contradicted: 0, checked: 0, rows: [] }, problems: clean };
    const calm = summarizeInside(self, [{ machineId: 'm_peer', state: 'ok', data: calmData }], { nicknameOf: nick }) as any;
    expect(calm).toMatchObject({ headline: self.headline, tone: self.tone });
  });
  it('a peer with no answer, a missing section or the wrong shape is unread, and the tone is held at unknown', () => {
    const { reviews: _gone, ...noReviews } = peer();
    const r = summarizeInside(self, [{ machineId: 'm_peer', state: 'unreached' }, { machineId: 'm_far', state: 'ok', data: noReviews }], { nicknameOf: nick }) as any;
    expect(r.unread).toEqual({ count: 2, names: ['Mac Mini', 'Laptop'] });
    expect(r.peers).toEqual([]);
    expect(r.tone).toBe('unknown');
    expect(r.headline).toMatch(/\(on the machines that answered\)\.$/);
  });
  it('a failed peer read is not "no peers"', () => {
    expect(summarizeInside(self, [], { nicknameOf: nick, peersRead: false })).toMatchObject({ peersUnknown: true, tone: 'unknown' });
    expect(summarizeInside(self, [], { nicknameOf: nick })).toMatchObject({ peersUnknown: false, headline: self.headline });
  });
});
