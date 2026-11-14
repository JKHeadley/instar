/**
 * Console Settings → Context (docs/specs/context-budget-layered-summaries.md §11, Phase 1 S14):
 * every decision in context-model.js on both sides — switched off / not on this version /
 * failed / ok per read, empty vs populated, the compression-recovery check in each of its
 * states, a stuck refresh before and after the watcher's own settling time, an unreadable
 * refresh record, a 200 of the wrong shape — plus the Home count source and the shipped page
 * in jsdom (plain copy: no routing ids, route paths or config keys on screen).
 */
// @ts-nocheck — the modules are browser-native ESM (.js), no types.
import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildContextPage, contextNeeds, canaryLine, readState, trialLines, topicRow, fmtBytes, STUCK_AFTER_MS,
} from '../../dashboard/console/context-model.js';
import { NEED_SOURCES, surfacedNeeds } from '../../dashboard/console/needs-model.js';
import { combineNeeds } from '../../dashboard/console/home-model.js';
import { GROUPS, NATIVE_PAGES, PHONE_PAGE_ALIASES, CONSOLE_ONLY_TABS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-11-10T20:00:00Z');
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const OFF = { ok: false, status: 503, reason: 'switched off on this agent' };
const ABSENT = { ok: false, reason: 'the server answered 404' };
const FAIL = { ok: false, reason: 'the server answered 500' };
const TOPIC = 141133;
const NAMES = { [String(TOPIC)]: 'Build desk' };

const group = (over: Record<string, unknown> = {}) => ({ machine: 'm_abc', engine: 'claude-code', version: '2.1.321', state: 'healthy', detected: 4, complete: 4, pending: 0, synthetic: 1, ...over });
const sentinel = (over: Record<string, unknown> = {}) => ({
  lastTickAt: NOW - 3 * 60000, heartbeatFresh: true, quarantined: [], torn: [], checkpointsPruned: 0, lastError: null,
  canary: { epochStartedAt: NOW - 86400000, switchOn: true, groups: [group()], recent: [], ledgerResetAt: null, unreadableTranscripts: 0 },
  adapterSuite: { running: false, results: [], attempts: {}, gaveUp: [], engineVersion: '2.1.321', lastRun: null },
  layerFreshness: { state: 'ok', checkedAt: NOW - 60000, counts: { topics: 1, fresh: 1, stale: 0, unknown: 0, observedOnly: 0, rebuildRequests: 0, notices: 0 }, topics: [{ topicKey: String(TOPIC), owned: true, h1: { stale: false, line: 'x', userTurnsBehind: 0 }, h3: { state: 'unavailable', reason: 'h3-not-built' }, staleSince: null, rebuildRequests: 0, lastRebuild: null, notified: false }], truncated: 0 },
  holdHealth: { state: 'ok', checkedAt: NOW - 60000, graceMs: 900000, counts: { carriers: 0, live: 0, orphans: 0, cleared: 0, pending: 0, inGrace: 0, observedOnly: 0, unknown: 0, clearedTotal: 2 }, orphans: [], recentClears: [], truncated: 0 },
  eligibleWithoutFold: { state: 'ok', checkedAt: NOW - 60000, counts: { topics: 1, unknown: 1, foldedRecently: 0 }, topics: [], truncated: 0 },
  ...over,
});
const layers = (over: Record<string, unknown> = {}) => ({ enabled: true, layersRoot: { path: '/x/state/context-layers', mode: '0700' }, archiveRoot: { path: '/x/a', mode: '0700' }, topics: 1, layerBytes: 12_800, archiveBytes: 3_400_000, replication: {}, budget: {}, ticker: null, ...over });
const cost = (requests = 40) => ({ requests, uncached: 1, cacheRead: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteSplitUnknown: 0, output: 1, inputWeighted: 1_000_000, allInWeighted: 1_800_000, perRequest: { inputWeighted: 25_000, allInWeighted: 45_000, cacheRead: 1, output: 1 } });
const topic = (over: Record<string, unknown> = {}) => ({
  topicId: TOPIC, sessions: ['s1'], sessionsInWindow: 1, cost: { ...cost(), sessions: 1 },
  rework: { status: 'ok', toolInputs: 50, repeats: 2, rate: 0.04, windowTurns: 30, sessionsCounted: 1, partial: false },
  extractor: { unavailable: 'no-capture-telemetry' }, layerUpdate: { inputTokens24h: 0, deferred: 0, perTopicCeiling: 400000, inMemorySinceBoot: true },
  u: { messages: 312, forwarded: 0, chars: 160_000, estimatedTokens: 40_000 },
  operatorVerbatimShare: { sessionId: 's1', ledgerFreshness: 'current', channel: 'telegram', delivered: 20, verbatimInContext: 17, share: 0.85, compactions: 1, lastCompactionAt: NOW - 3600000 },
  archiveBytes: 3_400_000, layerBytes: 12_800, liveSetBudgetInputs: {}, ...over,
});
const metrics = (over: Record<string, unknown> = {}) => ({
  generatedAt: NOW, window: { sinceHours: 24, sinceMs: NOW - 86400000 }, weights: {}, turnUnit: 'one API request',
  ledger: { available: true }, overall: { ...cost(120), sessions: 3 }, sessions: [], topics: [topic()], topicsTruncated: false,
  extractorByDay: [{ day: '2026-11-10', turn: { attempts: 3, calls: 3, updated: 3, deferred: 0, errors: 0, measuredCalls: 3, tokensIn: 9000, tokensOut: 500, tokensCached: 0 }, tick: { attempts: 1, calls: 1, updated: 1, deferred: 0, errors: 0, measuredCalls: 1, tokensIn: 3000, tokensOut: 100, tokensCached: 0 } }],
  layerUpdate: { reserve: {}, componentInputTokens24h: 480_000, componentShare: 0.12, deferred: {}, inMemorySinceBoot: true }, anchors: { unavailable: 'anchor-ledger-not-built' }, ...over,
});
const delta = (over: Record<string, unknown> = {}) => ({ prompts: 200, seededPrompts: 180, firstPromptsAfterSeed: { count: 3, briefingWouldRepeat: 3 }, suppressed: 0, foldNotSuppressed: 0, returnedDelta: 0,
  fullChars: { median: 8000, p95: 9000, total: 1 }, deltaChars: { median: 2000, p95: 4000, total: 1 }, omittedItems: 0, refetched: { status: 'nothing-omitted', count: 0 }, reductionRefusals: {}, reworkBaseline: { status: 'unknown', reason: 'x' }, log: {}, reduction: { switchOn: false, allowed: false, reason: 'switch-off' }, ...over });
const allOn = (over: Record<string, unknown> = {}) => ({ layers: ok(layers()), metrics: ok(metrics()), sentinel: ok(sentinel()), delta: ok(delta()), ...over });

describe('reading each answer', () => {
  it('503 is off, 404 is not on this version, a 500 is failed, a 200 is ok', () => {
    expect(readState(OFF)).toBe('off');
    expect(readState(ABSENT)).toBe('absent');
    expect(readState({ ok: false, status: 404 })).toBe('absent');
    expect(readState(FAIL)).toBe('failed');
    expect(readState(undefined)).toBe('failed');
    expect(readState(ok({}))).toBe('ok');
  });
  it('formats bytes plainly', () => {
    expect(fmtBytes(900)).toBe('900 bytes');
    expect(fmtBytes(12_800)).toBe('13 KB');
    expect(fmtBytes(3_400_000)).toBe('3.2 MB');
    expect(fmtBytes(null)).toBeNull();
  });
});

describe('the page: off, failed, empty, healthy', () => {
  it('everything off (or not on this version): one plain sentence, no sections, no error', () => {
    const p = buildContextPage({ layers: OFF, metrics: OFF, sentinel: OFF, delta: ABSENT }, NOW);
    expect(p).toMatchObject({ ok: true, off: true, needs: [], tone: 'muted' });
    expect(p.headline).toBe('Conversation summaries are switched off on this machine.');
  });
  it('one read failing is not "off": the page renders, says what it could not read, and is partial', () => {
    const p = buildContextPage({ layers: OFF, metrics: FAIL, sentinel: OFF, delta: OFF }, NOW);
    expect(p.off).toBe(false);
    expect(p.partial).toBe(true);
    expect(p.tone).toBe('unknown');
    expect(p.conversationsNote).toMatch(/Couldn’t read the conversations/);
    expect(p.cost.lines[0]).toMatch(/Couldn’t read what it costs/);
  });
  it('on with nothing yet: zero conversations, no needs, ok', () => {
    const p = buildContextPage(allOn({ layers: ok(layers({ topics: 0, layerBytes: 0, archiveBytes: 0 })), metrics: ok(metrics({ topics: [], overall: { ...cost(0), sessions: 0 }, extractorByDay: [] })) }), NOW);
    expect(p.conversations).toEqual([]);
    expect(p.needs).toEqual([]);
    expect(p.tone).toBe('ok');
    expect(p.headline).toBe('Running summaries are on for 0 conversations on this machine.');
    expect(p.cost.lines[0]).toBe('No turns recorded in the last day.');
  });
  it('healthy: a named conversation row with its plain facts, recovery working, no needs', () => {
    const p = buildContextPage(allOn(), NOW, NAMES);
    expect(p.needs).toEqual([]);
    expect(p.tone).toBe('ok');
    expect(p.headline).toBe('Running summaries are on for 1 conversation on this machine.');
    expect(p.conversations).toHaveLength(1);
    expect(p.conversations[0].main).toBe('Build desk');
    expect(p.conversations[0].sub).toContain('summary up to date');
    expect(p.conversations[0].sub).toContain('about 45k tokens a turn');
    expect(p.conversations[0].sub).toContain('85% of your messages still word for word');
    expect(p.conversations[0].detail.find((l) => l.label === 'Stored here').text).toBe('summary 13 KB; saved transcript 3.2 MB');
    expect(p.recovery.lines[0]).toMatchObject({ tone: 'ok' });
    expect(p.recovery.lines[0].text).toMatch(/recovery works/);
    expect(p.cost.lines.join(' ')).toMatch(/12% of its daily allowance/);
    expect(p.trial.lines.join(' ')).toMatch(/about 75% smaller/);
    expect(p.trial.lines.join(' ')).toMatch(/Measuring only/);
    expect(p.upkeep.lines.join(' ')).toMatch(/last checked 3 min ago/);
  });
  it('a conversation with no known name never shows its routing id', () => {
    const p = buildContextPage(allOn(), NOW, {});
    expect(p.conversations[0].main).toBe('Conversation name unavailable');
    const shown = JSON.stringify([p.headline, p.sub, p.facts, p.conversations.map((r) => [r.main, r.sub, r.detail]), p.recovery, p.cost, p.trial, p.upkeep]);
    expect(shown).not.toContain(String(TOPIC));
  });
  it('a stale summary reads behind, an unknown one "can’t tell", and a missing freshness row says nothing about freshness', () => {
    const fresh = (h1: unknown) => ({ topicKey: String(TOPIC), h1 });
    expect(topicRow(topic(), fresh({ stale: true, userTurnsBehind: 3 }), NAMES).sub).toContain('summary behind by 3 of your messages');
    expect(topicRow(topic(), fresh({ stale: 'unknown', userTurnsBehind: null }), NAMES).sub).toContain('can’t tell if the summary is current');
    expect(topicRow(topic(), undefined, NAMES).sub).not.toMatch(/summary (up to date|behind)/);
  });
  it('a cost the ledger cannot measure is left out, never shown as zero', () => {
    const r = topicRow(topic({ cost: { unavailable: 'no-session-in-window' }, operatorVerbatimShare: { unavailable: 'x' } }), undefined, NAMES);
    expect(r.sub).not.toMatch(/tokens a turn|word for word/);
    expect(r.detail.find((l) => l.label === 'Cost').text).toBe('no session of it ran here in this window');
  });
  it('repeated work still being counted says so', () => {
    const r = topicRow(topic({ rework: { status: 'pending', rate: null, toolInputs: 1, repeats: 0 } }), undefined, NAMES);
    expect(r.detail.find((l) => l.label === 'Repeated work').text).toMatch(/still counting/);
  });
  it('the watcher off with summaries on: the recovery and watcher sections say so plainly', () => {
    const p = buildContextPage(allOn({ sentinel: OFF }), NOW, NAMES);
    expect(p.off).toBe(false);
    expect(p.needs).toEqual([]);
    expect(p.recovery.lines[0].text).toBe('The watcher that checks recovery is switched off on this machine.');
    expect(p.upkeep.lines[0]).toMatch(/switched off on this machine/);
  });
  it('a watcher that has not checked in recently says what that means', () => {
    const p = buildContextPage(allOn({ sentinel: ok(sentinel({ heartbeatFresh: false, lastTickAt: NOW - 40 * 60000 })) }), NOW);
    expect(p.upkeep.lines[0]).toMatch(/later than it should; no conversation is refreshed/);
  });
});

describe('compression recovery check, every state', () => {
  it.each([
    ['healthy', 'ok', /recovery works/],
    ['accruing', 'unknown', /not enough compressions yet/],
    ['diverged', 'attn', /came back without the context/],
    ['uninitialized', 'unknown', /no compression seen yet/],
    ['n/a', 'muted', /switched off here/],
    ['something-new', 'unknown', /can’t tell/],
  ])('%s', (state, tone, words) => {
    const l = canaryLine(group({ state, detected: 3, complete: 1, pending: 0 }));
    expect(l.tone).toBe(tone);
    expect(l.text).toMatch(words);
    expect(l.text).toMatch(/^Claude Code 2\.1\.321/);
  });
  it('diverged counts the failures', () => {
    expect(canaryLine(group({ state: 'diverged', detected: 5, complete: 2, pending: 1 })).text).toContain('2 compressions came back');
  });
  it('an unknown engine version is not shown as "unknown"', () => {
    expect(canaryLine(group({ version: 'unknown', state: 'uninitialized' })).text).toMatch(/^Claude Code: /);
  });
});

describe('what needs the operator', () => {
  it('nothing stuck, recovery healthy: no needs', () => {
    expect(contextNeeds(sentinel(), NAMES, NOW)).toEqual([]);
  });
  it('a refresh settling inside the watcher’s own wait is not a need; past it, it is', () => {
    const q = (ageMs: number) => sentinel({ quarantined: [{ topicKey: String(TOPIC), foldId: 'f1', ageMs, owned: true, lastOutcome: null }] });
    expect(contextNeeds(q(STUCK_AFTER_MS - 1000), NAMES, NOW)).toEqual([]);
    const n = contextNeeds(q(STUCK_AFTER_MS + 60000), NAMES, NOW);
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('A memory refresh is stuck in Build desk');
    expect(n[0].detail).toMatch(/messages to that conversation are held/i);
    // On the page, a settling refresh is mentioned in the watcher section, not counted.
    const p = buildContextPage(allOn({ sentinel: ok(q(60000)) }), NOW, NAMES);
    expect(p.needs).toEqual([]);
    expect(p.upkeep.lines.join(' ')).toMatch(/1 memory refresh settling now/);
  });
  it('an unreadable refresh record is a need', () => {
    const n = contextNeeds(sentinel({ torn: [{ topicKey: String(TOPIC), foldId: 'f2' }] }), NAMES, NOW);
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('A memory refresh record in Build desk cannot be read');
  });
  it('recovery that stopped working is a need; accruing or never-seen is not', () => {
    expect(contextNeeds(sentinel({ canary: { groups: [group({ state: 'accruing' }), group({ state: 'uninitialized', version: '2.1.300' })] } }), NAMES, NOW)).toEqual([]);
    const n = contextNeeds(sentinel({ canary: { groups: [group({ state: 'diverged' })] } }), NAMES, NOW);
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('Recovery after a long conversation is compressed is not working on this machine');
    expect(n[0].detail).toContain('Affected: Claude Code 2.1.321.');
  });
  it('two diverged versions on one machine are one row, naming both', () => {
    const n = contextNeeds(sentinel({ canary: { groups: [group({ state: 'diverged' }), group({ state: 'diverged', version: '2.1.300' }), group({ state: 'healthy', version: '2.1.200' })] } }), NAMES, NOW);
    expect(n).toHaveLength(1);
    expect(n[0].detail).toContain('Affected: Claude Code 2.1.321, Claude Code 2.1.300.');
  });
  it('a stuck refresh says it has not settled, unless the watcher gave up on stopping the old session', () => {
    const q = (lastOutcome: string | null) => contextNeeds(sentinel({ quarantined: [{ topicKey: String(TOPIC), foldId: 'f1', ageMs: STUCK_AFTER_MS + 60000, owned: true, lastOutcome }] }), NAMES, NOW)[0].detail;
    expect(q(null)).toContain('It has not settled within its time limit.');
    expect(q('attempted:x')).toContain('It has not settled within its time limit.');
    expect(q('exhausted:terminal')).toContain('I could not confirm the old session stopped');
  });
  it('each stuck or torn need carries its fold id as the ref', () => {
    const n = contextNeeds(sentinel({ quarantined: [{ topicKey: String(TOPIC), foldId: 'fk1abc12345678', ageMs: STUCK_AFTER_MS + 1, owned: true, lastOutcome: null }], torn: [{ topicKey: String(TOPIC), foldId: 'fk2abc12345678' }] }), NAMES, NOW);
    expect(n.map((x) => x.ref)).toEqual(['fk1abc12345678', 'fk2abc12345678']);
  });
  it('a 200 of the wrong shape is "can’t tell", never "nothing waiting"', () => {
    expect(contextNeeds({ nope: 1 }, NAMES, NOW)).toBeNull();
    expect(contextNeeds(null, NAMES, NOW)).toBeNull();
    const p = buildContextPage(allOn({ sentinel: ok({ nope: 1 }) }), NOW, NAMES);
    expect(p.needsUnreadable).toBe(true);
    expect(p.headline).toBe('Can’t tell whether anything is stuck.');
    expect(p.partial).toBe(true);
    expect(p.upkeep.lines[0]).toMatch(/form this page does not understand/);
    expect(p.recovery.lines[0].text).toMatch(/form this page does not understand/);
  });
  it('the page leads with the first need and counts it', () => {
    const p = buildContextPage(allOn({ sentinel: ok(sentinel({ canary: { groups: [group({ state: 'diverged' })] } })) }), NOW, NAMES);
    expect(p.tone).toBe('attn');
    expect(p.headline).toBe('Recovery after a long conversation is compressed is not working on this machine');
    expect(p.facts[0]).toMatchObject({ n: 1, tone: 'attn' });
  });
  it('a stale watcher heartbeat is "can’t tell" for Home; a fresh one, or one that has not ticked yet, is not', () => {
    expect(contextNeeds(sentinel({ heartbeatFresh: false }), NAMES, NOW)).toBeNull();
    expect(contextNeeds(sentinel({ heartbeatFresh: true }), NAMES, NOW)).toEqual([]);
    expect(contextNeeds(sentinel({ heartbeatFresh: false, lastTickAt: null }), NAMES, NOW)).toEqual([]);
  });
  it('page tone: fresh watcher ok; stale, never ticked, off or missing watcher with summaries on is unknown', () => {
    expect(buildContextPage(allOn(), NOW, NAMES).tone).toBe('ok');
    const stale = buildContextPage(allOn({ sentinel: ok(sentinel({ heartbeatFresh: false, lastTickAt: NOW - 40 * 60000 })) }), NOW, NAMES);
    expect(stale.tone).toBe('unknown');
    expect(stale.partial).toBe(true);
    expect(stale.headline).toBe('The watcher has stopped checking, so I can’t tell whether anything is stuck.');
    expect(buildContextPage(allOn({ sentinel: ok(sentinel({ heartbeatFresh: false, lastTickAt: null })) }), NOW, NAMES).tone).toBe('unknown');
    expect(buildContextPage(allOn({ sentinel: OFF }), NOW, NAMES).tone).toBe('unknown');
    expect(buildContextPage(allOn({ sentinel: ABSENT }), NOW, NAMES).tone).toBe('unknown');
  });
  it('a stale watcher’s last-known needs are still shown, marked as last known', () => {
    const p = buildContextPage(allOn({ sentinel: ok(sentinel({ heartbeatFresh: false, lastTickAt: NOW - 40 * 60000, torn: [{ topicKey: String(TOPIC), foldId: 'f2' }] })) }), NOW, NAMES);
    expect(p.needs).toHaveLength(1);
    expect(p.needsStale).toBe(true);
    expect(p.tone).toBe('attn');
    expect(p.lastCheck).toBe('40 min ago');
  });
  it('a quarantine with no readable age is neither counted as stuck nor called "settling"', () => {
    const p = buildContextPage(allOn({ sentinel: ok(sentinel({ quarantined: [{ topicKey: String(TOPIC), foldId: 'f1', ageMs: null, owned: true, lastOutcome: null }] })) }), NOW, NAMES);
    expect(p.needs).toEqual([]);
    expect(p.upkeep.lines.join(' ')).not.toMatch(/settling now/);
    expect(p.upkeep.lines.join(' ')).toMatch(/no readable start time/);
  });
  it('without a name the Home row still reads as a sentence', () => {
    const n = contextNeeds(sentinel({ torn: [{ topicKey: String(TOPIC), foldId: 'f2' }] }), {}, NOW);
    expect(n[0].title).toBe('A memory refresh record in a conversation cannot be read');
  });
});

describe('Home count source', () => {
  const src = NEED_SOURCES.find((s: any) => s.id === 'context');
  it('is registered, reads only the watcher, and links to the page', () => {
    expect(src).toBeTruthy();
    expect(src.page).toBe('settings/context');
    expect(Object.values(src.reads)).toEqual(['/context-budget/sentinel']);
  });
  it('off (503) adds nothing and is not failed', () => {
    expect(surfacedNeeds({ context: { results: { sentinel: OFF } } }, NOW)).toMatchObject({ rows: [], failed: [] });
  });
  it('a failed read is failed, not quiet', () => {
    expect(surfacedNeeds({ context: { results: { sentinel: FAIL } } }, NOW).failed).toContain('context');
  });
  it('a wrong-shape 200 is failed, not quiet', () => {
    expect(surfacedNeeds({ context: { results: { sentinel: ok({}) } } }, NOW).failed).toContain('context');
  });
  it('healthy adds nothing; a diverged check adds one row that opens the page', () => {
    expect(surfacedNeeds({ context: { results: { sentinel: ok(sentinel()) } } }, NOW).rows.filter((r: any) => r.key.startsWith('need:context:'))).toEqual([]);
    const rows = surfacedNeeds({ context: { results: { sentinel: ok(sentinel({ canary: { groups: [group({ state: 'diverged' })] } })) } } }, NOW).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tone: 'attn', action: { kind: 'href', href: '#/settings/context' } });
  });
});

describe('Home: one incident counts once (the fold id is the ref)', () => {
  const FOLD = 'fk3x9z2a1b2c3d4';
  const queue = (main: string) => ({ count: 1, rows: [{ key: 'q', main, tone: 'attn' }], all: [{ key: 'q', main, tone: 'attn' }], state: 'attn', line: 'x' });
  const noPromises = { state: 'ok', count: 0, all: [], rows: [] };
  const surfaced = () => surfacedNeeds({ context: { results: { sentinel: ok(sentinel({ torn: [{ topicKey: String(TOPIC), foldId: FOLD }] })) } } }, NOW);
  it('a queue row naming the fold drops the surfaced row', () => {
    const m = combineNeeds(queue(`A context fold record on topic ${TOPIC} "Build desk" (fold ${FOLD}) is unreadable`), noPromises, surfaced());
    expect(m.count).toBe(1);
  });
  it('a queue row about the same topic without the fold id does not', () => {
    const m = combineNeeds(queue(`Something else on topic ${TOPIC} "Build desk" needs a look`), noPromises, surfaced());
    expect(m.count).toBe(2);
  });
  it('the Home source is "can’t tell" (failed) when the watcher heartbeat is stale, and quiet when fresh', () => {
    expect(surfacedNeeds({ context: { results: { sentinel: ok(sentinel({ heartbeatFresh: false })) } } }, NOW).failed).toContain('context');
    expect(surfacedNeeds({ context: { results: { sentinel: ok(sentinel()) } } }, NOW).failed).not.toContain('context');
  });
});

describe('the trial, every branch', () => {
  it('on: "It is on", and omitted items "were" left out', () => {
    const t = trialLines(ok(delta({ omittedItems: 3, reduction: { switchOn: true, allowed: true, reason: 'canary-healthy' } })));
    expect(t.lines.join(' ')).toMatch(/It is on: sessions here get only what changed\./);
    expect(t.lines.join(' ')).toMatch(/3 items were left out/);
  });
  it('switched on but held back', () => {
    const t = trialLines(ok(delta({ omittedItems: 3, reduction: { switchOn: true, allowed: false, reason: 'canary-accruing' } })));
    expect(t.lines.join(' ')).toMatch(/Held back: sessions keep the full briefing/);
    expect(t.lines.join(' ')).toMatch(/3 items would have been left out/);
  });
  it('measuring only', () => {
    expect(trialLines(ok(delta())).lines.join(' ')).toMatch(/Measuring only/);
  });
  it('nothing measured yet', () => {
    expect(trialLines(ok(delta({ prompts: 0 }))).lines[0]).toBe('No messages measured yet.');
  });
  it('a delta no smaller than the full output never reads as a negative saving', () => {
    const line = trialLines(ok(delta({ deltaChars: { median: 9000 } }))).lines[0];
    expect(line).toContain('would be no smaller');
    expect(line).not.toMatch(/-\d+%/);
  });
  it('the trial read alone: off, not on this version, failed', () => {
    expect(trialLines(OFF)).toEqual({ state: 'off', lines: ['The trial is switched off on this machine.'] });
    expect(trialLines(ABSENT)).toEqual({ state: 'absent', lines: ['This version does not run the trial yet.'] });
    expect(trialLines(FAIL).lines[0]).toBe('Couldn’t read the trial: the server answered 500.');
  });
});

describe('wording nits', () => {
  it('a metrics or watcher read missing on this version is not called "switched off"', () => {
    const p = buildContextPage(allOn({ metrics: ABSENT, sentinel: ABSENT }), NOW, NAMES);
    expect(p.conversationsNote).toBe('This version of the agent does not report it yet.');
    expect(p.cost.lines[0]).toBe('This version of the agent does not report it yet.');
    expect(p.recovery.lines[0].text).toBe('This version of the agent does not report it yet.');
  });
  it('no recovery check wired reads as "not running", and a missing per-turn cost prints nothing', () => {
    const p = buildContextPage(allOn({ sentinel: ok(sentinel({ canary: null })), metrics: ok(metrics({ overall: { ...cost(5), perRequest: { allInWeighted: null }, sessions: 1 }, topics: [topic({ cost: { ...cost(), perRequest: { allInWeighted: null }, sessions: 1 } })] })) }), NOW, NAMES);
    expect(p.recovery.lines[0].text).toBe('The recovery check is not running on this machine.');
    expect(p.cost.lines[0]).toBe('5 turns across 1 session in the last 24 hours.');
    expect(p.conversations[0].detail.find((l) => l.label === 'Cost').text).not.toMatch(/0 a turn/);
  });
});

describe('navigation', () => {
  it('a Context tile under Settings opens the native page, also by its short phone name', () => {
    const settings = GROUPS.find((g) => g.id === 'settings');
    expect(settings.tabs.map((t) => t.id)).toContain('context');
    expect(CONSOLE_ONLY_TABS).toContain('context');
    expect(NATIVE_PAGES.context).toBe('#/settings/context');
    expect(PHONE_PAGE_ALIASES.context).toBe('settings/context');
  });
});

describe('the shipped page in jsdom', () => {
  async function render(reads: Record<string, unknown>) {
    const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', { url: 'http://localhost/dashboard/console/#/settings/context', pretendToBeVisual: true });
    const w: any = dom.window;
    for (const k of ['document', 'location', 'history', 'HTMLElement', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']) (globalThis as any)[k] = w[k];
    (globalThis as any).window = w;
    w.scrollTo = vi.fn();
    const { renderContext } = await import('../../dashboard/console/context.js');
    const main = w.document.getElementById('main');
    const get = vi.fn(async (p: string) => (p in reads ? reads[p] : FAIL));
    await renderContext(main, { get });
    return { main, get };
  }
  const R = (o: Record<string, unknown> = {}) => ({
    '/context-budget/layers': ok(layers()), '/context-budget/metrics': ok(metrics()), '/context-budget/sentinel': ok(sentinel()), '/context-budget/delta-shadow': ok(delta()),
    '/telegram/topics?scope=pool': ok({ topics: [{ topicId: TOPIC, topicName: 'Build desk' }] }), ...o,
  });
  it('reads exactly the four routes plus the topic names', async () => {
    const { get } = await render(R());
    expect(get.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['/context-budget/delta-shadow', '/context-budget/layers', '/context-budget/metrics', '/context-budget/sentinel', '/telegram/topics?scope=pool']);
  });
  it('healthy: every section, the named conversation, and no ids, routes or config keys on screen', async () => {
    const { main } = await render(R());
    const text = main.textContent;
    for (const h of ['Recovery after a compression', 'Conversations', 'What it costs', 'Trial: sending only what changed', 'The watcher']) expect(text).toContain(h);
    expect(text).toContain('Build desk');
    expect(text).toContain('A compression is when a long conversation is squeezed');
    expect(text).toContain('The watcher looks at every conversation');
    expect(text).not.toMatch(/\/context-budget|contextBudget|enableWith|141133|m_abc|topicKey|foldId|undefined|null|NaN|\[object/);
    expect(main.querySelector('[data-operator-need]')).toBeNull();
  });
  it('off: one sentence, no sections and no error', async () => {
    const { main } = await render(R({ '/context-budget/layers': OFF, '/context-budget/metrics': OFF, '/context-budget/sentinel': OFF, '/context-budget/delta-shadow': ABSENT }));
    expect(main.textContent).toContain('Conversation summaries are switched off on this machine.');
    expect(main.querySelector('.list-section')).toBeNull();
    expect(main.textContent).not.toMatch(/Can’t tell|server answered|error/i);
  });
  it('a need leads the page with a way to act on it', async () => {
    const { main } = await render(R({ '/context-budget/sentinel': ok(sentinel({ torn: [{ topicKey: String(TOPIC), foldId: 'f2' }] })) }));
    const need = main.querySelector('[data-operator-need="context"]');
    expect(need).not.toBeNull();
    expect(need.textContent).toContain('A memory refresh record in Build desk cannot be read');
    expect(need.querySelector('a[href^="#/work/sessions?ask="]')).not.toBeNull();
    const all = [...main.querySelectorAll('*')];
    expect(all.indexOf(need)).toBeLessThan(all.indexOf(main.querySelector('.list-section')));
  });
  it('a tapped conversation opens its detail', async () => {
    const { main } = await render(R());
    (main.querySelector('#sec-conversations button.row') as any).click();
    const s = (globalThis as any).document.querySelector('.sheet');
    expect(s.textContent).toContain('Running summary');
    expect(s.textContent).toContain('none of them is ever summarised away');
  });
});
