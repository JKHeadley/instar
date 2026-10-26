/**
 * Console "What thinking costs" page (docs/specs/console-features/capacity.md:
 * Spend + Tokens + LLM activity + Routing map): every decision in the model on both
 * sides — cost-basis words, unpriced tokens, committed limits kept apart from the
 * reporting rows, Claude vs Codex never summed, the time control, check rows with
 * no dollars, 503 vs failure — and the shipped page in jsdom.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildCostsPage, buildRecordedCost, buildLimits, buildChecks, buildConversations, buildRouting, insightLine, costRow, checkRow, claudeRow, codexRow,
  windowParams, spendQuery, basisWord, routeStatusWord, committedLine, fmtTokens, fmtUsd, modelWord, doorWord, checkWord, WINDOWS, GRAINS,
} from '../../dashboard/console/costs-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-25T23:30:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const OFF = { ok: false, reason: 'switched off on this agent' };
const FAIL = { ok: false, reason: 'the server answered 500' };
const hoursAgo = (h: number) => NOW - h * 3600000;

const spendRow = (over: Record<string, unknown> = {}) => ({ door: 'openrouter', modelId: 'gpt-6-luna', doorClass: 'metered', tokensIn: 30000, tokensOut: 11000, tokensCached: 0, grossUsd: 4.2, subsidyUsd: 0, creditUsd: 0, netUsd: 4.2, committedUsd: 0,
  priceBasis: 'canonical', costBasis: 'internal-derived', providerReportedUsd: null, providerDriftPct: null, amortizedSubscriptionUsd: null, amortizationDerivation: null, priceStale: false, notLiveYet: true, unpricedTokensIn: 0, unpricedTokensOut: 0, ...over });
const spend = (rows: unknown[], totalsOver: Record<string, unknown> = {}) => ok({ grain: 'day', rows, totals: { tokensIn: 30000, tokensOut: 11000, tokensCached: 0, grossUsd: 4.2, subsidyUsd: 0, creditUsd: 0, netUsd: 4.2, committedUsd: 0, unpricedTokensIn: 0, unpricedTokensOut: 0, ...totalsOver },
  reportingBasis: { source: 'feature_metrics (best-effort token observability)', lastReconcileAt: null, rollupMaintained: true, note: '' }, horizonNote: 'h', meteredLiveYet: false });
const cap = (over: Record<string, unknown> = {}) => ({ keyRef: 'metered_openrouter_bench', provider: 'openrouter', door: 'openrouter', lifetimeCapUsd: 60, dailyCapUsd: 25, frozen: false, committedLifetimeUsd: 0, committedDayUsd: 0, pctLifetime: 0, pctDaily: 0, goLiveState: 'not-live', meteredLeaseHolder: null, coverageOk: true, ...over });
const feat = (over: Record<string, unknown> = {}) => ({ feature: 'MessagingToneGate', calls: 500, realCalls: 410, llmCalls: 410, realLlmCalls: 410, events: 0, tokensIn: 200000, tokensOut: 20000, tokensCached: 0, frameworks: ['codex-cli'], models: ['gpt-6-luna'], fired: 40, noop: 360, unclassified: 8, errors: 2, llmErrors: 2, shed: 90,
  fireRate: 0.1, fireRateInsufficientEvidence: false, errorRate: 0.005, avgLatencyMs: 900, p50LatencyMs: 800, p95LatencyMs: 3000, maxLatencyMs: 5000, waitedCalls: 0, avgWaitMs: 0, byModel: [{ feature: 'MessagingToneGate', model: 'gpt-6-luna', framework: 'codex-cli', calls: 500, realCalls: 410, tokensIn: 200000, tokensOut: 20000, tokensCached: 0, fired: 40, noop: 360, unclassified: 8, errors: 2, shed: 90 }], ...over });
const metrics = (features: unknown[], totalsOver: Record<string, unknown> = {}) => ok({ sinceMs: 0, features, totals: { calls: 500, realCalls: 410, llmCalls: 410, events: 0, tokensIn: 200000, tokensOut: 20000, tokensCached: 0, fired: 40, noop: 360, unclassified: 8, errors: 2, shed: 90, byModel: [{ model: 'gpt-6-luna', framework: 'codex-cli', calls: 460, realCalls: 380 }, { model: 'claude-opus-5-5', framework: 'claude-code', calls: 30, realCalls: 30 }], usageCoverage: [], unlabeledTokenShare: 0, unlabeledCallShare: 0, ...totalsOver } });
const tokens = (over: Record<string, unknown> = {}) => ok({ sinceMs: 0, summary: { totalTokens: 8200000, totalInput: 1, totalOutput: 1, totalCacheRead: 1, totalCacheCreate: 1, eventCount: 900, sessionsActive: 11, oldestEventTs: hoursAgo(100), newestEventTs: hoursAgo(1) }, codex: { totalTokens: 900000, totalInput: 1, totalCachedInput: 1, totalOutput: 1, totalReasoning: 1, sessionCount: 3, oldestTs: hoursAgo(300), newestTs: hoursAgo(2), maxPrimaryUsedPercent: 20, maxSecondaryUsedPercent: 30 }, ...over });
const chains = ok({ defaultFramework: 'claude-code', doors: { cli: [], metered: [] }, chains: [
  { chain: 'FAST', positions: [{ door: 'codex-cli', doorClass: 'cli', label: 'luna', modelId: 'gpt-6-luna', injectionSafe: true, moneyGated: false, claudeBanned: false, skippedInIncrementA: false }, { door: 'openrouter', doorClass: 'metered', label: 'x', modelId: 'qwen-3', injectionSafe: true, moneyGated: true, claudeBanned: false, skippedInIncrementA: true }, { door: 'claude-code', doorClass: 'cli', label: 'haiku', modelId: 'claude-haiku-4-5', injectionSafe: true, moneyGated: false, claudeBanned: false, skippedInIncrementA: false }] },
  { chain: 'JUDGE', positions: [{ door: 'claude-code', doorClass: 'cli', label: 'opus', modelId: 'claude-opus-5-5', injectionSafe: true, moneyGated: false, claudeBanned: false, skippedInIncrementA: false }] },
], components: [{ component: 'MessagingToneGate', category: 'gate', nature: 'A', chain: 'JUDGE', criticalGate: true, untrustedInput: true, enforcedFramework: 'codex-cli', route: [] }], injectionExposureSource: 'untrusted-input-flag', note: '' });
const full = (over: Record<string, unknown> = {}) => ({ spend: spend([spendRow()]), caps: ok({ keys: [cap()], meteredLiveYet: false }), status: ok({ lifecycleState: 'disabled', enforcementReady: false, enableSources: { state: 'disabled' }, machineNickname: 'Mac Studio', anyKeyFrozen: false }),
  metrics: metrics([feat()]), insights: { ok: false, reason: 'switched off on this agent' }, tokens: tokens(), claude: ok({ sessions: [{ sessionId: 's1', projectPath: '/Users/x/.instar/agents/echo', totalTokens: 2300000, eventCount: 10, firstTs: hoursAgo(5), lastTs: hoursAgo(1) }] }),
  codex: ok({ sessions: [{ sessionId: 'c1', projectPath: '/Users/x/proj', model: 'gpt-6-astra', totalTokens: 600000, firstTs: hoursAgo(400), lastTs: hoursAgo(2) }] }), orphans: ok({ idleMs: 1800000, orphans: [] }), chains, names: {}, ...over });

describe('words and the time control', () => {
  it('formats tokens and dollars without inventing precision', () => {
    expect([fmtTokens(0), fmtTokens(1240), fmtTokens(41000), fmtTokens(8200000), fmtTokens(12000000)]).toEqual(['0', '1,240', '41k', '8.2M', '12M']);
    expect([fmtUsd(0), fmtUsd(0.004), fmtUsd(4.2), fmtUsd(0.01)]).toEqual(['$0', 'under $0.01', '$4.20', '$0.01']);
    expect(modelWord('claude-opus-4-8-20260115')).toBe('Claude Opus 4.8');
    expect(modelWord('gpt-6-luna')).toBe('GPT-6 Luna');
    expect(doorWord('codex-cli')).toBe('Codex');
    expect(checkWord('MessagingToneGate')).toBe('Message tone check');
    expect(checkWord('someNewSentinel')).toBe('Some new sentinel');
  });

  it('one time control drives every window: tokens get since=, ledgers get sinceHours=', () => {
    const w = windowParams('week', NOW);
    expect(w).toMatchObject({ key: 'week', sinceHours: 168, sinceMs: NOW - 168 * 3600000, phrase: 'this week' });
    expect(windowParams('nonsense', NOW).key).toBe('week');
    expect(Object.keys(WINDOWS)).toEqual(['today', 'week', 'month']);
    expect(spendQuery('day', 168)).toBe('grain=day&sinceHours=168');
    expect(spendQuery('hour', 168)).toBe('grain=hour&sinceHours=24');
    expect(spendQuery('month', 168)).toBe('grain=month');   // the route ignores sinceHours for month/total
    expect(spendQuery('total', 168)).toBe('grain=total');
    expect(GRAINS.map((g) => g.key)).toEqual(['day', 'hour', 'month', 'total']);
  });
});

describe('recorded cost — basis labels and unpriced tokens', () => {
  it('keeps the server’s cost basis as a word, never invents one', () => {
    expect(basisWord({ costBasis: 'internal-derived' })).toBe('estimated');
    expect(basisWord({ costBasis: 'provider-reported' })).toBe('provider-reported');
    expect(basisWord({ costBasis: 'subscription-zero' })).toBe('subscription');
    expect(basisWord({ costBasis: 'unpriced' })).toBe('unpriced');
    expect(basisWord({})).toBe('basis not stated');
  });

  it('an unpriced row has no dollar figure; a priced row carries its basis and stale flag', () => {
    const u = costRow(spendRow({ costBasis: 'unpriced', priceBasis: 'no-matching-point', netUsd: 0, grossUsd: 0, unpricedTokensIn: 30000, unpricedTokensOut: 11000 }));
    expect(u.end).toBe('unpriced');
    expect(u.usd).toBeNull();
    expect(u.tone).toBe('unknown');
    const p = costRow(spendRow({ priceStale: true }));
    expect(p.end).toBe('$4.20');
    expect(p.sub).toBe('estimated · 41k tokens · price may be out of date · route not open yet');
    const prov = costRow(spendRow({ costBasis: 'provider-reported', providerReportedUsd: 4.5 }));
    expect(prov.end).toBe('$4.50'); // provider-reported replaces the estimate, as the server's basis says
    expect(costRow(spendRow({ door: 'claude-code', doorClass: 'cli', costBasis: 'subscription-zero', netUsd: 0, grossUsd: 0 })).end).toBe('$0');
  });

  it('totals: $0 with unpriced tokens is said as unpriced, never as covered; dollars name their basis and door', () => {
    const zero = buildRecordedCost(spend([spendRow({ costBasis: 'unpriced', netUsd: 0, unpricedTokensIn: 30000, unpricedTokensOut: 11000 })], { netUsd: 0, grossUsd: 0, unpricedTokensIn: 30000, unpricedTokensOut: 11000 }));
    expect(zero.costWords).toBe('No pay-per-use cost');
    expect(zero.howWords).toBeNull();
    expect(zero.unpricedTokens).toBe(41000);
    expect(JSON.stringify(zero)).not.toMatch(/covered/i);
    const paid = buildRecordedCost(spend([spendRow()]));
    expect(paid.costWords).toBe('About $4.20 of pay-per-use cost');
    expect(paid.howWords).toBe('Estimated from token counts and a price list, all on OpenRouter.');
    expect(paid.bases).toEqual(['estimated']);
    const mixed = buildRecordedCost(spend([spendRow(), spendRow({ door: 'groq', modelId: 'llama-4', costBasis: 'provider-reported', providerReportedUsd: 1, netUsd: 1 })], { netUsd: 5.2 }));
    expect(mixed.costWords).toBe('About $5.20 of pay-per-use cost');
    expect(mixed.howWords).toBe('Estimated from token counts and a price list and reported by the provider.');
    // Subscription tokens are counted apart from unpriced ones: the ledger reports them as $0 with no unpriced tokens.
    const sub = buildRecordedCost(spend([spendRow({ door: 'claude-code', doorClass: 'cli', costBasis: 'subscription-zero', netUsd: 0, grossUsd: 0, tokensIn: 300000000, tokensOut: 34000000 })], { netUsd: 0, grossUsd: 0 }));
    expect(sub.subscriptionTokens).toBe(334000000);
    expect(sub.unpricedTokens).toBe(0);
  });

  it('tells switched-off from failed from a malformed answer', () => {
    expect(buildRecordedCost(OFF)).toMatchObject({ state: 'off' });
    expect(buildRecordedCost(OFF).reason).toContain('Turning limits on does not change that');
    expect(buildRecordedCost(FAIL)).toMatchObject({ state: 'failed' });
    expect(buildRecordedCost(FAIL).reason).toContain('the server answered 500');
    expect(buildRecordedCost(ok({ rows: [] }))).toMatchObject({ state: 'failed' });
  });
});

describe('committed limits are shown apart from the reporting figure', () => {
  it('status words: Frozen wins; Open / Closed / Not open', () => {
    expect(routeStatusWord(cap())).toBe('Not open');
    expect(routeStatusWord(cap({ goLiveState: 'live' }))).toBe('Open');
    expect(routeStatusWord(cap({ goLiveState: 'disarmed' }))).toBe('Closed');
    expect(routeStatusWord(cap({ goLiveState: 'live', frozen: true }))).toBe('Frozen');
    expect(committedLine(cap({ goLiveState: 'live', committedDayUsd: 3, committedLifetimeUsd: 40 }))).toBe('$3.00 of $25.00 today · $40.00 of $60.00 total (committed)');
  });

  it('caps rows carry the committed figure, not the reporting net; the switch is read separately', () => {
    const L = buildLimits(ok({ keys: [cap({ goLiveState: 'live', committedDayUsd: 3, committedLifetimeUsd: 40 }), cap({ keyRef: 'metered_groq_bench', provider: 'groq', door: 'groq', frozen: true })] }), ok({ lifecycleState: 'probed', enforcementReady: true, enableSources: { state: 'operator-enabled' }, machineNickname: 'Mac Studio', anyKeyFrozen: true }));
    expect(L.caps.rows.map((r) => [r.main, r.word])).toEqual([['OpenRouter · OpenRouter', 'Open'], ['Groq · Groq', 'Frozen']]);
    expect(L.caps.rows[0].sub).toContain('(committed)');
    expect(L.routesSentence).toBe('1 paid route is open; 1 frozen.');
    expect(L.controls.sentence).toBe('Limits are on and enforcing; a paid route is frozen (held by Mac Studio).');
    expect(L.controls.word).toBe('a route frozen');
  });

  it('switch states in words: off, waiting for a restart, failing; and each source failing on its own', () => {
    expect(buildLimits(ok({ keys: [] }), ok({ lifecycleState: 'disabled', enforcementReady: false })).controls.sentence).toBe('Spending limits are off.');
    expect(buildLimits(ok({ keys: [] }), ok({ lifecycleState: 'enable-pending-restart', enforcementReady: false })).controls.word).toBe('waiting');
    expect(buildLimits(ok({ keys: [] }), ok({ lifecycleState: 'probe-failed', enforcementReady: false, failingComponent: 'ledger' })).controls.sentence).toBe('Limits are turned on but not enforcing (probe failed: ledger).');
    expect(buildLimits(ok({ keys: [] }), ok({ lifecycleState: 'probed', enforcementReady: true, enableSources: { state: 'config-enabled' } })).controls.configEnabled).toBe(true);
    const offBoth = buildLimits(OFF, OFF);
    expect(offBoth.caps.state).toBe('off');
    expect(offBoth.controls).toMatchObject({ state: 'off', word: 'off' });
    expect(offBoth.routesSentence).toBeNull();
    const failed = buildLimits(FAIL, FAIL);
    expect(failed.caps.state).toBe('failed');
    expect(failed.controls).toMatchObject({ state: 'failed', word: 'Can’t tell' });
    expect(buildLimits(ok({ keys: [] }), ok({})).routesSentence).toBe('No paid route is set up.');
    expect(buildLimits(ok({ keys: [cap()] }), ok({})).routesSentence).toBe('No paid route is open.');
  });
});

describe('background checks — calls and tokens, never dollars', () => {
  it('a check row has calls, acted, skipped, failed, tokens and model — and no dollar sign', () => {
    const r = checkRow(feat());
    expect(r.main).toBe('Message tone check');
    expect(r.sub).toBe('410 calls · 40 acted · 90 skipped · 2 failed · on GPT-6 Luna');
    expect(r.end).toBe('220k tokens');
    expect(r.tone).toBe('bad');
    expect(r.segments).toEqual([['acted', 40], ['quiet', 360], ['other', 8], ['skipped', 90], ['failed', 2]]);
    expect(r.byModel[0]).toMatchObject({ model: 'GPT-6 Luna', framework: 'Codex', calls: 410, tokens: 220000 });
    expect(JSON.stringify(r)).not.toContain('$');
    expect(checkRow(feat({ errors: 0, llmErrors: 0, shed: 300, calls: 500 })).tone).toBe('unknown'); // mostly skipped
    expect(checkRow(feat({ errors: 0, llmErrors: 0, shed: 0, tokensIn: 0, tokensOut: 0 }))).toMatchObject({ tone: null, end: 'no tokens recorded' });
  });

  it('sorts failed first, then the checks that acted most, then by volume; the sentence names the skipper', () => {
    const c = buildChecks(metrics([feat({ feature: 'CoherenceReviewer', errors: 0, llmErrors: 0, shed: 60, calls: 100, realCalls: 40, fired: 10 }), feat({ feature: 'TopicIntentExtractor', errors: 0, llmErrors: 0, shed: 0, calls: 900, realCalls: 900, fired: 200 }), feat({ feature: 'PromptGate', errors: 0, llmErrors: 0, shed: 0, calls: 950, realCalls: 950, fired: 10 }), feat()], { realCalls: 2300, errors: 2, shed: 150 }), OFF, NOW);
    expect(c.state).toBe('ok');
    expect(c.rows.map((r) => r.feature)).toEqual(['MessagingToneGate', 'TopicIntentExtractor', 'PromptGate', 'CoherenceReviewer']);
    expect(c.rows[0].errors).toBe(2);                 // failed first
    expect(c.rows[1].fired).toBeGreaterThan(c.rows[2].fired); // then most acted
    expect(c.sentence).toBe('2,300 background checks; 2 failed; the coherence review check skipped 60% to save limits.');
    expect(c.note).toContain('Cost per check isn’t recorded yet');
    expect(c.usedLately.map((m) => [m.model, m.pct])).toEqual([['GPT-6 Luna', 93], ['Claude Opus 5.5', 7]]);
    expect(c.insight.state).toBe('absent');
  });

  it('empty, off and failed each say so', () => {
    expect(buildChecks(metrics([], { realCalls: 0, shed: 0, errors: 0 }), OFF, NOW).sentence).toBe('No background checks ran in this window.');
    expect(buildChecks(OFF, OFF, NOW)).toMatchObject({ state: 'off', reason: 'Background checks aren’t tracked on this agent.' });
    expect(buildChecks(FAIL, OFF, NOW).reason).toContain('the server answered 500');
    expect(buildChecks(ok({ totals: {} }), OFF, NOW).state).toBe('failed');
  });

  it('the Insights line: absent on 503/404/failure, paused when paused, stamped when real', () => {
    expect(insightLine(OFF).state).toBe('absent');
    expect(insightLine({ ok: false, reason: 'the server answered 404' }).state).toBe('absent');
    expect(insightLine(ok({ source: 'paused', headline: 'x' })).state).toBe('paused');
    const l = insightLine(ok({ headline: 'The tone check did most of the work.', source: 'llm', asOf: new Date(hoursAgo(2)).toISOString(), stale: false, lines: [{ text: 'a' }] }), NOW);
    expect(l).toMatchObject({ state: 'ok', text: 'The tone check did most of the work.', stamp: 'written by AI · 2 h ago', lines: ['a'] });
    expect(insightLine(ok({ headline: 'h', source: 'deterministic', asOf: new Date(hoursAgo(50)).toISOString(), stale: true }), NOW).stamp).toBe('summary · 2 d ago · may be out of date');
  });
});

describe('your conversations — Claude and Codex are kept apart', () => {
  it('two lines measuring different things, counts from the summary fields, and no combined total anywhere', () => {
    const c = buildConversations(tokens(), 'this week', { claude: full().claude, codex: full().codex, orphans: full().orphans, names: { s1: 'Console plan' } }, NOW);
    expect(c.state).toBe('ok');
    expect(c.claude.line).toBe('Claude: 11 conversations processed 8.2M tokens this week.');
    expect(c.codex.line).toBe('Codex: 3 conversations active this week have used 900k tokens over their whole life.');
    expect(c.claude.count).toBe(11);   // summary.sessionsActive, not the list length (1)
    expect(c.codex.count).toBe(3);     // codex.sessionCount, not the list length (1)
    expect(c.claude.rows[0]).toMatchObject({ main: 'Console plan', end: '2.3M tokens' });
    expect(c.codex.rows[0].sub).toBe('lifetime total · GPT-6 Astra');
    expect(c.codex.rows[0].main).toBe('In proj, last active 2 h ago'); // unnamed: project + age, never a repeated placeholder
    expect(c.claude.rows[0].sub).toBe('echo · last active 1 h ago');   // named: the project and age move to the sub-line
    expect(c.note).toContain('not added together');
    const json = JSON.stringify(c);
    expect(json).not.toContain(String(8200000 + 900000));
    expect(json).not.toContain('9.1M');
    expect(c.newestEvent).toBe('newest event 1 h ago');
    expect(c.idle).toMatchObject({ count: 0 });
  });

  it('singular grammar, a missing Codex block, a failed list and failed orphans degrade per part', () => {
    const one = buildConversations(tokens({ summary: { totalTokens: 500, sessionsActive: 1, newestEventTs: null }, codex: { totalTokens: 10, sessionCount: 1 } }), 'today', { claude: FAIL, codex: OFF, orphans: FAIL }, NOW);
    expect(one.claude.line).toBe('Claude: 1 conversation processed 500 tokens today.');
    expect(one.codex.line).toBe('Codex: 1 conversation active today has used 10 tokens over its whole life.');
    expect(one.claude.listReason).toContain('the server answered 500');
    expect(one.codex.listReason).toContain('switched off');
    expect(one.idle).toMatchObject({ count: null });
    expect(one.idle.reason).toContain('Couldn’t count idle');
    expect(one.newestEvent).toBeNull();
    expect(buildConversations(tokens({ codex: undefined }), 'today', {}, NOW).codex).toBeNull();
    expect(buildConversations(OFF, 'today', {}, NOW)).toMatchObject({ state: 'off', reason: 'Conversation token use isn’t tracked here.' });
    expect(buildConversations(FAIL, 'today', {}, NOW).state).toBe('failed');
    expect(buildConversations(ok({ codex: {} }), 'today', {}, NOW).state).toBe('failed');
    expect(claudeRow({ sessionId: 'z', projectPath: null, totalTokens: 5, lastTs: hoursAgo(1) }, {}, NOW).main).toBe('Last active 1 h ago');
    expect(claudeRow({ sessionId: 'z', projectPath: null, totalTokens: 5 }, {}, NOW).main).toBe('A conversation');
    expect(claudeRow({ sessionId: 'z', projectPath: '/x/echo', totalTokens: 5, lastTs: hoursAgo(2) }, {}, NOW)).toMatchObject({ main: 'In echo, last active 2 h ago', sub: '' });
    const cx = codexRow({ sessionId: 'z', projectPath: '/a/b', model: 'gpt-6-astra', totalTokens: 5, lastTs: hoursAgo(3) }, {}, NOW);
    expect(cx).toMatchObject({ main: 'In b, last active 3 h ago', sub: 'lifetime total · GPT-6 Astra' });
    expect(codexRow({ sessionId: 'z', projectPath: '/a/b', model: null, totalTokens: 5, lastTs: hoursAgo(3) }, { z: 'Astra review' }, NOW)).toMatchObject({ main: 'Astra review', sub: 'lifetime total · last active 3 h ago' });
  });
});

describe('which model does what', () => {
  it('four plain lanes, pay-per-use tagged, a sentence from the quick and judging lanes', () => {
    const r = buildRouting(chains);
    expect(r.state).toBe('ok');
    expect(r.lanes.map((l) => [l.label, l.text])).toEqual([['Quick checks', 'GPT-6 Luna → Qwen 3 (pay-per-use) → Claude Haiku 4.5'], ['Judging', 'Claude Opus 5.5']]);
    expect(r.lanes[0].positions[1]).toMatchObject({ paid: true, notYet: true });
    expect(r.sentence).toBe('Quick checks run on GPT-6 Luna; judging runs on Claude Opus 5.5; Claude Haiku 4.5 is the last fallback.');
    expect(r.jobs).toEqual([{ component: 'Message tone check', lane: 'Judging', framework: 'Codex' }]);
    expect(buildRouting(OFF)).toMatchObject({ state: 'off', reason: 'No AI routing is configured on this agent.' });
    expect(buildRouting(FAIL).state).toBe('failed');
    expect(buildRouting(ok({ nope: 1 })).state).toBe('failed');
  });
});

describe('the whole page', () => {
  it('headline from the ledger with the window phrase; facts; the limits sentence apart', () => {
    const p = buildCostsPage(full(), NOW, { window: 'week' });
    expect(p.headline).toBe('About $4.20 of pay-per-use cost this week on this machine.');
    expect(p.sub).toBe('Estimated from token counts and a price list, all on OpenRouter. Spending limits are off (held by Mac Studio), and no paid route is open. Figures are this machine’s own ledger.');
    expect(p.headline).not.toMatch(/estimated|unpriced|provider-reported|recorded/i); // the labels live in the sub-line
    expect(p.facts.map((f) => [String(f.n), f.label])).toEqual([['$4.20', 'recorded cost · estimated'], ['410', 'background checks · 2 failed'], ['off', 'limits']]);
    expect(p.tone).toBe('attn');
    expect(p.window.key).toBe('week');
  });

  it('unpriced tokens reach the headline and a fact; a quiet page is ok', () => {
    const p = buildCostsPage(full({ spend: spend([spendRow({ costBasis: 'unpriced', netUsd: 0, unpricedTokensIn: 30000, unpricedTokensOut: 11000 })], { netUsd: 0, unpricedTokensIn: 30000, unpricedTokensOut: 11000 }), metrics: metrics([feat({ errors: 0, llmErrors: 0 })], { errors: 0 }) }), NOW, { window: 'today' });
    expect(p.headline).toBe('No pay-per-use cost today on this machine.');
    expect(p.sub).toContain('41k tokens went through with no price on file for their route, so they are counted but not priced.');
    expect(p.facts[1]).toMatchObject({ n: '41k', label: 'tokens unpriced', tone: 'unknown' });
    expect(p.tone).toBe('ok');
    const subs = buildCostsPage(full({ spend: spend([spendRow({ door: 'claude-code', doorClass: 'cli', costBasis: 'subscription-zero', netUsd: 0, grossUsd: 0, tokensIn: 300000000, tokensOut: 34000000 })], { netUsd: 0, grossUsd: 0 }) }), NOW, { window: 'week' });
    expect(subs.headline).toBe('No pay-per-use cost this week on this machine.');
    expect(subs.sub).toContain('334M tokens ran on subscriptions, which are not billed per token.');
    expect(subs.sub).not.toContain('no price on file');
  });

  it('503 on the spend view is said once, separately from the limits switch; the other sections still render', () => {
    const p = buildCostsPage(full({ spend: OFF, caps: OFF }), NOW);
    expect(p.headline).toBe('Spend figures aren’t available on this agent.');
    expect(p.sub).toContain('Turning limits on does not change that');
    expect(p.sub).toContain('Spending limits are off (held by Mac Studio).');
    expect(p.facts[0]).toMatchObject({ n: 'off', label: 'recorded cost', tone: 'unknown' });
    expect(p.recorded.state).toBe('off');
    expect(p.limits.caps.state).toBe('off');
    expect(p.checks.state).toBe('ok');
    expect(p.conversations.state).toBe('ok');
    expect(p.tone).toBe('attn'); // the checks still carry 2 failures
  });

  it('a failed read is Can’t tell with its reason, never a zero', () => {
    const p = buildCostsPage(full({ spend: FAIL, metrics: FAIL, status: FAIL, tokens: FAIL, chains: FAIL }), NOW);
    expect(p.headline).toBe('Can’t tell what AI use cost on this machine.');
    expect(p.facts.map((f) => String(f.n))).toEqual(['Can’t tell', 'Can’t tell', 'Can’t tell']);
    expect(p.sub).toContain('the server answered 500');
    expect(p.checks.reason).toContain('the server answered 500');
    expect(p.conversations.reason).toContain('the server answered 500');
    expect(p.routing.reason).toContain('the server answered 500');
    expect(JSON.stringify(p.facts)).not.toMatch(/"n":"?0"?/);
  });
});

describe('navigation', () => {
  it('the four legacy tabs open the costs page; the page appears once as What thinking costs, the others say they live inside it', () => {
    for (const id of ['spend', 'tokens', 'llm-activity', 'routing-map']) expect(tabHref(id)).toBe('#/capacity/costs');
    expect(NATIVE_PAGES.spend).toBe('#/capacity/costs');
    const cap = GROUPS.find((g) => g.id === 'capacity')!;
    expect(cap.tabs.filter((t) => t.label === 'What thinking costs')).toHaveLength(1);
    const inside = [cap.tabs.find((t) => t.id === 'tokens')!, ...GROUPS.find((g) => g.id === 'settings')!.hood!.filter((t) => t.id === 'routing-map' || t.id === 'llm-activity')];
    for (const t of inside) expect(t.desc).toMatch(/^Now inside What thinking costs/);
  });
});

describe('costs page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('boots the shipped console, keeps the Claude and Codex lines separate, shows committed limits apart, caps lists at 5, and opens the routing sheet', async () => {
    // Seven Claude conversations, seven Codex ones and seven checks: each list shows 5 and offers the rest.
    const claudeSessions = [{ sessionId: 's1', projectPath: '/Users/x/.instar/agents/echo', totalTokens: 2300000, eventCount: 10, firstTs: hoursAgo(5), lastTs: hoursAgo(1) },
      ...Array.from({ length: 6 }, (_, i) => ({ sessionId: `u${i}`, projectPath: '/Users/x/.instar/agents/echo', totalTokens: 1000000 - i, eventCount: 3, firstTs: hoursAgo(9), lastTs: hoursAgo(2 + i) }))];
    const codexSessions = Array.from({ length: 7 }, (_, i) => ({ sessionId: `c${i}`, projectPath: '/Users/x/proj', model: 'gpt-6-astra', totalTokens: 600000 - i, firstTs: hoursAgo(400), lastTs: hoursAgo(2 + i) }));
    const feats = [feat(), ...Array.from({ length: 6 }, (_, i) => feat({ feature: `Check${i}`, errors: 0, llmErrors: 0, fired: 30 - i }))];
    const f = full({ claude: ok({ sessions: claudeSessions }), codex: ok({ sessions: codexSessions }), metrics: metrics(feats) });
    const got: string[] = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/capacity/costs' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const table: Record<string, unknown> = {
      '/sessions': { sessions: [{ id: 'x', name: 'Console plan', claudeSessionId: 's1', status: 'running' }] },
      '/health': { project: { name: 'echo' } },
      '/routing-spend/caps': (f.caps as { data: unknown }).data,
      '/routing-spend/enable-status': (f.status as { data: unknown }).data,
      '/insights/llm-activity': { headline: 'The tone check did most of the work.', source: 'llm', asOf: new Date().toISOString(), stale: false, lines: [] },
      '/tokens/orphans?idleMs=1800000': { idleMs: 1800000, orphans: [] },
      '/intelligence/routing/chains': (f.chains as { data: unknown }).data,
    };
    g.fetch = async (url: string) => {
      got.push(url);
      let body = table[url];
      if (url.startsWith('/routing-spend/summary')) body = (f.spend as { data: unknown }).data;
      if (url.startsWith('/metrics/features')) body = (f.metrics as { data: unknown }).data;
      if (url.startsWith('/tokens/summary')) body = (f.tokens as { data: unknown }).data;
      if (url.startsWith('/tokens/sessions')) body = (f.claude as { data: unknown }).data;
      if (url.startsWith('/tokens/codex-sessions')) body = (f.codex as { data: unknown }).data;
      return body === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('About $4.20 of pay-per-use cost this week on this machine.');
    // One time control, directly under the headline and before the facts; the window it selected drove every read (7 days = 168 h).
    const control = doc.querySelector('.page-hero .time-control')!;
    expect(control.previousElementSibling!.tagName).toBe('P');
    expect(control.nextElementSibling!.classList.contains('facts')).toBe(true);
    expect([...control.querySelectorAll('.fchip')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Today', 'false'], ['7 days', 'true'], ['30 days', 'false']]);
    expect(got).toContain('/metrics/features?sinceHours=168');
    expect(got.some((u) => /^\/routing-spend\/summary\?grain=day&sinceHours=168$/.test(u))).toBe(true);
    expect(got.some((u) => /^\/tokens\/sessions\?since=\d+&limit=20$/.test(u))).toBe(true);
    expect(got.some((u) => /^\/tokens\/codex-sessions\?since=\d+&limit=20$/.test(u))).toBe(true);
    // Two separate usage lines, never one total.
    const lines = [...doc.querySelectorAll('.conv-line')].map((p) => p.textContent);
    expect(lines).toEqual(['Claude: 11 conversations processed 8.2M tokens this week.', 'Codex: 3 conversations active this week have used 900k tokens over their whole life.']);
    expect(doc.querySelector('#sec-conversations')!.textContent).not.toContain('9.1M');
    expect(doc.querySelector('#sec-claude-rows .row-title')!.textContent).toBe('Console plan');
    // Lists are capped at 5 with Show more; unnamed rows say where and when, not "A conversation in echo" seven times.
    expect(doc.querySelectorAll('#sec-claude-rows button.row')).toHaveLength(5);
    expect(doc.querySelector('#sec-claude-rows .show-more')!.textContent).toBe('Show 2 more');
    expect(doc.querySelectorAll('#sec-codex-rows button.row')).toHaveLength(5);
    expect(doc.querySelectorAll('#sec-codex-rows .row-title')[0].textContent).toMatch(/^In proj, last active \d+ h ago$/); // the page renders against the real clock
    expect(doc.querySelector('#sec-conversations')!.textContent).not.toContain('A conversation in');
    expect(doc.querySelectorAll('#sec-checks .check-row')).toHaveLength(5);
    expect(doc.querySelector('#sec-checks .show-more')!.textContent).toBe('Show 2 more');
    (doc.querySelector('#sec-checks .show-more') as HTMLButtonElement).click();
    expect(doc.querySelectorAll('#sec-checks .check-row')).toHaveLength(7);
    expect((doc.querySelector('#sec-checks .show-more') as HTMLButtonElement).hidden).toBe(true);
    // Reporting rows and committed limits are different sections.
    expect(doc.querySelector('#sec-recorded .row-end')!.textContent).toBe('$4.20›');
    expect(doc.querySelector('#sec-paid .row-sub')!.textContent).toBe('$0 of $25.00 today · $0 of $60.00 total (committed)');
    expect(doc.querySelector('#sec-paid .row-end')!.textContent).toBe('Not open›');
    // Checks: a bar and numbers, the Insights line, and no dollars.
    expect(doc.querySelector('#sec-checks .check-row .row-title')!.textContent).toBe('Message tone check');
    expect(doc.querySelectorAll('#sec-checks .check-row')[0].querySelectorAll('.check-bar span')).toHaveLength(5);
    expect(doc.querySelector('#sec-checks .insight-line')!.textContent).toContain('written by AI');
    expect(doc.querySelector('#sec-checks')!.textContent).not.toContain('$');
    // Spending controls are collapsed and read-only, pointing at the legacy tab.
    expect(doc.querySelector('#sec-controls .controls-body')!.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelector('#sec-controls a')!.getAttribute('href')).toBe('/dashboard?tab=spend');
    expect(doc.querySelectorAll('#sec-controls button').length).toBe(1); // only the fold, no Freeze/arm buttons
    // The routing sheet opens from the header link.
    (doc.querySelector('.head-link') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(doc.querySelector('.sheet-title')!.textContent).toBe('Which model does what');
    expect([...doc.querySelectorAll('.lane-name')].map((n) => n.textContent)).toEqual(['Quick checks', 'Judging']);
    expect(doc.querySelector('.lane-tag')!.textContent).toBe('pay-per-use · not open');
    // Pressing Today refetches with the 24 h window.
    (doc.querySelector('.sheet-close') as HTMLButtonElement).click();
    ([...doc.querySelectorAll('.page-hero .time-control .fchip')].find((b) => b.textContent === 'Today') as HTMLButtonElement).click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));
    expect(got).toContain('/metrics/features?sinceHours=24');
    expect(doc.querySelector('.page-title')!.textContent).toContain('today');
  });
});
